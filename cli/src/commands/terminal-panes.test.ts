import { describe, expect, it } from 'vitest';

import { CliError, EXIT } from '../api';
import {
  confirmOpenedPanes, followCommand, observeCommand, openTerminalPanes, paneLabel, parsePanesArgs, prepareWatcherTab, readAnswer, runningPackets, settledAfterRound, watchChanges, watchRetries, workerTerminals,
  type PaneExec,
} from './terminal-panes';

const self = ['/usr/bin/node', '/opt/o8 app/o8.mjs'];
const rexEnv = { REX_SESSION: 'session:abc' };
const t = (...ids: string[]) => ids.map((id) => ({ id }));

interface FakeBlock { block_id: string; label: string; placement?: string; window_id?: string }

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
    expect(parsePanesArgs([])).toEqual({ limit: 8, machineKey: null, watch: false, here: false });
    expect(parsePanesArgs(['--limit', '16', '--machine', 'Build box'])).toEqual({ limit: 16, machineKey: 'Build box', watch: false, here: false });
  });

  it('takes --here with or without --watch', () => {
    expect(parsePanesArgs(['--watch', '--here'])).toEqual({ limit: 8, machineKey: null, watch: true, here: true });
    expect(parsePanesArgs(['--here'])).toEqual({ limit: 8, machineKey: null, watch: false, here: true });
    expect(() => parsePanesArgs(['--here', '--here'])).toThrow();
  });

  it('takes --watch anywhere, with no value', () => {
    expect(parsePanesArgs(['--watch'])).toEqual({ limit: 8, machineKey: null, watch: true, here: false });
    expect(parsePanesArgs(['--limit', '4', '--watch'])).toEqual({ limit: 4, machineKey: null, watch: true, here: false });
    expect(parsePanesArgs(['--watch', '--machine', 'Build', '--limit', '2'])).toEqual({ limit: 2, machineKey: 'Build', watch: true, here: false });
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
    [['--watch', '--watch']],
    [['--watch', 'yes']],
    [['--limit', '--watch']],
    [['--machine', '--watch']],
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

  it('drops invisible and text-direction characters and never splits a character in two', () => {
    const hidden = String.fromCodePoint(0x202e, 0x2066, 0x2069, 0x200b, 0x200d, 0xfeff);
    expect(paneLabel({ id: 't1', title: `a${hidden}b` })).toBe('o8: a b [t1]');
    const emoji = String.fromCodePoint(0x1f600);
    const label = paneLabel({ id: 't1', title: emoji.repeat(60) });
    expect(label).toBe(`o8: ${emoji.repeat(47)}… [t1]`);
  });

  it('shortens the title, never the ID, to stay inside the label limit', () => {
    const id = `a${'i'.repeat(109)}`;
    const label = paneLabel({ id, title: 'A long worker title here' });
    expect([...label]).toHaveLength(128);
    expect(label.endsWith(`… [${id}]`)).toBe(true);
    expect(paneLabel({ id: `a${'i'.repeat(119)}`, title: 'Title' })).toBe(`o8: [a${'i'.repeat(119)}]`);
  });

  it('skips a terminal whose ID cannot fit in a label', () => {
    const { calls, exec } = fakeRex();
    const long = `a${'i'.repeat(127)}`;
    const result = openTerminalPanes({ terminals: t(long, 't1'), limit: 8, machineKey: 'Build', env: rexEnv, self, exec });
    expect(result.skipped).toEqual([long]);
    expect(result.opened.map((pane) => pane.id)).toEqual(['t1']);
    expect(calls.filter((args) => args.includes('--label'))).toHaveLength(1);
  });

  it('reads running packets from a lane list, once each, titled as o8 titles them', () => {
    expect(runningPackets([
      { packetId: 'pkt-1', status: 'reviewing', label: 'Fix login' },
      { packetId: 'pkt-2', status: 'launching' },
      { packetId: 'pkt-3', status: 'reviewing', label: 'Done already' },
      { packetId: 'pkt-4', status: 'awaiting_input', label: 'Waiting' },
      { packetId: 'pkt-1', status: 'running', label: 'Fix login, second try' },
      { packetId: null, status: 'running', label: 'A lane with no packet' },
      { packetId: 7, status: 'running' },
      { status: 'running' },
      null,
    ])).toEqual([
      { id: 'pkt-1', title: 'Fix login, second try', kind: 'packet' },
      { id: 'pkt-2', title: '', kind: 'packet' },
    ]);
    expect(runningPackets(undefined)).toEqual([]);
    expect(runningPackets({ lanes: [] })).toEqual([]);
  });

  it('lets a packet\'s newest lane decide, and keeps a title an earlier lane gave', () => {
    expect(runningPackets([
      { packetId: 'pkt-1', status: 'running', label: 'Old lane still says running' },
      { packetId: 'pkt-1', status: 'reviewing', label: 'Newest lane is done' },
    ])).toEqual([]);
    for (const ended of ['completed', 'archived', 'failed']) {
      expect(runningPackets([{ packetId: 'pkt-1', status: 'running' }, { packetId: 'pkt-1', status: ended }])).toEqual([]);
    }
    expect(runningPackets([
      { packetId: 'pkt-2', status: 'failed', label: 'Named once' },
      { packetId: 'pkt-2', status: 'running' },
    ])).toEqual([{ id: 'pkt-2', title: 'Named once', kind: 'packet' }]);
  });

  it('never passes an unsafe packet ID to the multiplexer', () => {
    const { calls, exec } = fakeRex();
    const result = openTerminalPanes({
      terminals: [{ id: '-rf', kind: 'packet' }, { id: 'a b', kind: 'packet' }, { id: 'x]', kind: 'packet' }, { id: 'pkt-ok', kind: 'packet' }],
      limit: 8, env: rexEnv, self, exec,
    });
    expect(result.skipped).toEqual(['-rf', 'a b', 'x]']);
    expect(result.opened.map((pane) => pane.id)).toEqual(['pkt-ok']);
    expect(calls.filter((args) => args.includes('--label'))).toHaveLength(1);
  });

  it('follows a running packet in its pane and observes a terminal in its pane', () => {
    const { calls, exec } = fakeRex();
    const result = openTerminalPanes({
      terminals: [{ id: 'pkt-1', title: 'Fix login', kind: 'packet' }, { id: 'cortex-dash-1', title: 'shell' }],
      limit: 8, env: { ...rexEnv, O8_API_PORT: '47120' }, self, exec,
    });
    expect(result.opened.map((pane) => pane.id)).toEqual(['pkt-1', 'cortex-dash-1']);
    const creations = calls.filter((args) => args.includes('--label'));
    expect(creations[0]).toContain('o8: Fix login [pkt-1]');
    expect(command(creations[0])).toEqual(['env', 'O8_API_PORT=47120', ...self, '--human', 'packet', 'transcript', 'pkt-1', '--follow', '--hold']);
    expect(command(creations[1])).toEqual(['env', 'O8_API_PORT=47120', ...self, '--human', 'terminal', 'observe', 'cortex-dash-1']);
    expect(followCommand({ self, env: {} }, 'pkt-1')).toEqual([...self, '--human', 'packet', 'transcript', 'pkt-1', '--follow', '--hold']);
  });

  it('finds a packet pane again by its ID, and never follows a packet on a remote machine', () => {
    const existing = fakeRex([{ block_id: 'block:a', label: 'o8: Old title [pkt-1]' }]);
    const again = openTerminalPanes({
      terminals: [{ id: 'pkt-1', title: 'New title', kind: 'packet' }], limit: 8, env: rexEnv, self, exec: existing.exec,
    });
    expect(again.existing).toEqual(['pkt-1']);
    expect(again.opened).toEqual([]);
    const remote = fakeRex();
    const far = openTerminalPanes({
      terminals: [{ id: 'pkt-1', kind: 'packet' }, { id: 'cortex-dash-1', title: 'shell' }],
      limit: 8, machineKey: 'Build', env: rexEnv, self, exec: remote.exec,
    });
    expect(far.opened.map((pane) => pane.id)).toEqual(['cortex-dash-1']);
    expect(far.skipped).toEqual([]);
    expect(remote.calls.filter((args) => args.includes('--label'))).toHaveLength(1);
    expect(command(remote.calls.filter((args) => args.includes('--label'))[0]))
      .toEqual([...self, '--human', 'terminal', 'observe', 'cortex-dash-1', '--machine', 'Build']);
  });

  it('reads worker terminals from a fleet list and leaves out the ones without a live terminal', () => {
    expect(workerTerminals([
      { terminalSessionName: 'cortex-codex-abc', terminalAvailable: true, title: 'Fix login' },
      { terminalSessionName: 'cortex-claude-def' },
      { terminalSessionName: 'cortex-codex-gone', terminalAvailable: false, title: 'Ended' },
      { terminalSessionName: '', title: 'No terminal' },
      { title: 'No terminal either' },
      { terminalSessionName: 7 },
      null,
      'text',
    ])).toEqual([
      { id: 'cortex-codex-abc', title: 'Fix login' },
      { id: 'cortex-claude-def', title: '' },
    ]);
    expect(workerTerminals(undefined)).toEqual([]);
    expect(workerTerminals({ fleetSessions: [] })).toEqual([]);
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

describe('what a watch round says', () => {
  const quiet = { opened: [], closed: [], remaining: [], skipped: [], error: null };

  it('always reports a pane that opened or closed', () => {
    const standing = new Set<string>();
    const round = { ...quiet, opened: [{ id: 'pkt-1', pane: 'block:a' }], closed: ['cortex-dash-1'] };
    expect(watchChanges(round, [], standing)).toEqual({ opened: ['pkt-1'], closed: ['cortex-dash-1'], notices: [] });
    expect(watchChanges(round, [], standing)).toEqual({ opened: ['pkt-1'], closed: ['cortex-dash-1'], notices: [] });
  });

  it('says a standing condition once, and again only after it went away and came back', () => {
    const standing = new Set<string>();
    const full = { ...quiet, remaining: ['pkt-9'], error: 'Rex could not split a pane.' };
    expect(watchChanges(full, ['Could not list running packets.'], standing).notices).toEqual([
      'not shown pkt-9', 'warning   Could not list running packets.', 'error     Rex could not split a pane.',
    ]);
    expect(watchChanges(full, ['Could not list running packets.'], standing).notices).toEqual([]);
    expect(watchChanges({ ...quiet, remaining: ['pkt-9'] }, [], standing).notices).toEqual([]);
    expect(watchChanges(quiet, [], standing).notices).toEqual([]);
    expect(watchChanges(full, [], standing).notices).toEqual(['not shown pkt-9', 'error     Rex could not split a pane.']);
  });

  it('mentions skipped terminals once, however many there are', () => {
    const standing = new Set<string>();
    expect(watchChanges({ ...quiet, skipped: ['-rf', 'a b'] }, [], standing).notices)
      .toEqual(['skipped   (session ID is unsafe or too long to label)']);
    expect(watchChanges({ ...quiet, skipped: ['-rf'] }, [], standing).notices).toEqual([]);
  });

  it('says nothing on a round where nothing changed', () => {
    expect(watchChanges(quiet, [], new Set())).toEqual({ opened: [], closed: [], notices: [] });
  });
});

describe('what a watcher opens only once', () => {
  it('settles what it opened and what closed at once, while they stay listed', () => {
    const settled = new Set<string>();
    settledAfterRound(settled, { opened: [{ id: 'pkt-1', pane: 'block:a' }], closed: ['cortex-dash-dead'] }, ['pkt-1', 'cortex-dash-dead', 'cortex-dash-2']);
    expect([...settled].sort()).toEqual(['cortex-dash-dead', 'pkt-1']);
    settledAfterRound(settled, { opened: [], closed: [] }, ['pkt-1', 'cortex-dash-dead', 'cortex-dash-2']);
    expect([...settled].sort()).toEqual(['cortex-dash-dead', 'pkt-1']);
  });

  it('forgets a thing once it is no longer listed, so it gets a pane when it comes back', () => {
    const settled = new Set(['pkt-1', 'cortex-dash-dead']);
    settledAfterRound(settled, { opened: [], closed: [] }, ['cortex-dash-dead']);
    expect([...settled]).toEqual(['cortex-dash-dead']);
    settledAfterRound(settled, { opened: [], closed: [] }, []);
    expect([...settled]).toEqual([]);
  });

  it('keeps a closed pane closed through a round whose list failed', () => {
    const settled = new Set(['pkt-1']);
    // The lane list timed out this round, so nothing is known to have stopped.
    settledAfterRound(settled, { opened: [], closed: [] }, null);
    expect([...settled]).toEqual(['pkt-1']);
    settledAfterRound(settled, { opened: [{ id: 'pkt-2', pane: 'block:b' }], closed: [] }, null);
    expect([...settled].sort()).toEqual(['pkt-1', 'pkt-2']);
  });

  it('stops a pane that dies at once from being opened every round', () => {
    const settled = new Set<string>();
    let runs = 0;
    for (let round = 0; round < 4; round += 1) {
      const listed = [{ id: 'gone-term' }].filter((terminal) => !settled.has(terminal.id));
      const { exec } = fakeRex();
      const started = openTerminalPanes({ terminals: listed, limit: 8, env: rexEnv, self, exec });
      runs += started.opened.length;
      // The pane is already gone when the round looks again.
      const result = confirmOpenedPanes(started, rexEnv, () => JSON.stringify({ blocks: [] }));
      settledAfterRound(settled, result, ['gone-term']);
    }
    expect(runs).toBe(1);
  });
});

describe('when a watcher stops', () => {
  it('stops on a mistake that waiting will not fix', () => {
    for (const code of ['machine_not_found', 'machine_disabled', 'machine_usage_only', 'unauthorized', 'invalid_args']) {
      expect(watchRetries(new CliError(code, 'x', EXIT.CONFLICT))).toBe(false);
    }
  });

  it('tries again while o8 is away', () => {
    for (const code of ['connection_refused', 'remote_terminal_error', 'terminal_unavailable']) {
      expect(watchRetries(new CliError(code, 'x', EXIT.CONFLICT))).toBe(true);
    }
  });

  it('stops on an error that is not the CLI\'s own', () => {
    expect(watchRetries(new TypeError('boom'))).toBe(false);
  });
});

describe('reading an answer', () => {
  it('reads a whole answer', async () => {
    await expect(readAnswer(new Response('{"ok":true}'))).resolves.toEqual({ ok: true });
  });

  it('treats an answer cut off mid-read as no answer', async () => {
    const cut = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"sessions":['));
        controller.error(new Error('socket closed'));
      },
    });
    await expect(readAnswer(new Response(cut))).rejects.toMatchObject({ code: 'connection_refused' });
    await expect(readAnswer(new Response('{"sessions":['))).rejects.toMatchObject({ code: 'connection_refused' });
  });
});

describe('opening panes beside the caller', () => {
  const env = { ...rexEnv, REX_BLOCK: 'block:me' };
  const me = { block_id: 'block:me', label: 'o8 watcher', window_id: 'window:w' };

  it('splits the first pane off the caller, in its tab, and tiles the rest as before', () => {
    const { calls, exec } = fakeRex([me]);
    const result = openTerminalPanes({ terminals: t('a', 'b', 'c'), limit: 8, env, self, exec, here: true });
    expect(result.opened.map((pane) => pane.pane)).toEqual(['block:new-1', 'block:new-2', 'block:new-3']);
    const created = calls.filter((args) => args[0] === 'run' || args[0] === 'split');
    expect(created.map((args) => args.slice(0, 6))).toEqual([
      ['split', '-s', 'session:abc', '-b', 'block:me', '--split=right'],
      ['split', '-s', 'session:abc', '-b', 'block:new-1', '--split=right'],
      ['split', '-s', 'session:abc', '-b', 'block:new-1', '--split=below'],
    ]);
    expect(created[0]).toContain('--ratio=75');
    // The caller's tab keeps its name; only a tab this command opens is named.
    expect(calls.some((args) => args[0] === 'window')).toBe(false);
  });

  it('opens a new tab when the caller is not a pane in this session', () => {
    for (const blocks of [[], [{ ...me, placement: 'detached' }]]) {
      const { calls, exec } = fakeRex(blocks);
      openTerminalPanes({ terminals: t('a'), limit: 8, env, self, exec, here: true });
      expect(calls.find((args) => args[0] === 'run' || args[0] === 'split')?.[0]).toBe('run');
    }
  });

  it('uses the caller as an anchor even when its pane has no label', () => {
    const { calls, exec } = fakeRex([{ block_id: 'block:me' } as unknown as FakeBlock]);
    openTerminalPanes({ terminals: t('a'), limit: 8, env, self, exec, here: true });
    expect(calls.find((args) => args[0] === 'run' || args[0] === 'split')?.slice(0, 5)).toEqual(['split', '-s', 'session:abc', '-b', 'block:me']);
  });

  it('never uses the caller as an anchor without --here', () => {
    const { calls, exec } = fakeRex([me]);
    openTerminalPanes({ terminals: t('a'), limit: 8, env, self, exec });
    expect(calls.find((args) => args[0] === 'run' || args[0] === 'split')?.[0]).toBe('run');
  });

  it('adds to existing o8 panes rather than the caller once there are some', () => {
    const { calls, exec } = fakeRex([me, { block_id: 'block:old', label: 'o8: shell [x]' }]);
    openTerminalPanes({ terminals: t('x', 'y'), limit: 8, env, self, exec, here: true });
    expect(calls.find((args) => args[0] === 'split')?.slice(3, 6)).toEqual(['-b', 'block:old', '--split=right']);
  });
});

describe('preparing a watcher tab', () => {
  const env = { ...rexEnv, REX_BLOCK: 'block:me' };

  it('names the watcher\'s tab', () => {
    const { calls, exec } = fakeRex([{ block_id: 'block:me', label: 'o8 watcher', window_id: 'window:w' }]);
    expect(prepareWatcherTab(env, exec)).toEqual({ duplicate: false });
    expect(calls).toContainEqual(['window', 'rename', '-s', 'session:abc', 'window:w', 'o8 terminals']);
  });

  it('finds a watcher already running in another pane', () => {
    const { calls, exec } = fakeRex([
      { block_id: 'block:me', label: 'o8 watcher', window_id: 'window:w2' },
      { block_id: 'block:first', label: 'o8 watcher', window_id: 'window:w1' },
    ]);
    expect(prepareWatcherTab(env, exec)).toEqual({ duplicate: true });
    expect(calls.some((args) => args[0] === 'window')).toBe(false);
  });

  it('keeps exactly one of two watchers started at the same moment', () => {
    const blocks = [
      { block_id: 'block:a', label: 'o8 watcher', window_id: 'window:1' },
      { block_id: 'block:b', label: 'o8 watcher', window_id: 'window:2' },
    ];
    const outcomes = ['block:a', 'block:b'].map((me) => prepareWatcherTab({ ...rexEnv, REX_BLOCK: me }, fakeRex(blocks).exec).duplicate);
    expect(outcomes).toEqual([false, true]);
  });

  it('leaves the tab of a watcher run by hand alone', () => {
    const { calls, exec } = fakeRex([
      { block_id: 'block:me', label: 'shell', window_id: 'window:main' },
      { block_id: 'block:a', label: 'o8 watcher', window_id: 'window:1' },
    ]);
    expect(prepareWatcherTab(env, exec)).toEqual({ duplicate: false });
    expect(calls.some((args) => args[0] === 'window')).toBe(false);
  });

  it('ignores a closed watcher, and lets the watcher run when Rex fails', () => {
    const closed = fakeRex([
      { block_id: 'block:me', label: 'o8 watcher' },
      { block_id: 'block:old', label: 'o8 watcher', placement: 'detached' },
    ]);
    expect(prepareWatcherTab(env, closed.exec)).toEqual({ duplicate: false });
    const failing = fakeRex([], () => true);
    expect(prepareWatcherTab(env, failing.exec)).toEqual({ duplicate: false });
    expect(prepareWatcherTab(rexEnv, failing.exec)).toEqual({ duplicate: false });
  });
});
