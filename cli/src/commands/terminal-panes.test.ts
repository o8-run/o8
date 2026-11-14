import { describe, expect, it } from 'vitest';

import { EXIT } from '../api';
import { confirmOpenedPanes, observeCommand, openTerminalPanes, paneLabel, parsePanesArgs, type PaneExec } from './terminal-panes';

const self = ['/usr/bin/node', '/opt/o8 app/o8.mjs'];
const rexEnv = { REX_SESSION: 'session:abc' };
const t = (...ids: string[]) => ids.map((id) => ({ id }));

interface FakeBlock { block_id: string; label: string; placement?: string }

/** A fake `rex` that records every call and hands out pane IDs in order. */
function fakeRex(blocks: FakeBlock[] = [], failOn?: (args: string[], creations: number) => boolean) {
  const calls: string[][] = [];
  let creations = 0;
  const exec: PaneExec = (file, args) => {
    expect(file).toBe('rex');
    calls.push(args);
    if (failOn?.(args, creations)) throw new Error('rex failed');
    if (args[0] === 'block' && args[1] === 'ls') return JSON.stringify({ blocks });
    if (args[0] === 'window' && args[1] === 'rename') return '';
    creations += 1;
    return JSON.stringify({
      block_ids: [`block:new-${creations}`],
      ...(args[0] === 'run' ? { window_id: 'window:new' } : {}),
    });
  };
  return { calls, exec };
}

function command(args: string[]): string[] {
  return args.slice(args.indexOf('--') + 1);
}

describe('observeCommand', () => {
  it('runs this CLI as a read-only observer', () => {
    expect(observeCommand({ self, env: {}, machineKey: null }, 'cortex-dash-1')).toEqual([
      ...self, '--human', 'terminal', 'observe', 'cortex-dash-1',
    ]);
  });

  it('passes routing values whole, and never a credential', () => {
    const words = observeCommand({
      self,
      machineKey: 'Build box',
      env: {
        O8_API_PORT: '47120',
        O8_WS_PORT: '47125',
        O8_DATA_DIR: '/Users/x/Application Support/o8',
        O8_API_TOKEN: 'secret-token',
        O8_WORKER_TOKEN: 'secret-worker',
        O8_SPECTATOR_TOKEN: 'secret-spectator',
      },
    }, 'cortex-dash-1');
    expect(words).toEqual([
      'env', 'O8_API_PORT=47120', 'O8_WS_PORT=47125', 'O8_DATA_DIR=/Users/x/Application Support/o8',
      ...self, '--human', 'terminal', 'observe', 'cortex-dash-1', '--machine', 'Build box',
    ]);
    expect(words.join(' ')).not.toContain('secret');
  });
});

describe('parsePanesArgs', () => {
  it('defaults to 8 panes on this machine', () => {
    expect(parsePanesArgs([])).toEqual({ limit: 8, machineKey: null });
    expect(parsePanesArgs(['--limit', '16', '--machine', 'Build box'])).toEqual({ limit: 16, machineKey: 'Build box' });
  });

  it.each([
    [['--limit']],
    [['--limit', '0']],
    [['--limit', '17']],
    [['--limit', '4', '--limit', '5']],
    [['--machine', 'A', '--machine', 'B']],
    [['--machine', '--limit']],
    [['--machine', '-oProxyCommand=x']],
    [['--machine', 'Build; reboot']],
    [['--machine', '$(reboot)']],
    [['--control', 'yes']],
  ])('rejects %j', (rest) => {
    expect(() => parsePanesArgs(rest)).toThrowError(expect.objectContaining({ code: 'invalid_args', exit: EXIT.INVALID_ARGS }));
  });
});

