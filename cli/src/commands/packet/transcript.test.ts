import { describe, expect, it, vi } from 'vitest';

import { CliError, EXIT } from '../../api';

import {
  followIsOver, followTranscript, holdOpen, nextCursor, parseTranscriptArgs, plainText, shouldCheckState, toolDetail, transcriptLines, type TranscriptEvent,
} from './transcript';

const at = () => '12:31:05';
const call = (tool: string, args: unknown, summary = ''): Extract<TranscriptEvent, { type: 'tool_call' }> => ({
  seq: 1, ts: '2026-11-14T12:31:05.564Z', type: 'tool_call', tool, args: typeof args === 'string' ? args : JSON.stringify(args), summary,
});

describe('packet transcript arguments', () => {
  it('takes an optional packet, --follow or -f, and a bounded --limit', () => {
    expect(parseTranscriptArgs([])).toEqual({ target: null, follow: false, hold: false, limit: 50 });
    expect(parseTranscriptArgs(['pkt-1', '-f'])).toEqual({ target: 'pkt-1', follow: true, hold: false, limit: 50 });
    expect(parseTranscriptArgs(['pkt-1', '--follow', '--limit', '200'])).toEqual({ target: 'pkt-1', follow: true, hold: false, limit: 200 });
    expect(parseTranscriptArgs(['pkt-1', '--follow', '--hold'])).toEqual({ target: 'pkt-1', follow: true, hold: true, limit: 50 });
    expect(() => parseTranscriptArgs(['pkt-1', '--hold'])).toThrow(/--hold only applies with --follow/);
  });

  it('refuses a limit outside 1..200', () => {
    for (const limit of ['0', '201', '-1', 'ten', '1e2']) {
      expect(() => parseTranscriptArgs(['--limit', limit])).toThrow();
    }
  });
});

describe('transcript text is untrusted', () => {
  it('never lets control, invisible or text-direction characters through', () => {
    const hidden = String.fromCodePoint(0x1b, 0x202e, 0x200b, 0x9b, 0x07);
    expect(plainText(`a${hidden}[31mb\r\nc`, 100)).toBe('a [31mb c');
    expect(plainText(`a${hidden}b\r\n\r\n\r\n\r\nc\td`, 100, true)).toBe('a b\n\nc d');
    expect(plainText(42, 100)).toBe('');
  });

  it('cuts by character, never through one', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(plainText(emoji.repeat(10), 4)).toBe(`${emoji.repeat(3)}…`);
  });
});

describe('what a tool call is about', () => {
  it('prefers the command, then a short path, then other telling arguments', () => {
    expect(toolDetail(call('Bash', { command: 'npm test', description: 'Run tests' }))).toBe('npm test');
    expect(toolDetail(call('Edit', { file_path: '/home/u/.o8/worktrees/demo/packet-1/src/app.ts', replace_all: false }))).toBe('…/src/app.ts');
    expect(toolDetail(call('Read', { file_path: 'README.md' }))).toBe('README.md');
    expect(toolDetail(call('Grep', { pattern: 'TODO' }))).toBe('TODO');
  });

  it('reads the packet worktree as the current directory', () => {
    const root = '/home/u/.o8/worktrees/demo-ee60/.cortex-worktrees/packet-pkt-1-index.noindex';
    expect(toolDetail(call('Edit', { file_path: `${root}/GUIDE.md` }))).toBe('./GUIDE.md');
    expect(toolDetail(call('Edit', { file_path: `${root}/src/lib/deep/app.ts` }))).toBe('…/deep/app.ts');
    expect(toolDetail(call('Bash', { command: `cd "${root}" && git status` }))).toBe('cd "." && git status');
    expect(toolDetail(call('Custom', '{"cut', `read ${root}/a.txt`))).toBe('read ./a.txt');
  });

  it('falls back to the summary when the arguments were cut short or name nothing known', () => {
    expect(toolDetail(call('Edit', '{"file_path":"/a/b/c', 'edit c'))).toBe('edit c');
    const cut = '{"replace_all":false,"file_path":"/w/.cortex-worktrees/packet-1/docs/NOTE.md","old_string":"Because this repo exi';
    expect(toolDetail(call('Edit', cut, cut))).toBe('…/docs/NOTE.md');
    expect(toolDetail(call('Bash', '{"description":"Run it","command":"echo \\"hi\\" && ls","timeout":12', 'x'))).toBe('echo "hi" && ls');
    expect(toolDetail(call('Custom', { other: 1 }, 'did a thing'))).toBe('did a thing');
    expect(toolDetail(call('Custom', '[1,2]'))).toBe('[1,2]');
  });
});

