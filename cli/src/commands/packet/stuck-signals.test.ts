import { describe, expect, it } from 'vitest';

import {
  editedFiles, QUIET_IN_TOOL_MS, QUIET_MS, runsTests, STUCK_MARK, StuckWatch, stuckLine,
} from './stuck-signals';
import { followTranscript, type TranscriptEvent } from './transcript';

let seq = 0;
const ts = '2026-11-16T03:00:00.000Z';
const call = (tool: string, args: unknown, callId = `c${seq + 1}`): TranscriptEvent => ({
  seq: ++seq, ts, type: 'tool_call', callId, tool, args: typeof args === 'string' ? args : JSON.stringify(args), summary: '',
});
const result = (callId: string, ok: boolean, summary: string): TranscriptEvent => ({
  seq: ++seq, ts, type: 'tool_result', callId, tool: 'Bash', ok, summary,
});
/** A command and its result, as one pair. */
const ran = (command: string, ok: boolean, output: string): TranscriptEvent[] => {
  const id = `c${seq + 1}`;
  return [call('Bash', { command }, id), result(id, ok, output)];
};
const edit = (file: string): TranscriptEvent[] => {
  const id = `c${seq + 1}`;
  return [call('Edit', { file_path: `/repo/src/${file}`, old_string: 'a', new_string: 'b' }, id), result(id, true, 'ok')];
};

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('retry loop', () => {
  it('fires when the same command fails the same way three times, even with other work between', () => {
    const watch = new StuckWatch(clock().now);
    watch.observe(ran('npm install', false, 'npm ERR! 401 Unauthorized after 1.2s'));
    watch.observe(ran('ls', true, 'a b'));
    watch.observe(ran('npm install', false, 'npm ERR! 401 Unauthorized after 3.4s'));
    expect(watch.check()).toBeNull();
    watch.observe(ran('npm install', false, 'npm ERR! 401 Unauthorized after 0.9s'));
    expect(watch.check()).toEqual({ reason: 'retry_loop', detail: 'npm install' });
  });

  it('does not fire when the failure changes, and clears when the command passes', () => {
    const watch = new StuckWatch(clock().now);
    watch.observe(ran('make', false, 'error: missing a'));
    watch.observe(ran('make', false, 'error: missing b'));
    watch.observe(ran('make', false, 'error: missing c'));
    expect(watch.check()).toBeNull();
    watch.observe(ran('make', false, 'error: missing c'));
    watch.observe(ran('make', false, 'error: missing c'));
    expect(watch.check()?.reason).toBe('retry_loop');
    watch.observe(ran('make', true, 'built'));
    expect(watch.check()).toBeNull();
  });
});

describe('edit loop', () => {
  it('fires when one file keeps changing while the tests fail the same way', () => {
    const watch = new StuckWatch(clock().now);
    watch.observe(ran('npx vitest run a.test.ts', false, '1 failed: expected 2 to be 3 (12ms)'));
    for (let i = 0; i < 2; i += 1) {
      watch.observe([...edit('a.ts'), ...edit('a.ts')]);
      watch.observe(ran(`npx vitest run a.test.ts --reporter=${i ? 'dot' : 'verbose'}`, false, '1 failed: expected 2 to be 3 (15ms)'));
    }
    expect(watch.check()).toEqual({ reason: 'edit_loop', detail: '…/src/a.ts' });
  });

  it('does not fire while the test result keeps changing', () => {
    const watch = new StuckWatch(clock().now);
    for (const failure of ['cannot find a', 'cannot find b', 'cannot find c', 'expected x']) {
      watch.observe([...edit('a.ts'), ...edit('a.ts')]);
      watch.observe(ran('npm test', false, `1 failed: ${failure}`));
    }
    expect(watch.check()).toBeNull();
  });

  it('ignores numbers, so three runs that differ only in timings are flat', () => {
    const watch = new StuckWatch(clock().now);
    for (const ms of [12, 15, 19]) {
      watch.observe([...edit('a.ts'), ...edit('a.ts')]);
      watch.observe(ran('npm test', false, `1 failed: expected x (${ms}ms)`));
    }
    expect(watch.check()?.reason).toBe('edit_loop');
  });

  it('does not fire on many edits without flat test runs', () => {
    const watch = new StuckWatch(clock().now);
    for (let i = 0; i < 10; i += 1) watch.observe(edit('a.ts'));
    expect(watch.check()).toBeNull();
  });

  it('counts the files an apply_patch writes', () => {
    const patch = '*** Begin Patch\n*** Update File: /home/me/repo/src/lib/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+c\n*** End Patch';
    expect(editedFiles(call('apply_patch', { input: patch }) as Extract<TranscriptEvent, { type: 'tool_call' }>))
      .toEqual(['src/lib/a.ts', 'src/b.ts']);
  });

  it('knows a test command from other commands', () => {
    const asCall = (command: string) => call('Bash', { command }) as Extract<TranscriptEvent, { type: 'tool_call' }>;
    expect(runsTests(asCall('npm run test:unit -- a'))).toBe(true);
    expect(runsTests(asCall('go test ./pkg/...'))).toBe(true);
    expect(runsTests(asCall('python -m pytest -q'))).toBe(true);
    expect(runsTests(asCall('cat src/test.ts'))).toBe(false);
    expect(runsTests(asCall('git status'))).toBe(false);
  });
});

