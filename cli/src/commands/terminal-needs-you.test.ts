import { describe, expect, it } from 'vitest';

import { CliError } from '../api';

import { focusNeedsYou, paneNeed, parseNeedsYouArgs, pickPane } from './terminal-needs-you';

const TERMINAL = 'com.superlogical.terminal';

/** A fake `rex` for one session: its panes, what each reported, and where focus went. */
function fakeRex(panes: Array<{ id: string; label: string; records?: unknown[]; creator?: string }>) {
  const focused: string[] = [];
  const calls: string[][] = [];
  const exec = (file: string, args: string[]): string => {
    calls.push([file, ...args]);
    if (args[0] === 'block' && args[1] === 'ls') {
      return JSON.stringify({ blocks: panes.map((pane) => ({ block_id: pane.id, label: pane.label, creator_name: pane.creator ?? TERMINAL, placement: 'placed' })) });
    }
    if (args[0] === 'block' && args[1] === 'call') {
      const pane = panes.find((candidate) => candidate.id === args[args.indexOf('-b') + 1]);
      if (!pane) throw new Error('no such block');
      return JSON.stringify({ records: pane.records ?? [] });
    }
    if (args[0] === 'focus') {
      focused.push(args[args.length - 1]);
      return '';
    }
    throw new Error(`unexpected rex ${args.join(' ')}`);
  };
  return { exec, focused, calls };
}

const blocked = (msg: string) => ({ id: 'o8', state: 'blocked', app: 'o8', effective_app: 'o8', msg });
const failed = (msg: string) => ({ id: 'o8', state: 'error', app: 'o8', effective_app: 'o8', msg });
const working = { id: 'o8', state: 'working', app: 'o8', effective_app: 'o8', msg: 'Running' };