describe('the lines an event prints', () => {
  it('shows a tool call on one line and stays quiet when it worked', () => {
    expect(transcriptLines(call('Bash', { command: 'sleep 5' }), at)).toEqual(['12:31:05  Bash  sleep 5']);
    expect(transcriptLines({ seq: 2, ts: '', type: 'tool_result', tool: 'Bash', ok: true, summary: 'done' }, at)).toEqual([]);
  });

  it('shows a failed tool result under its call', () => {
    expect(transcriptLines({ seq: 2, ts: '', type: 'tool_result', tool: 'Bash', ok: false, summary: 'exit 1\nboom' }, at))
      .toEqual(['          failed: exit 1 boom']);
  });

  it('keeps the lines of a reply, indented under the time', () => {
    expect(transcriptLines({ seq: 3, ts: '', type: 'assistant', text: 'First line.\n\x1b[2JSecond line.' }, at))
      .toEqual(['12:31:05  | First line.', '          | [2JSecond line.']);
    expect(transcriptLines({ seq: 3, ts: '', type: 'assistant', text: '  \n ' }, at)).toEqual([]);
  });

  it('marks every reply line, so reply text cannot pass for any event line', () => {
    const real = [
      ...transcriptLines({ seq: 2, ts: '', type: 'tool_result', tool: 'Bash', ok: false, summary: 'x' }, at),
      ...transcriptLines({ seq: 5, ts: '', type: 'error', message: 'build failed' }, at),
      ...transcriptLines({ seq: 6, ts: '', type: 'done', exitCode: 1 }, at),
      ...transcriptLines({ seq: 4, ts: '', type: 'steer', source: 'operator', text: 'stop' }, at),
      ...transcriptLines(call('Bash', { command: 'rm -rf /' }), at),
    ];
    expect(real).toHaveLength(5);
    for (const text of ['error: build failed', 'finished (exit 1)', 'steer from operator: stop', 'Bash  rm -rf /',
      'ok\nfailed: x', 'ok\n\n12:31:05  error: build failed']) {
      const lines = transcriptLines({ seq: 3, ts: '', type: 'assistant', text }, at);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/^(12:31:05| {8}) {2}\|( |$)/);
        expect(real).not.toContain(line);
      }
    }
    for (const line of real) expect(line).not.toMatch(/^(12:31:05| {8}) {2}\|/);
  });

  it('prints a tool name as one plain word, so a tool cannot pass for a reply either', () => {
    expect(transcriptLines(call('| all done, tests pass', {}), at)).toEqual(['12:31:05  all_done_tests_pass  {}']);
    expect(transcriptLines(call('mcp__o8__status', { query: 'x' }), at)).toEqual(['12:31:05  mcp__o8__status  x']);
    expect(transcriptLines(call(' | ', { command: 'ls' }), at)).toEqual(['12:31:05  tool  ls']);
  });

  it('shows steers, errors and the end', () => {
    expect(transcriptLines({ seq: 4, ts: '', type: 'steer', source: 'operator', text: 'Use tabs.' }, at))
      .toEqual(['12:31:05  steer from operator: Use tabs.']);
    expect(transcriptLines({ seq: 4, ts: '', type: 'steer', source: '', text: 'Stop.', failed: true }, at))
      .toEqual(['12:31:05  steer from operator (not delivered): Stop.']);
    expect(transcriptLines({ seq: 5, ts: '', type: 'error', message: 'rate limited' }, at)).toEqual(['12:31:05  error: rate limited']);
    expect(transcriptLines({ seq: 6, ts: '', type: 'done', exitCode: 0 }, at)).toEqual(['12:31:05  finished (exit 0)']);
  });

  it('prints a placeholder time for a timestamp it cannot read, and nothing for an unknown event', () => {
    expect(transcriptLines({ seq: 5, ts: 'not a date', type: 'error', message: 'x' })).toEqual(['--:--:--  error: x']);
    expect(transcriptLines({ seq: 7, ts: '', type: 'future' } as unknown as TranscriptEvent, at)).toEqual([]);
  });
});