describe('quiet', () => {
  it('fires after a quiet stretch, and any event clears it', () => {
    const time = clock();
    const watch = new StuckWatch(time.now);
    watch.observe(ran('ls', true, 'a'));
    time.advance(QUIET_MS - 1);
    expect(watch.check()).toBeNull();
    time.advance(1);
    expect(watch.check()).toEqual({ reason: 'quiet', detail: null });
    watch.observe([{ seq: ++seq, ts, type: 'assistant', text: 'still here' }]);
    expect(watch.check()).toBeNull();
  });

  it('gives a command that is still running longer', () => {
    const time = clock();
    const watch = new StuckWatch(time.now);
    watch.observe([call('Bash', { command: 'npm run build' })]);
    time.advance(QUIET_MS * 2);
    expect(watch.check()).toBeNull();
    time.advance(QUIET_IN_TOOL_MS);
    expect(watch.check()?.reason).toBe('quiet');
  });

  it('starts over on touch, as when a held pane follows again', () => {
    const time = clock();
    const watch = new StuckWatch(time.now);
    time.advance(QUIET_MS * 3);
    watch.touch();
    expect(watch.check()).toBeNull();
  });
});

describe('progress resets', () => {
  it('a steer clears the counts', () => {
    const watch = new StuckWatch(clock().now);
    for (let i = 0; i < 3; i += 1) watch.observe(ran('npm install', false, 'ERR 401'));
    expect(watch.check()?.reason).toBe('retry_loop');
    watch.observe([{ seq: ++seq, ts, type: 'steer', source: 'operator', text: 'use the mirror' }]);
    expect(watch.check()).toBeNull();
  });
});

describe('what the pane says', () => {
  it('keeps commands and paths out of the tab mark', () => {
    for (const mark of Object.values(STUCK_MARK)) expect(mark).toMatch(/^Needs you: [a-z0-9, ]+$/);
  });

  it('names the command in the pane line', () => {
    expect(stuckLine({ reason: 'retry_loop', detail: 'npm install' }))
      .toBe('o8: the same command failed the same way 3 times: npm install. The worker may be stuck in a loop.');
  });
});

describe('a following pane', () => {
  it('flags a retry loop while the worker runs, and clears it when the command passes', async () => {
    const pages: TranscriptEvent[][] = [
      [...ran('npm install', false, 'ERR 401'), ...ran('npm install', false, 'ERR 401'), ...ran('npm install', false, 'ERR 401')],
      ran('npm install', true, 'added 12 packages'),
    ];
    const flags: Array<string | null> = [];
    const lines: string[] = [];
    let cursor = 0;
    const exit = await followTranscript({
      read: async () => {
        const events = pages.shift() ?? [];
        cursor += events.length;
        return { packetId: 'p', sessionKey: 's', events, nextCursor: cursor, terminalReason: null };
      },
      // Asked only once the transcript goes quiet, after both pages.
      state: async () => 'completed',
      wait: async () => {},
      show: () => {},
      say: (line) => lines.push(line),
      stuck: { watch: new StuckWatch(clock().now), flagged: (signal) => flags.push(signal ? signal.reason : null) },
    }, { packetId: 'p', sessionKey: 's', events: [], nextCursor: 0, terminalReason: null });
    expect(exit).toBe(0);
    expect(flags).toEqual(['retry_loop', null]);
    expect(lines.at(-1)).toBe('The worker stopped. The packet is completed.');
  });

  it('flags nothing when no watch is given', async () => {
    const pages: TranscriptEvent[][] = [[...ran('make', false, 'x'), ...ran('make', false, 'x'), ...ran('make', false, 'x')]];
    const exit = await followTranscript({
      read: async () => ({ packetId: 'p', sessionKey: 's', events: pages.shift() ?? [], nextCursor: 6, terminalReason: null }),
      state: async () => 'completed',
      wait: async () => {},
      show: () => {},
      say: () => {},
    }, { packetId: 'p', sessionKey: 's', events: [], nextCursor: 0, terminalReason: null });
    expect(exit).toBe(0);
  });
});
