import { describe, expect, it } from 'vitest';

import { EXIT } from '../api';
import { observeCommand, openTerminalPanes, type PaneExec } from './terminal-panes';

const self = ['/usr/bin/node', '/opt/o8/o8.mjs'];
const rexEnv = { REX_SESSION: 'session:abc' };

/** A fake `rex` that records every call and hands out pane IDs in order. */
function fakeRex(blocks: Array<{ block_id: string; label: string; placement?: string }> = []) {
  const calls: string[][] = [];
  let next = 1;
  const exec: PaneExec = (file, args) => {
    expect(file).toBe('rex');
    calls.push(args);
    if (args[0] === 'block' && args[1] === 'ls') return JSON.stringify({ blocks });
    if (args[0] === 'block' && args[1] === 'rename') return '';
    const id = `block:new-${next}`;
    next += 1;
    return JSON.stringify({ block_ids: [id] });
  };
  return { calls, exec };
}

function command(args: string[]): string[] {
  return args.slice(args.indexOf('--') + 1);
}

describe('observeCommand', () => {
  it('runs this CLI as a read-only observer and passes only safe routing values', () => {
    expect(observeCommand({ self, env: {}, machineKey: null }, 'cortex-dash-1')).toEqual([
      ...self, '--human', 'terminal', 'observe', 'cortex-dash-1',
    ]);
    expect(observeCommand({
      self,
      machineKey: 'Build',
      env: {
        O8_API_PORT: '47120',
        O8_WS_PORT: '47125',
        O8_DATA_DIR: '/tmp/o8 data; rm -rf',
        O8_API_TOKEN: 'secret-token',
        O8_WORKER_TOKEN: 'secret-worker',
      },
    }, 'cortex-dash-1')).toEqual([
      'env', 'O8_API_PORT=47120', 'O8_WS_PORT=47125',
      ...self, '--human', 'terminal', 'observe', 'cortex-dash-1', '--machine', 'Build',
    ]);
  });
});

