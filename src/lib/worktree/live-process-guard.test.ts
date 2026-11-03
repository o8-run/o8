import { userInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withCloseProcessObservation } from '@/lib/runtime/close-process-observation';
import { readProcessCwdSnapshot, resetProcessCwdProbeForTesting } from '@/lib/runtime/process-cwd-snapshot';

const nativeLsof = vi.hoisted(() => vi.fn());
const proc = vi.hoisted(() => ({ link: vi.fn(), directory: vi.fn(), read: vi.fn(), platform: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(), statSync: proc.directory, lstatSync: proc.link, readFileSync: proc.read,
}));
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), platform: proc.platform,
}));
vi.mock('@/lib/providers/child-process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: nativeLsof }) };
});

import { hasLiveProcessInside, probeLiveProcessInside } from './live-process-guard';

beforeEach(() => {
  proc.platform.mockReturnValue('linux');
  proc.link.mockReturnValue({ uid: userInfo().uid });
  proc.directory.mockReturnValue({ uid: userInfo().uid });
  proc.read.mockReturnValue(`Name:\tfixture\nUid:\t${userInfo().uid}\t${userInfo().uid}\t${userInfo().uid}\t${userInfo().uid}\n`);
});

afterEach(() => {
  resetProcessCwdProbeForTesting();
  vi.restoreAllMocks();
  nativeLsof.mockReset();
  proc.link.mockReset();
  proc.directory.mockReset();
  proc.read.mockReset();
  proc.platform.mockReset();
});

describe('unreadable Linux cwd coverage through the live-process probe', () => {
  // Field order and denied-name form captured on a normal-user Linux host.
  // Resolve the login dynamically so no host identity is retained in fixtures.
  const login = userInfo().username;
  const denied = (owner?: string) => `p42\ncnode\n${owner ? `L${owner}\n` : ''}fcwd\ntunknown\nn/proc/42/cwd (readlink: Permission denied)\n`;

  for (const source of ['cwd-only', 'close-open-files'] as const) {
    async function probe(raw: string) {
      if (source === 'cwd-only') {
        return probeLiveProcessInside('/tmp/worktree', {
          readSnapshot: () => readProcessCwdSnapshot({ execFile: async () => ({ stdout: raw }) }),
        });
      }
      nativeLsof.mockResolvedValue({ stdout: raw, stderr: '' });
      const result = await withCloseProcessObservation(() => probeLiveProcessInside('/tmp/worktree'));
      expect(nativeLsof).toHaveBeenCalledWith('lsof', ['-nP', '-FpcLftn'], expect.any(Object));
      return result;
    }

    it(`${source}: refuses a same-user denied cwd with uid-owned cwd link`, async () => {
      await expect(probe(denied(login))).resolves.toEqual({
        status: 'inconclusive', reason: 'cwd unreadable for uid-owned/unknown process pid 42',
      });
    });

    it(`${source}: ignores a same-uid denied cwd with root-owned cwd link`, async () => {
      // A distinct real UID keeps the kernel ownership comparison explicit,
      // including when this hermetic test is run by a root test runner.
      vi.spyOn(await import('node:os'), 'userInfo').mockReturnValue({ ...userInfo(), uid: 1234 });
      proc.read.mockReturnValue('Name:\tany-command\nUid:\t1234\t1234\t1234\t1234\n');
      proc.directory.mockReturnValue({ uid: 1234 });
      proc.link.mockReturnValue({ uid: 0 });
      await expect(probe(denied(login))).resolves.toEqual({ status: 'clear' });
      expect(proc.link).toHaveBeenCalledWith('/proc/42/cwd');
    });

    it(`${source}: refuses when the cwd link cannot be lstat'd`, async () => {
      proc.link.mockImplementation(() => { throw new Error('unreadable proc'); });
      await expect(probe(denied(login))).resolves.toEqual({
        status: 'inconclusive', reason: 'cwd unreadable for uid-owned/unknown process pid 42',
      });
    });

    it(`${source}: refuses when the real uid cannot be read`, async () => {
      proc.link.mockReturnValue({ uid: 0 });
      proc.read.mockImplementation(() => { throw new Error('unreadable status'); });
      await expect(probe(denied(login))).resolves.toEqual({
        status: 'inconclusive', reason: 'cwd unreadable for uid-owned/unknown process pid 42',
      });
    });

    it(`${source}: keeps the denied-cwd refusal on macOS without proc`, async () => {
      proc.platform.mockReturnValue('darwin');
      proc.link.mockReturnValue({ uid: 0 });
      await expect(probe(denied(login))).resolves.toEqual({
        status: 'inconclusive', reason: 'cwd unreadable for uid-owned/unknown process pid 42',
      });
      expect(proc.link).not.toHaveBeenCalled();
      expect(proc.read).not.toHaveBeenCalled();
    });

    it(`${source}: ignores another user's denied cwd`, async () => {
      await expect(probe(denied(`${login}-other`))).resolves.toEqual({ status: 'clear' });
    });

    it(`${source}: refuses a denied cwd with absent owner`, async () => {
      await expect(probe(denied())).resolves.toEqual({
        status: 'inconclusive', reason: 'cwd unreadable for uid-owned/unknown process pid 42',
      });
    });

    it(`${source}: detects a readable same-user cwd inside the target`, async () => {
      await expect(probe(`p42\ncnode\nL${login}\nfcwd\ntDIR\nn/tmp/worktree/packages/app\n`))
        .resolves.toEqual({ status: 'live', pids: ['42'] });
    });

    it(`${source}: retains readable other-user holders`, async () => {
      await expect(probe(`p42\ncnode\nL${login}-other\nfcwd\ntDIR\nn/tmp/worktree\n`))
        .resolves.toEqual({ status: 'live', pids: ['42'] });
    });
  }
});

describe('live-process guard lsof taxonomy', () => {
  it('filters one machine-wide cwd snapshot without recursively scanning the tree', async () => {
    const readSnapshot = async () => ({
      status: 'ready' as const,
      capturedAt: Date.now(),
      rows: [{ pid: 42, cwd: '/tmp/another-tree', commandName: 'node' }],
    });

    await expect(hasLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toBe(false);
  });

  it('fails closed when the machine-wide snapshot is unavailable', async () => {
    const readSnapshot = async () => ({
      status: 'unavailable' as const,
      capturedAt: Date.now(),
      rows: [] as [],
      reason: 'permission denied',
    });

    await expect(hasLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toBe(true);
    await expect(probeLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toMatchObject({
      status: 'inconclusive',
      reason: expect.stringContaining('permission denied'),
    });
  });

  it('detects a process cwd nested anywhere under the worktree', async () => {
    const readSnapshot = async () => ({
      status: 'ready' as const,
      capturedAt: Date.now(),
      rows: [{ pid: 77, cwd: '/tmp/worktree/packages/app', commandName: 'node' }],
    });

    await expect(probeLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toEqual({
      status: 'live',
      pids: ['77'],
    });
  });
});