describe('when a follow ends', () => {
  const done: TranscriptEvent = { seq: 9, ts: '', type: 'done', exitCode: 0 };
  const reply: TranscriptEvent = { seq: 8, ts: '', type: 'assistant', text: 'hi' };

  it('checks the packet when a page ends with done, or after every third quiet page', () => {
    expect(shouldCheckState({ events: [reply, done] }, 0)).toBe(true);
    expect(shouldCheckState({ events: [done, reply] }, 0)).toBe(false);
    expect(shouldCheckState({ events: [reply] }, 0)).toBe(false);
    expect([0, 1, 2, 3, 4, 5, 6].map((quiet) => shouldCheckState({ events: [] }, quiet)))
      .toEqual([false, false, false, true, false, false, true]);
  });

  it('never ends on a done event alone: a steered worker starts another turn', () => {
    expect(followIsOver(undefined)).toBe(false);
    expect(followIsOver('running')).toBe(false);
    expect(followIsOver('launching')).toBe(false);
  });

  it('ends once the lane has stopped working or is gone', () => {
    for (const state of ['reviewing', 'awaiting_input', 'failed', 'completed', 'archived']) {
      expect(followIsOver(state)).toBe(true);
    }
    expect(followIsOver(null)).toBe(true);
  });
});

describe('where a follow reads next', () => {
  it('moves forward with the page, and stays put on an empty one', () => {
    expect(nextCursor(10, 's1', { sessionKey: 's1', nextCursor: 14 })).toEqual({ cursor: 14, session: 's1', restarted: false });
    expect(nextCursor(10, 's1', { sessionKey: 's1', nextCursor: null })).toEqual({ cursor: 10, session: 's1', restarted: false });
    expect(nextCursor(10, 's1', { sessionKey: 's1', nextCursor: 4 })).toEqual({ cursor: 10, session: 's1', restarted: false });
    expect(nextCursor(0, null, { sessionKey: 's1', nextCursor: 3 })).toEqual({ cursor: 3, session: 's1', restarted: false });
  });

  it('starts over when the packet has a new worker session', () => {
    expect(nextCursor(40, 's1', { sessionKey: 's2', nextCursor: 41 })).toEqual({ cursor: 0, session: 's2', restarted: true });
    expect(nextCursor(40, 's1', { sessionKey: null, nextCursor: null })).toEqual({ cursor: 40, session: 's1', restarted: false });
  });
});

