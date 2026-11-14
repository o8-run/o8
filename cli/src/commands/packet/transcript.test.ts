import { describe, expect, it } from 'vitest';

import {
  followIsOver, parseTranscriptArgs, plainText, toolDetail, transcriptLines, type TranscriptEvent,
} from './transcript';

const at = () => '12:31:05';
const call = (tool: string, args: unknown, summary = ''): Extract<TranscriptEvent, { type: 'tool_call' }> => ({
  seq: 1, ts: '2026-11-14T12:31:05.564Z', type: 'tool_call', tool, args: typeof args === 'string' ? args : JSON.stringify(args), summary,
});

describe('packet transcript arguments', () => {
  it('takes an optional packet, --follow or -f, and a bounded --limit', () => {
    expect(parseTranscriptArgs([])).toEqual({ target: null, follow: false, limit: 50 });
    expect(parseTranscriptArgs(['pkt-1', '-f'])).toEqual({ target: 'pkt-1', follow: true, limit: 50 });
    expect(parseTranscriptArgs(['pkt-1', '--follow', '--limit', '200'])).toEqual({ target: 'pkt-1', follow: true, limit: 200 });
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
      .toEqual(['12:31:05  First line.', '          [2JSecond line.']);
    expect(transcriptLines({ seq: 3, ts: '', type: 'assistant', text: '  \n ' }, at)).toEqual([]);
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

  it('ends at once on the worker done event', () => {
    expect(followIsOver({ events: [reply, done] }, 0)).toBe(true);
  });

  it('keeps going while events arrive, while it has not checked, and while the lane works', () => {
    expect(followIsOver({ events: [reply] }, 0, 'reviewing')).toBe(false);
    expect(followIsOver({ events: [] }, 50)).toBe(false);
    expect(followIsOver({ events: [] }, 3, 'running')).toBe(false);
    expect(followIsOver({ events: [] }, 3, 'launching')).toBe(false);
    expect(followIsOver({ events: [] }, 2, 'reviewing')).toBe(false);
  });

  it('ends once the transcript is quiet and the lane has stopped working or is gone', () => {
    for (const state of ['reviewing', 'awaiting_input', 'failed', 'completed', 'archived']) {
      expect(followIsOver({ events: [] }, 3, state)).toBe(true);
    }
    expect(followIsOver({ events: [] }, 3, null)).toBe(true);
  });
});