describe('openTerminalPanes', () => {
  it('refuses to run outside Rex and makes no call', () => {
    const { calls, exec } = fakeRex();
    expect(() => openTerminalPanes({ terminals: t('a'), limit: 8, env: {}, self, exec }))
      .toThrowError(expect.objectContaining({ code: 'multiplexer_required', exit: EXIT.INVALID_ARGS }));
    expect(calls).toEqual([]);
  });

  it('refuses an unsafe machine key, a broken self command, and control characters, before any call', () => {
    const { calls, exec } = fakeRex();
    const base = { terminals: t('a'), limit: 8, self, exec };
    expect(() => openTerminalPanes({ ...base, env: rexEnv, machineKey: '--flag' })).toThrowError(expect.objectContaining({ code: 'invalid_args' }));
    expect(() => openTerminalPanes({ ...base, env: rexEnv, self: ['/usr/bin/node', ''] })).toThrowError(expect.objectContaining({ code: 'invalid_args' }));
    expect(() => openTerminalPanes({ ...base, env: rexEnv, self: ['/opt/a=b/node', '/o8.mjs'] })).toThrowError(expect.objectContaining({ code: 'invalid_args' }));
    expect(() => openTerminalPanes({ ...base, env: { ...rexEnv, O8_DATA_DIR: '/tmp/a\nb' } })).toThrowError(expect.objectContaining({ code: 'invalid_args' }));
    expect(calls).toEqual([]);
  });

  it('opens a labeled tab for the first terminal, then tiles the rest as splits', () => {
    const { calls, exec } = fakeRex();
    const result = openTerminalPanes({ terminals: t('t1', 't2', 't3', 't4'), limit: 8, env: rexEnv, self, exec });

    expect(result.opened).toEqual([
      { id: 't1', pane: 'block:new-1' },
      { id: 't2', pane: 'block:new-2' },
      { id: 't3', pane: 'block:new-3' },
      { id: 't4', pane: 'block:new-4' },
    ]);
    expect(result.error).toBeNull();
    expect(calls[0]).toEqual(['block', 'ls', '-s', 'session:abc', '--json']);
    // The first pane is labeled in the same call that creates it.
    expect(calls[1].slice(0, 5)).toEqual(['run', '-s', 'session:abc', '--label', 'o8: [t1]']);
    expect(calls[1]).toContain('--focus=false');
    expect(calls[1]).not.toContain('--keep-open');
    expect(command(calls[1])).toEqual([...self, '--human', 'terminal', 'observe', 't1']);
    expect(calls[2]).toEqual(['window', 'rename', '-s', 'session:abc', 'window:new', 'o8 terminals']);
    // t2 splits t1 to the right, t3 splits t1 below, t4 splits t2 to the right.
    expect(calls[3].slice(0, 8)).toEqual(['split', '-s', 'session:abc', '-b', 'block:new-1', '--split=right', '--label', 'o8: [t2]']);
    expect(calls[4].slice(0, 8)).toEqual(['split', '-s', 'session:abc', '-b', 'block:new-1', '--split=below', '--label', 'o8: [t3]']);
    expect(calls[5].slice(0, 8)).toEqual(['split', '-s', 'session:abc', '-b', 'block:new-2', '--split=right', '--label', 'o8: [t4]']);
    for (const call of calls.slice(1)) expect(call).not.toContain('control');
  });

  it('ignores panes it did not open: they are never split and never use up room', () => {
    const { calls, exec } = fakeRex([
      { block_id: 'block:shell', label: 'shell', placement: 'placed' },
      { block_id: 'block:mine', label: 'o8 dev server', placement: 'placed' },
      { block_id: 'block:notes', label: 'o8: notes', placement: 'placed' },
      { block_id: 'block:t1', label: 'o8 terminal t1', placement: 'placed' },
    ]);
    const result = openTerminalPanes({ terminals: t('t1'), limit: 1, env: rexEnv, self, exec });

    expect(result.existing).toEqual([]);
    expect(result.opened).toEqual([{ id: 't1', pane: 'block:new-1' }]);
    expect(calls[1][0]).toBe('run');
    for (const call of calls) {
      expect(call).not.toContain('block:mine');
      expect(call).not.toContain('block:notes');
      expect(call).not.toContain('block:t1');
      expect(call).not.toContain('block:shell');
    }
  });

  it('leaves terminals that already have a pane alone and splits beside them', () => {
    const { calls, exec } = fakeRex([
      { block_id: 'block:old', label: 'o8: [t1]', placement: 'placed' },
      { block_id: 'block:gone', label: 'o8: [t2]', placement: 'detached' },
    ]);
    const result = openTerminalPanes({ terminals: t('t1', 't2'), limit: 8, env: rexEnv, self, exec });

    expect(result.existing).toEqual(['t1']);
    expect(result.opened).toEqual([{ id: 't2', pane: 'block:new-1' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(0, 6)).toEqual(['split', '-s', 'session:abc', '-b', 'block:old', '--split=right']);
  });

  it('labels a remote terminal with its machine, so the same ID on two machines gets two panes', () => {
    const { calls, exec } = fakeRex([{ block_id: 'block:local', label: 'o8: [t1]' }]);
    const result = openTerminalPanes({ terminals: t('t1'), limit: 8, machineKey: 'Build', env: rexEnv, self, exec });

    expect(result.existing).toEqual([]);
    expect(result.opened).toEqual([{ id: 't1', pane: 'block:new-1' }]);
    expect(calls[1]).toContain('o8: [Build/t1]');
    expect(command(calls[1])).toEqual([...self, '--human', 'terminal', 'observe', 't1', '--machine', 'Build']);
  });

  it('puts the title first in the label and still finds the pane by its ID', () => {
    const { calls, exec } = fakeRex([{ block_id: 'block:old', label: 'o8: Fix login redirect [cortex-codex-abc]' }]);
    const result = openTerminalPanes({
      terminals: [
        { id: 'cortex-codex-abc', title: 'Renamed since the pane opened' },
        { id: 'cortex-claude-def', title: 'Update install docs' },
        { id: 'cortex-dash-123', title: 'shell' },
      ],
      limit: 8, env: rexEnv, self, exec,
    });

    expect(result.existing).toEqual(['cortex-codex-abc']);
    expect(result.opened.map((pane) => pane.id)).toEqual(['cortex-claude-def', 'cortex-dash-123']);
    expect(calls[1]).toContain('o8: Update install docs [cortex-claude-def]');
    expect(calls[2]).toContain('o8: shell [cortex-dash-123]');
  });

  it('treats a title as untrusted text: one plain, short line that cannot fake an ID', () => {
    expect(paneLabel({ id: 't1', title: '  a\x1b[31m\nb   [other-id] c  ' })).toBe('o8: a 31m b other-id c [t1]');
    expect(paneLabel({ id: 't1', title: 'x'.repeat(200) })).toBe(`o8: ${'x'.repeat(47)}… [t1]`);
    expect(paneLabel({ id: 't1' })).toBe('o8: [t1]');
    expect(paneLabel({ id: 't1', title: 'shell' }, 'Build')).toBe('o8: shell [Build/t1]');
  });

  it('keeps one pane and the known title when a terminal is listed twice', () => {
    const { calls, exec } = fakeRex();
    const result = openTerminalPanes({
      terminals: [{ id: 't1' }, { id: 't1', title: 'Named later' }],
      limit: 8, env: rexEnv, self, exec,
    });
    expect(result.opened).toHaveLength(1);
    expect(calls[1]).toContain('o8: Named later [t1]');
  });

  it('counts its own panes against the limit and reports what is left', () => {
    const { calls, exec } = fakeRex([{ block_id: 'block:old', label: 'o8: [t1]' }]);
    const result = openTerminalPanes({ terminals: t('t1', 't2', 't3', 't4'), limit: 2, env: rexEnv, self, exec });

    expect(result.opened.map((pane) => pane.id)).toEqual(['t2']);
    expect(result.remaining).toEqual(['t3', 't4']);
    expect(calls).toHaveLength(2);
  });

  it('opens one pane for a session ID the server lists twice', () => {
    const { exec } = fakeRex();
    const result = openTerminalPanes({ terminals: t('t1', 't1', 't2', 't1'), limit: 8, env: rexEnv, self, exec });
    expect(result.opened.map((pane) => pane.id)).toEqual(['t1', 't2']);
  });

  it('never passes an unsafe session ID to the multiplexer', () => {
    const { calls, exec } = fakeRex();
    const unsafe = ['--keep-open', 't1; rm -rf ~', '$(reboot)', '', 'a b'];
    const result = openTerminalPanes({ terminals: t(...unsafe, 'ok-1'), limit: 8, env: rexEnv, self, exec });

    expect(result.skipped).toEqual(unsafe);
    expect(result.opened.map((pane) => pane.id)).toEqual(['ok-1']);
    for (const call of calls) for (const bad of unsafe.filter(Boolean)) expect(call).not.toContain(bad);
  });

  it('does nothing but list when there are no live terminals', () => {
    const { calls, exec } = fakeRex();
    const result = openTerminalPanes({ terminals: t(), limit: 8, env: rexEnv, self, exec });
    expect(result).toEqual({ multiplexer: 'rex', opened: [], existing: [], skipped: [], remaining: [], closed: [], error: null });
    expect(calls).toHaveLength(1);
  });

  it('keeps what it opened when the multiplexer fails partway', () => {
    const { exec } = fakeRex([], (args, creations) => args[0] === 'split' && creations === 2);
    const result = openTerminalPanes({ terminals: t('t1', 't2', 't3', 't4'), limit: 8, env: rexEnv, self, exec });

    expect(result.opened.map((pane) => pane.id)).toEqual(['t1', 't2']);
    expect(result.remaining).toEqual(['t3', 't4']);
    expect(result.error).toBe('Rex could not split a pane.');
  });

  it('still labels the first pane when naming the tab fails', () => {
    const { calls, exec } = fakeRex([], (args) => args[0] === 'window' && args[1] === 'rename');
    const result = openTerminalPanes({ terminals: t('t1', 't2'), limit: 8, env: rexEnv, self, exec });

    expect(result.error).toBeNull();
    expect(result.opened).toHaveLength(2);
    expect(calls[1]).toContain('o8: [t1]');
  });

  it('reports a missing rex command and an unreadable pane list as errors', () => {
    const missing: PaneExec = () => {
      throw Object.assign(new Error('spawn rex ENOENT'), { code: 'ENOENT' });
    };
    expect(() => openTerminalPanes({ terminals: t('t1'), limit: 8, env: rexEnv, self, exec: missing }))
      .toThrowError(expect.objectContaining({ code: 'multiplexer_required' }));
    const garbage: PaneExec = () => 'not json';
    expect(() => openTerminalPanes({ terminals: t('t1'), limit: 8, env: rexEnv, self, exec: garbage }))
      .toThrowError(expect.objectContaining({ code: 'multiplexer_error' }));
  });
});

describe('confirmOpenedPanes', () => {
  const started = {
    multiplexer: 'rex' as const,
    opened: [{ id: 't1', pane: 'block:1' }, { id: 't2', pane: 'block:2' }],
    existing: [],
    skipped: [],
    remaining: [],
    closed: [],
    error: null,
  };

  it('keeps the result when every new pane is still there', () => {
    const exec: PaneExec = () => JSON.stringify({ blocks: [{ block_id: 'block:1' }, { block_id: 'block:2' }] });
    expect(confirmOpenedPanes(started, rexEnv, exec)).toBe(started);
  });

  it('reports a pane that closed right away, and sets the error', () => {
    const exec: PaneExec = () => JSON.stringify({ blocks: [{ block_id: 'block:1' }] });
    const result = confirmOpenedPanes(started, rexEnv, exec);
    expect(result.opened).toEqual([{ id: 't1', pane: 'block:1' }]);
    expect(result.closed).toEqual(['t2']);
    expect(result.error).toContain('closed right away');
  });

  it('does not list panes when nothing was opened, and keeps the result when the list fails', () => {
    let called = 0;
    const exec: PaneExec = () => {
      called += 1;
      throw new Error('rex failed');
    };
    const none = { ...started, opened: [] };
    expect(confirmOpenedPanes(none, rexEnv, exec)).toBe(none);
    expect(called).toBe(0);
    expect(confirmOpenedPanes(started, rexEnv, exec)).toBe(started);
  });
});
