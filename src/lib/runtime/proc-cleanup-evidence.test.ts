import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  run: vi.fn(),
  files: new Map<string, string>(),
  directories: new Map<string, string[]>(),
  links: new Map<string, string>(),
  failures: new Map<string, string>(),
}));

vi.mock('@/lib/providers/child-process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: native.run }) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const read = (values: Map<string, unknown>, key: string) => {
    const code = native.failures.get(key) ?? (values.has(key) ? null : 'ENOENT');
    if (code) throw Object.assign(new Error('proc evidence unavailable'), { code });
    return values.get(key);
  };
  return {
    ...actual,
    readFile: async (key: string, ...args: unknown[]) => key.startsWith('/proc/')
      ? read(native.files, key) : Reflect.apply(actual.readFile, actual, [key, ...args]),
    readdir: async (key: string, ...args: unknown[]) => key === '/proc' || key.startsWith('/proc/')
      ? read(native.directories, key) : Reflect.apply(actual.readdir, actual, [key, ...args]),
    opendir: async (key: string, ...args: unknown[]) => key.startsWith('/proc/')
      ? { async *[Symbol.asyncIterator]() {
        for (const name of read(native.directories, key) as string[]) yield { name };
      } } : Reflect.apply(actual.opendir, actual, [key, ...args]),
    readlink: async (key: string, ...args: unknown[]) => key.startsWith('/proc/')
      ? read(native.links, key) : Reflect.apply(actual.readlink, actual, [key, ...args]),
  };
});

import { withCloseProcessObservation } from './close-process-observation';
import { readCloseOpenFileRows } from './process-open-files-snapshot';
import { resetProcessCwdProbeForTesting } from './process-cwd-snapshot';
import { checkWorktreeRemoval } from '@/lib/worktree/live-process-guard';
import { probeOwnedSessionProcessQuiescence } from '@/lib/workspace/process-probes';
import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';

const pid = process.pid;
const task = `/proc/${pid}/task/${pid}`;
const workspace = '/tmp/o8-proc-cleanup-workspace';