describe('the follow loop', () => {
  const reply = (seq: number): TranscriptEvent => ({ seq, ts: '', type: 'assistant', text: `r${seq}` });
  const done = (seq: number): TranscriptEvent => ({ seq, ts: '', type: 'done', exitCode: 0 });
  const page = (events: TranscriptEvent[], sessionKey = 's1') => ({
    packetId: 'pkt-1', sessionKey, events, nextCursor: events.length ? events[events.length - 1].seq : null, terminalReason: null,
  });

  /** Plays back pages and lane states in order, and records everything the loop did. */
  function steps(pages: Array<ReturnType<typeof page> | Error>, states: Array<string | null | Error>) {
    const log: string[] = [];
    return {
      log,
      steps: {
        read: async (cursor: number) => {
          const next = pages.shift();
          log.push(`read ${cursor}`);
          if (!next) throw new Error('ran out of pages');
          if (next instanceof Error) throw next;
          return next;
        },
        state: async () => {
          const next = states.shift();
          log.push(`state ${String(next instanceof Error ? 'fails' : next)}`);
          if (next === undefined) throw new Error('ran out of states');
          if (next instanceof Error) throw next;
          return next;
        },
        wait: async () => { log.push('wait'); },
        show: (events: TranscriptEvent[]) => { if (events.length) log.push(`show ${events.map((event) => event.seq).join(',')}`); },
        say: (line: string) => { log.push(`say ${line}`); },
      },
    };
  }

  it('shows new events, checks the packet after three quiet pages, and reads once more before it ends', async () => {
    const run = steps([page([reply(3)]), page([]), page([]), page([]), page([reply(4)])], ['reviewing']);
    await expect(followTranscript(run.steps, page([reply(2)]))).resolves.toBe(EXIT.OK);
    expect(run.log).toEqual([
      'wait', 'read 2', 'show 3',
      'wait', 'read 3', 'wait', 'read 3', 'wait', 'read 3',
      'state reviewing', 'read 3', 'show 4',
      'say The worker stopped. The packet is reviewing.',
    ]);
  });

  it('keeps following past a done event while the lane still works', async () => {
    const run = steps([page([reply(4)]), page([]), page([]), page([]), page([])], ['running', 'awaiting_input']);
    await followTranscript(run.steps, page([reply(2), done(3)]));
    expect(run.log.slice(0, 4)).toEqual(['state running', 'wait', 'read 3', 'show 4']);
    expect(run.log[run.log.length - 1]).toBe('say The worker stopped. The packet is awaiting input.');
  });

  it('ends at once after a done event when the lane has stopped, with one last read', async () => {
    const run = steps([page([])], ['reviewing']);
    await followTranscript(run.steps, page([reply(2), done(3)]));
    expect(run.log).toEqual(['state reviewing', 'read 3', 'say The worker stopped. The packet is reviewing.']);
  });

  it('starts over when the packet is dispatched again, without showing the stale page', async () => {
    const run = steps(
      [page([reply(41)], 's2'), page([reply(1), reply(2)], 's2'), page([], 's2'), page([], 's2'), page([], 's2'), page([], 's2')],
      [null],
    );
    await followTranscript(run.steps, page([reply(40)]));
    expect(run.log.slice(0, 6)).toEqual([
      'wait', 'read 40', 'say The packet was dispatched again. Following the new worker.', 'wait', 'read 0', 'show 1,2',
    ]);
    expect(run.log[run.log.length - 1]).toBe('say The worker stopped. The packet is gone.');
  });

  it('reads a full page again without a pause', async () => {
    const full = Array.from({ length: 200 }, (_, index) => reply(index + 3));
    const run = steps([page(full), page([done(203)]), page([])], ['failed']);
    await followTranscript(run.steps, page([reply(2)]));
    expect(run.log.filter((entry) => !entry.startsWith('show'))).toEqual([
      'wait', 'read 2', 'read 202', 'state failed', 'read 203', 'say The worker stopped. The packet is failed.',
    ]);
  });

  it('retries a connection failure with a pause, and counts only failures in a row', async () => {
    const down = () => new CliError('connection_refused', 'down', EXIT.CONNECTION_REFUSED);
    const run = steps(
      [down(), down(), down(), down(), page([reply(3)]), down(), down(), down(), down(), page([done(4)]), page([])],
      ['completed'],
    );
    await expect(followTranscript(run.steps, page([reply(2)]))).resolves.toBe(EXIT.OK);
    expect(run.log.filter((entry) => entry === 'wait')).toHaveLength(10);
    expect(run.log.slice(0, 6)).toEqual(['wait', 'read 2', 'wait', 'read 2', 'wait', 'read 2']);
    expect(run.log).toContain('show 3');
  });

  it('gives up after five connection failures in a row, and at once on any other error', async () => {
    const down = () => new CliError('connection_refused', 'down', EXIT.CONNECTION_REFUSED);
    const five = steps([down(), down(), down(), down(), down()], []);
    await expect(followTranscript(five.steps, page([reply(2)]))).rejects.toThrow('down');
    expect(five.log.filter((entry) => entry.startsWith('read'))).toHaveLength(5);
    const refused = steps([new CliError('unauthorized', 'no', EXIT.UNAUTHORIZED)], []);
    await expect(followTranscript(refused.steps, page([reply(2)]))).rejects.toThrow('no');
    expect(refused.log).toEqual(['wait', 'read 2']);
  });

  it('follows the new worker when the packet is dispatched again just as the old one stopped', async () => {
    const run = steps(
      [page([reply(1), reply(2)], 's2'), page([reply(1), reply(2)], 's2'), page([], 's2'), page([], 's2'), page([], 's2'), page([], 's2')],
      ['failed', 'reviewing'],
    );
    await followTranscript(run.steps, page([reply(2), done(3)]));
    expect(run.log.slice(0, 6)).toEqual([
      'state failed', 'read 3', 'say The packet was dispatched again. Following the new worker.', 'wait', 'read 0', 'show 1,2',
    ]);
    expect(run.log[run.log.length - 1]).toBe('say The worker stopped. The packet is reviewing.');
  });

  it('pauses between failed packet checks, and takes the check up again', async () => {
    const down = () => new CliError('network_error', 'down', EXIT.CONNECTION_REFUSED);
    const run = steps([page([])], [down(), down(), 'reviewing']);
    await followTranscript(run.steps, page([reply(2), done(3)]));
    expect(run.log).toEqual([
      'state fails', 'wait', 'state fails', 'wait', 'state reviewing', 'read 3', 'say The worker stopped. The packet is reviewing.',
    ]);
    const always = steps([], [down(), down(), down(), down(), down()]);
    await expect(followTranscript(always.steps, page([done(3)]))).rejects.toThrow('down');
    expect(always.log.filter((entry) => entry === 'wait')).toHaveLength(4);
  });

  it('checks the packet again when the last read after a stop fails', async () => {
    const down = () => new CliError('server_timeout', 'slow', EXIT.CONNECTION_REFUSED);
    const run = steps([down(), page([reply(4)])], ['reviewing', 'reviewing']);
    await followTranscript(run.steps, page([reply(2), done(3)]));
    expect(run.log).toEqual([
      'state reviewing', 'read 3', 'wait', 'state reviewing', 'read 3', 'show 4', 'say The worker stopped. The packet is reviewing.',
    ]);
  });

  it('keeps reading after a stop while the last read is a full page', async () => {
    const full = Array.from({ length: 200 }, (_, index) => reply(index + 4));
    const run = steps([page(full), page([reply(204)])], ['reviewing', 'reviewing']);
    await followTranscript(run.steps, page([reply(2), done(3)]));
    expect(run.log.filter((entry) => !entry.startsWith('show'))).toEqual([
      'state reviewing', 'read 3', 'state reviewing', 'read 203', 'say The worker stopped. The packet is reviewing.',
    ]);
    expect(run.log).toContain('show 204');
  });
});