describe('openTerminalPanes', () => {
  it('refuses to run outside Rex and makes no call', () => {
    const { calls, exec } = fakeRex();
    expect(() => openTerminalPanes({ sessionIds: ['a'], limit: 8, env: {}, self, exec }))
      .toThrowError(expect.objectContaining({ code: 'multiplexer_required', exit: EXIT.INVALID_ARGS }));
    expect(calls).toEqual([]);
  });

  it('opens a tab for the first terminal, then tiles the rest as splits', () => {
    const { calls, exec } = fakeRex();
    const result = openTerminalPanes({ sessionIds: ['t1', 't2', 't3', 't4'], limit: 8, env: rexEnv, self, exec });

    expect(result.opened).toEqual([
      { id: 't1', pane: 'block:new-1' },
      { id: 't2', pane: 'block:new-2' },
      { id: 't3', pane: 'block:new-3' },
      { id: 't4', pane: 'block:new-4' },
    ]);
    expect(calls[0]).toEqual(['block', 'ls', '-s', 'session:abc', '--json']);
    expect(calls[1].slice(0, 5)).toEqual(['window', 'new', '-s', 'session:abc', 'o8 workers']);
    expect(calls[1]).toContain('--focus=false');
    expect(calls[1]).toContain('--keep-open');
    expect(command(calls[1])).toEqual([...self, '--human', 'terminal', 'observe', 't1']);
    expect(calls[2]).toEqual(['block', 'rename', '-s', 'session:abc', 'block:new-1', 'o8 t1']);
    // t2 splits t1 to the right, t3 splits t1 below, t4 splits t2 to the right.
    expect(calls[3].slice(0, 8)).toEqual(['split', '-s', 'session:abc', '-b', 'block:new-1', '--split=right', '--label', 'o8 t2']);
    expect(calls[4].slice(0, 8)).toEqual(['split', '-s', 'session:abc', '-b', 'block:new-1', '--split=below', '--label', 'o8 t3']);
    expect(calls[5].slice(0, 8)).toEqual(['split', '-s', 'session:abc', '-b', 'block:new-2', '--split=right', '--label', 'o8 t4']);
    for (const call of calls.slice(1)) expect(call).not.toContain('control');
  });

  it('leaves terminals that already have a pane alone and splits beside them', () => {
    const { calls, exec } = fakeRex([
      { block_id: 'block:shell', label: 'shell', placement: 'placed' },
      { block_id: 'block:old', label: 'o8 t1', placement: 'placed' },
      { block_id: 'block:gone', label: 'o8 t2', placement: 'detached' },
    ]);
    const result = openTerminalPanes({ sessionIds: ['t1', 't2'], limit: 8, env: rexEnv, self, exec });

    expect(result.existing).toEqual(['t1']);
    expect(result.opened).toEqual([{ id: 't2', pane: 'block:new-1' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(0, 6)).toEqual(['split', '-s', 'session:abc', '-b', 'block:old', '--split=right']);
  });

  it('labels a remote terminal with its machine, so the same ID on two machines gets two panes', () => {
    const { calls, exec } = fakeRex([{ block_id: 'block:local', label: 'o8 t1' }]);
    const result = openTerminalPanes({ sessionIds: ['t1'], limit: 8, machineKey: 'Build', env: rexEnv, self, exec });

    expect(result.existing).toEqual([]);
    expect(result.opened).toEqual([{ id: 't1', pane: 'block:new-1' }]);
    expect(calls[1]).toContain('o8 Build/t1');
    expect(command(calls[1])).toEqual([...self, '--human', 'terminal', 'observe', 't1', '--machine', 'Build']);
  });

  it('counts existing panes against the limit and reports what is left', () => {
    const { calls, exec } = fakeRex([{ block_id: 'block:old', label: 'o8 t1' }]);
    const result = openTerminalPanes({ sessionIds: ['t1', 't2', 't3', 't4'], limit: 2, env: rexEnv, self, exec });

    expect(result.opened.map((pane) => pane.id)).toEqual(['t2']);
    expect(result.remaining).toEqual(['t3', 't4']);
    expect(calls).toHaveLength(2);
  });

  it('never passes an unsafe session ID to the multiplexer', () => {
    const { calls, exec } = fakeRex();
    const unsafe = ['--label', 't1; rm -rf ~', '$(reboot)', '', 'a b'];
    const result = openTerminalPanes({ sessionIds: [...unsafe, 'ok-1'], limit: 8, env: rexEnv, self, exec });

    expect(result.skipped).toEqual(unsafe);
    expect(result.opened.map((pane) => pane.id)).toEqual(['ok-1']);
    for (const call of calls) for (const bad of unsafe.filter(Boolean)) expect(call).not.toContain(bad);
  });

  it('does nothing but list when there are no live terminals', () => {
    const { calls, exec } = fakeRex();
    const result = openTerminalPanes({ sessionIds: [], limit: 8, env: rexEnv, self, exec });
    expect(result).toEqual({ multiplexer: 'rex', opened: [], existing: [], skipped: [], remaining: [] });
    expect(calls).toHaveLength(1);
  });

  it('reports a missing rex command and an unreadable reply as errors', () => {
    const missing: PaneExec = () => {
      throw Object.assign(new Error('spawn rex ENOENT'), { code: 'ENOENT' });
    };
    expect(() => openTerminalPanes({ sessionIds: ['t1'], limit: 8, env: rexEnv, self, exec: missing }))
      .toThrowError(expect.objectContaining({ code: 'multiplexer_required' }));
    const garbage: PaneExec = () => 'not json';
    expect(() => openTerminalPanes({ sessionIds: ['t1'], limit: 8, env: rexEnv, self, exec: garbage }))
      .toThrowError(expect.objectContaining({ code: 'multiplexer_error' }));
  });
});
