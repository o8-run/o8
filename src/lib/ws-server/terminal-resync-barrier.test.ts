import { describe, expect, it } from 'vitest';
import {
  TERMINAL_RESYNC_MAX_WAIT_MS,
  terminalResyncFreshnessLine,
  waitForTerminalResyncBarrier,
} from './terminal-resync-barrier';

function harness(options: {
  idleAt?: number;
  cancelAt?: number;
  captures?: Array<{ ok: boolean; data: string }>;
} = {}) {
  let now = 1_000;
  let captureCount = 0;
  const unsettledAt: number[] = [];
  const idleAt = options.idleAt ?? 0;
  const captures = options.captures ?? [{ ok: true, data: 'READY\n' }];
  return {
    run: () => waitForTerminalResyncBarrier({
      getLastOutputAt: () => now - (now - 1_000 >= idleAt ? 40 : 0),
      getBatchBuffer: () => now - 1_000 >= idleAt ? '' : 'pending',
      getScrollbackChunks: () => ['\x1b[32mREADY\x1b[0m\r\n'],
      capture: () => captures[Math.min(captureCount++, captures.length - 1)],
      isCancelled: () => options.cancelAt != null && now - 1_000 >= options.cancelAt,
      onUnsettled: (waitedMs) => unsettledAt.push(waitedMs),
      now: () => now,
      wait: async (delayMs) => { now += delayMs; },
    }),
    captureCount: () => captureCount,
    unsettledAt,
  };
}

describe('terminal resync barrier', () => {
  it('captures immediately when the attachment is already idle', async () => {
    const test = harness();

    await expect(test.run()).resolves.toMatchObject({
      status: 'ready', waitedMs: 0, unsettled: false, captureAttempts: 1, fallbackReason: null,
    });
    expect(test.captureCount()).toBe(1);
  });

  it('waits until the attachment becomes idle at 120 ms', async () => {
    const test = harness({ idleAt: 120 });

    await expect(test.run()).resolves.toMatchObject({
      status: 'ready', waitedMs: 120, unsettled: false,
    });
  });

  it('holds the idle wait for input-only activity without changing output time', async () => {
    let now = 1_000;
    const lastOutputAt = 900;
    const lastInputAt = 1_000;

    await expect(waitForTerminalResyncBarrier({
      getLastOutputAt: () => Math.max(lastOutputAt, lastInputAt),
      getBatchBuffer: () => '',
      getScrollbackChunks: () => ['READY\r\n'],
      capture: () => ({ ok: true, data: 'READY\n' }),
      isCancelled: () => false,
      now: () => now,
      wait: async (delayMs) => { now += delayMs; },
    })).resolves.toMatchObject({
      status: 'ready', waitedMs: 40, unsettled: false,
    });
    expect(lastOutputAt).toBe(900);
  });

  it('captures with an unsettled result after the 500 ms bound', async () => {
    const test = harness({ idleAt: Number.POSITIVE_INFINITY });

    await expect(test.run()).resolves.toMatchObject({
      status: 'ready', waitedMs: TERMINAL_RESYNC_MAX_WAIT_MS, unsettled: true,
    });
    expect(test.unsettledAt).toEqual([TERMINAL_RESYNC_MAX_WAIT_MS]);
  });

  it('cancels before capture when a newer visibility epoch arrives', async () => {
    const test = harness({ idleAt: 120, cancelAt: 60 });

    await expect(test.run()).resolves.toMatchObject({ status: 'cancelled', waitedMs: 60 });
    expect(test.captureCount()).toBe(0);
  });

  it('retries one stale snapshot and requests scrollback fallback', async () => {
    const test = harness({ captures: [
      { ok: true, data: 'older screen\n' },
      { ok: true, data: 'still older\n' },
    ] });

    await expect(test.run()).resolves.toMatchObject({
      status: 'ready', captureAttempts: 2, fallbackReason: 'stale-snapshot', freshnessLine: 'READY',
    });
    expect(test.captureCount()).toBe(2);
  });

  it('extracts the last plain-text line from ANSI scrollback', () => {
    expect(terminalResyncFreshnessLine(['old\r\n\x1b]0;title\x07\x1b[31m newest line \x1b[0m\r\n']))
      .toBe('newest line');
  });

  it('matches a colored prompt whose redraw resets the character set', async () => {
    // tmux redraws sgr0 as ESC ( B ESC [ m; tmux capture-pane -e keeps only SGR.
    const scrollback = '\x1b[32m\x1b[1muser@host\x1b(B\x1b[m:\x1b[34m\x1b[1m~\x1b(B\x1b[m$ ';
    expect(terminalResyncFreshnessLine([scrollback])).toBe('user@host:~$');
    await expect(waitForTerminalResyncBarrier({
      getLastOutputAt: () => 0,
      getBatchBuffer: () => '',
      getScrollbackChunks: () => [scrollback],
      capture: () => ({ ok: true, data: '\x1b[1m\x1b[32muser@host\x1b[0m:\x1b[1m\x1b[34m~\x1b[0m$\n' }),
      isCancelled: () => false,
      now: () => 1_000,
      wait: async () => {},
    })).resolves.toMatchObject({ captureAttempts: 1, fallbackReason: null });
  });

  it('strips cursor save, restore and keypad escapes from a prompt', () => {
    expect(terminalResyncFreshnessLine(['\x1b712:00\x1b8\x1b=user@host$ '])).toBe('12:00user@host$');
    expect(terminalResyncFreshnessLine(['echo (B) and ( 0 )\r\n'])).toBe('echo (B) and ( 0 )');
  });

  it('extracts the last cursor-addressed row without spanning painted rows', () => {
    expect(terminalResyncFreshnessLine([
      '\x1b[2J\x1b[H\x1b[1;1Hfirst painted row\x1b[2Hsecond painted row',
    ])).toBe('second painted row');
  });
});