describe('holding the pane open', () => {
  function terminal(inputTty: boolean, outputTty: boolean) {
    const listeners: Record<string, Array<() => void>> = { data: [], end: [] };
    const log: string[] = [];
    return {
      log,
      listening: () => listeners.data.length + listeners.end.length,
      fire: (event: 'data' | 'end') => { for (const listener of [...listeners[event]]) listener(); },
      terminal: {
        input: {
          isTTY: inputTty,
          on: (event: 'data' | 'end', listener: () => void) => { listeners[event].push(listener); },
          off: (event: 'data' | 'end', listener: () => void) => { listeners[event] = listeners[event].filter((item) => item !== listener); },
          resume: () => { log.push('resume'); },
          pause: () => { log.push('pause'); },
        },
        output: { isTTY: outputTty, write: (text: string) => { log.push(text.trim()); } },
      },
    };
  }

  it('waits for a key, says how to close, and leaves no listener behind', async () => {
    const held = terminal(true, true);
    let time = 1_000;
    const waiting = holdOpen(held.terminal, { now: () => time });
    expect(held.log).toEqual(['Press Enter to close.', 'resume']);
    time += 5_000;
    held.fire('data');
    await expect(waiting).resolves.toBe('closed');
    expect(held.log).toEqual(['Press Enter to close.', 'resume', 'pause']);
    expect(held.listening()).toBe(0);
  });

  it('is not closed by a line typed before the prompt', async () => {
    const held = terminal(true, true);
    let time = 1_000;
    let result: string | null = null;
    const waiting = holdOpen(held.terminal, { now: () => time }).then((how) => { result = how; });
    time += 50;
    held.fire('data');
    await Promise.resolve();
    expect(result).toBeNull();
    time += 1_000;
    held.fire('data');
    await waiting;
    expect(result).toBe('closed');
  });

  it('ends when the input closes', async () => {
    const held = terminal(true, true);
    const waiting = holdOpen(held.terminal);
    held.fire('end');
    await expect(waiting).resolves.toBe('closed');
  });

  it('ends as running when the packet works again, and keeps asking after a failed check', async () => {
    vi.useFakeTimers();
    try {
      const held = terminal(true, true);
      const answers: Array<boolean | Error> = [false, new Error('down'), true];
      const asked: number[] = [];
      const waiting = holdOpen(held.terminal, {
        pollMs: 100,
        runningAgain: async () => {
          asked.push(asked.length);
          const answer = answers.shift();
          if (answer instanceof Error) throw answer;
          return answer === true;
        },
      });
      await vi.advanceTimersByTimeAsync(350);
      await expect(waiting).resolves.toBe('running');
      expect(asked).toHaveLength(3);
      expect(held.listening()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(asked).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns at once when there is no terminal to press a key in', async () => {
    for (const [input, output] of [[false, true], [true, false], [false, false]] as const) {
      const piped = terminal(input, output);
      await expect(holdOpen(piped.terminal)).resolves.toBe('closed');
      expect(piped.log).toEqual([]);
    }
  });
});

describe('taking a follow up again', () => {
  it('reports where it ended', async () => {
    const reply = (seq: number): TranscriptEvent => ({ seq, ts: '', type: 'assistant', text: `r${seq}` });
    const first = { packetId: 'pkt-1', sessionKey: 's1', events: [reply(2), { seq: 3, ts: '', type: 'done' as const, exitCode: 0 }], nextCursor: 3, terminalReason: null };
    const ended: Array<[number, string | null]> = [];
    await followTranscript({
      read: async () => ({ ...first, events: [reply(4)], nextCursor: 4 }),
      state: async () => 'reviewing',
      wait: async () => undefined,
      show: () => undefined,
      say: () => undefined,
      ended: (cursor, session) => { ended.push([cursor, session]); },
    }, first);
    expect(ended).toEqual([[4, 's1']]);
  });
});