beforeEach(() => {
  resetProcessCwdProbeForTesting();
  native.files.clear(); native.directories.clear(); native.links.clear(); native.failures.clear();
  native.run.mockReset().mockRejectedValue(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }));
  native.files.set('/proc/mounts', 'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n');
  native.directories.set('/proc', ['self', String(pid)]);
  native.directories.set(`/proc/${pid}/task`, [String(pid)]);
  native.files.set(`${task}/stat`, `${pid} (worker) S 1 ${pid} ${pid} 0 -1 0 ${'0 '.repeat(12)}100 0\n`);
  native.files.set(`${task}/comm`, 'worker\n');
  native.links.set('/proc/self/ns/mnt', 'mnt:[1]');
  native.links.set(`/proc/${pid}/ns/mnt`, 'mnt:[1]');
  native.links.set(`${task}/ns/mnt`, 'mnt:[1]');
  native.links.set(`${task}/cwd`, '/tmp');
  native.links.set(`${task}/root`, '/');
  native.links.set(`${task}/exe`, '/usr/bin/worker');
  native.directories.set(`${task}/fd`, ['0', '7']);
  native.links.set(`${task}/fd/0`, '/dev/null');
  native.links.set(`${task}/fd/7`, `${workspace}/open.txt (deleted)`);
  native.files.set(`${task}/maps`, `1000-2000 r--p 00000000 00:01 42 ${workspace}/mapped.txt\n`);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform !== 'linux')('cleanup without lsof', () => {
  it('allows removal only after the real guard obtains complete proc evidence', async () => {
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' })).toEqual({ allowed: true });
    expect(native.run).toHaveBeenCalledWith('lsof', expect.any(Array), expect.any(Object));
  });

  it('uses the fallback in owned-session quiescence and refuses lost evidence', async () => {
    const surfaceId = 'proc-cleanup:session';
    registerOwnedSessionLifecycleHandler({
      runtimeId: 'proc-test', surfaceIdPrefix: 'proc-cleanup:', commandLabel: 'proc-test',
      resolveRoot: () => workspace,
      sessionState: async () => 'active',
      archiveSession: async () => ({ archived: false, note: 'unused' }),
      rebindWorkspace: async () => ({ status: 'missing', receipt: null, note: 'unused' }),
      getWorkspaceBinding: async () => ({
        surfaceId, runtimeId: 'proc-test', sessionState: 'active',
        binding: { logicalWorkspaceId: 'packet:proc-test', repositoryUuid: 'proc-test',
          packetId: 'proc-test', cwd: workspace, version: 1, verifiedAt: new Date().toISOString() },
        activeRun: null, retainedRuns: [], retainedRunsComplete: true, retainedRunTotal: 0,
      }),
    });
    expect((await probeOwnedSessionProcessQuiescence(surfaceId, workspace)).state).toBe('quiescent');
    native.failures.set(`${task}/cwd`, 'EACCES');
    const refused = await probeOwnedSessionProcessQuiescence(surfaceId, workspace);
    expect(refused.state).toBe('unknown');
    expect(refused.probes).toContainEqual(expect.objectContaining({ primitive: 'filesystem_users', state: 'unknown' }));
  });

  it('refuses a cwd holder through the close-scoped removal guard', async () => {
    native.links.set(`${task}/cwd`, workspace);
    await withCloseProcessObservation(async () => {
      expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
        .toEqual({ allowed: false, refusal: 'live' });
      const rows = await readCloseOpenFileRows();
      expect(rows).toContainEqual(expect.objectContaining({ pid, descriptor: '7', file: `${workspace}/open.txt` }));
      expect(rows).toContainEqual(expect.objectContaining({ pid, descriptor: 'mem', file: `${workspace}/mapped.txt` }));
    });
  });

  it('retains a workspace held only by a sibling task cwd', async () => {
    const tid = pid + 1;
    const sibling = `/proc/${pid}/task/${tid}`;
    native.directories.set(`/proc/${pid}/task`, [String(pid), String(tid)]);
    for (const [key, value] of [...native.files]) {
      if (key.startsWith(`${task}/`)) native.files.set(key.replace(task, sibling),
        key.endsWith('/stat') ? value.replace(String(pid), String(tid)) : value);
    }
    for (const [key, value] of [...native.links]) {
      if (key.startsWith(`${task}/`)) native.links.set(key.replace(task, sibling), value);
    }
    native.directories.set(`${sibling}/fd`, ['0', '7']);
    native.links.set(`${sibling}/cwd`, workspace);
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'live' });
  });

  it.each(['EACCES', 'ENOENT'])('refuses incomplete evidence when an fd cannot be read (%s)', async (code) => {
    native.failures.set(`${task}/fd/7`, code);
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'inconclusive' });
  });

  it('refuses missing proc evidence', async () => {
    native.failures.set('/proc', 'EACCES');
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'inconclusive' });
  });

  it.each(['cwd', 'exe', 'maps', 'stat'])('refuses incomplete %s evidence in a close observation', async (leaf) => {
    native.failures.set(`${task}/${leaf}`, 'EACCES');
    await withCloseProcessObservation(async () => {
      expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
        .toEqual({ allowed: false, refusal: 'inconclusive' });
    });
  });

  it.each(['', 'incomplete mapping'])('refuses empty or malformed mapping coverage (%s)', async (maps) => {
    native.files.set(`${task}/maps`, maps);
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'inconclusive' });
  });

  it('refuses a task in an unobserved filesystem namespace', async () => {
    native.links.set(`${task}/ns/mnt`, 'mnt:[2]');
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'inconclusive' });
  });

  it('refuses hidden processes and empty enumeration', async () => {
    native.files.set('/proc/mounts', 'proc /proc proc rw,hidepid=2 0 0\n');
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'inconclusive' });
    native.files.set('/proc/mounts', 'proc /proc proc rw 0 0\n');
    native.directories.set('/proc', []);
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'inconclusive' });
  });

  it('does not fall back after permission errors from an installed lsof', async () => {
    native.run.mockRejectedValue(Object.assign(new Error('lsof denied'), { code: 'EACCES' }));
    expect(await checkWorktreeRemoval(workspace, { logPrefix: 'proc-test' }))
      .toEqual({ allowed: false, refusal: 'inconclusive' });
  });
});