describe('o8 terminal needs-you', () => {
  it('focuses the pane that needs you and says what it reported', () => {
    const rex = fakeRex([
      { id: 'block:w', label: 'o8 watcher', records: [failed('1 running · 1 needs you')] },
      { id: 'block:a', label: 'o8: Add health route [p1]', records: [working] },
      { id: 'block:b', label: 'o8: Fix login [p2]', records: [failed('Blocked: needs a decision')] },
    ]);
    const result = focusNeedsYou({ args: { session: 'session:s', from: 'block:w' }, env: {}, exec: rex.exec });
    expect(result).toEqual({ block: 'block:b', label: 'o8: Fix login [p2]', msg: 'Blocked: needs a decision', waiting: 1 });
    expect(rex.focused).toEqual(['block:b']);
  });

  it('moves on to the next one each time it runs, wrapping around', () => {
    const rex = fakeRex([
      { id: 'block:a', label: 'o8: A [p1]', records: [failed('Failed')] },
      { id: 'block:b', label: 'o8: B [p2]', records: [working] },
      { id: 'block:c', label: 'o8: C [p3]', records: [failed('Failed')] },
    ]);
    const next = (from: string) => focusNeedsYou({ args: { session: 'session:s', from }, env: {}, exec: rex.exec }).block;
    expect(next('block:a')).toBe('block:c');
    expect(next('block:c')).toBe('block:a');
    expect(next('block:b')).toBe('block:c');
  });

  it('goes to a blocked pane before a failed one, then on to the failed one', () => {
    const rex = fakeRex([
      { id: 'block:w', label: 'o8 watcher', records: [failed('2 need you')] },
      { id: 'block:a', label: 'o8: A [p1]', records: [failed('Failed')] },
      { id: 'block:b', label: 'o8: B [p2]', records: [blocked('Needs you: same error 3x')] },
      { id: 'block:c', label: 'o8: C [p3]', records: [blocked('Needs you: no output')] },
    ]);
    const next = (from: string) => focusNeedsYou({ args: { session: 'session:s', from }, env: {}, exec: rex.exec });
    expect(next('block:w')).toMatchObject({ block: 'block:b', waiting: 3 });
    // From a pane that needs you, each press visits the next, failed ones included.
    expect(next('block:b').block).toBe('block:c');
    expect(next('block:c').block).toBe('block:a');
    expect(next('block:a').block).toBe('block:b');
  });

  it('leaves focus alone when nothing needs you, and ignores other programs and the watcher', () => {
    const rex = fakeRex([
      { id: 'block:w', label: 'o8 watcher', records: [failed('2 need you')] },
      { id: 'block:x', label: 'build', records: [{ id: 'o8', state: 'error', app: 'make', effective_app: 'make' }] },
      { id: 'block:y', label: 'editor', creator: 'com.example.editor', records: [failed('Failed')] },
      { id: 'block:a', label: 'o8: A [p1]', records: [working] },
    ]);
    expect(focusNeedsYou({ args: { session: 'session:s', from: null }, env: {}, exec: rex.exec }))
      .toEqual({ block: null, label: null, msg: null, waiting: 0 });
    expect(rex.focused).toEqual([]);
    // A pane of another kind is never asked for its status.
    expect(rex.calls.some((call) => call.includes('block:y'))).toBe(false);
  });

  it('skips a pane that closed while it was being read', () => {
    const rex = fakeRex([{ id: 'block:a', label: 'o8: A [p1]', records: [failed('Failed')] }]);
    const exec = (file: string, args: string[]) => {
      if (args[1] === 'ls') return JSON.stringify({ blocks: [{ block_id: 'block:gone', label: 'o8: G [p9]', creator_name: TERMINAL }, { block_id: 'block:a', label: 'o8: A [p1]', creator_name: TERMINAL }] });
      return rex.exec(file, args);
    };
    expect(focusNeedsYou({ args: { session: 'session:s', from: null }, env: {}, exec }).block).toBe('block:a');
  });

  it('uses the Rex pane it runs in when no session is passed', () => {
    const rex = fakeRex([{ id: 'block:a', label: 'o8: A [p1]', records: [failed('Failed')] }]);
    focusNeedsYou({ args: { session: null, from: null }, env: { REX_SESSION: 'session:here', REX_BLOCK: 'block:a' }, exec: rex.exec });
    expect(rex.calls[0]).toEqual(['rex', 'block', 'ls', '-s', 'session:here', '--json']);
    expect(() => focusNeedsYou({ args: { session: null, from: null }, env: {}, exec: rex.exec })).toThrow(CliError);
  });

  it('says plainly when rex is missing', () => {
    const missing = Object.assign(new Error('spawn rex ENOENT'), { code: 'ENOENT' });
    expect(() => focusNeedsYou({ args: { session: 'session:s', from: null }, env: {}, exec: () => { throw missing; } }))
      .toThrow('The `rex` command is not on PATH.');
  });
});

describe('reading the arguments', () => {
  it('takes a session and the pane to start after, and an empty pane from an action', () => {
    expect(parseNeedsYouArgs([])).toEqual({ session: null, from: null });
    expect(parseNeedsYouArgs(['--session', 'session:abc', '--from', ''])).toEqual({ session: 'session:abc', from: null });
    expect(() => parseNeedsYouArgs(['--session'])).toThrow(CliError);
    expect(() => parseNeedsYouArgs(['--from', 'a b'])).toThrow(CliError);
    expect(() => parseNeedsYouArgs(['--other', 'x'])).toThrow(CliError);
  });
});

describe('choosing', () => {
  it('ranks blocked over failed, and nothing else counts', () => {
    expect(paneNeed([working, failed('F'), blocked('B')])).toEqual({ rank: 0, msg: 'B' });
    expect(paneNeed([working, { state: 'done', app: 'o8' }])).toBeNull();
    expect(paneNeed([{ state: 'error', app: 'o8', effective_app: 'other' }])).toBeNull();
  });

  it('starts from the top when the current pane is unknown', () => {
    const order = ['a', 'b', 'c'];
    expect(pickPane([{ block: 'c', rank: 1 }, { block: 'b', rank: 1 }], order, 'zzz')?.block).toBe('b');
    expect(pickPane([], order, null)).toBeNull();
  });
});
