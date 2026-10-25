import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OwnedProcessEvidence } from '@/lib/runtimes/shared/owned-session/process-identity';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

const boundary = vi.hoisted(() => ({ rows: '42 42 S\n43 42 S\n', signalIdentity: vi.fn(), processIdentity: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('@/lib/providers/child-process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: boundary.rows }),
}) }));
vi.mock('@/lib/runtimes/shared/owned-session/process-identity', () => ({
  probeOwnedSignalIdentity: boundary.signalIdentity, probeOwnedProcessIdentity: boundary.processIdentity,
}));
vi.mock('@/lib/worktree/metadata-transaction-lease', () => ({
  acquireMetadataTransactionLease: boundary.acquire, releaseMetadataTransactionLease: boundary.release,
}));

import { recoverWorkspaceServiceGroups, type WorkspaceServiceProcessState } from './service-process-recovery';

const identity = (startId: string): MetadataLockProcessIdentity => ({ version: 1, platform: 'darwin', bootId: 'fixture-boot', startId });
const member = (pid: number, startId: string): OwnedProcessEvidence => ({ pid, processIdentity: identity(startId), processIdentitySource: 'ps' });
let state: WorkspaceServiceProcessState;
let signals: ReturnType<typeof vi.spyOn>;
let write = vi.fn<(state: WorkspaceServiceProcessState) => Promise<void>>();
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.restoreAllMocks();
  boundary.signalIdentity.mockReset();
  boundary.processIdentity.mockReset();
  boundary.acquire.mockReset().mockResolvedValue({ reservationId: 'fixture' });
  boundary.release.mockReset();
  state = { state: 'stopping', supervisor: member(11, 'supervisor'),
    groups: [{ group: 42, shutdownGraceMs: 0, members: [member(42, 'original')] }], teardown: { state: 'running' } };
  boundary.rows = '42 42 S\n43 42 S\n';
  boundary.signalIdentity.mockImplementation(async (saved: OwnedProcessEvidence) => ({ state: saved.pid === 11 ? 'absent' : 'match' }));
  boundary.processIdentity.mockImplementation(async (pid: number) => ({ state: 'live', source: 'ps', identity: identity(pid === 42 ? 'original' : 'descendant') }));
  signals = vi.spyOn(process, 'kill').mockReturnValue(true);
  write = vi.fn<(state: WorkspaceServiceProcessState) => Promise<void>>(async () => {});
});

it('never promotes a replacement birth into authority to signal a reused group', async () => {
  boundary.processIdentity.mockResolvedValue({ state: 'live', source: 'ps', identity: identity('replacement') });
  await expect(recoverWorkspaceServiceGroups('/fixture', async () => state, write)).rejects.toThrow('unconfirmed');
  expect(signals).not.toHaveBeenCalled();
  expect(state.groups![0].members).toEqual([member(42, 'original')]);
});

it('requires an original trusted survivor after asynchronous descendant capture', async () => {
  let captureFinished = false;
  boundary.processIdentity.mockImplementation(async (pid: number) => {
    if (pid === 43) captureFinished = true;
    return { state: 'live', source: 'ps', identity: identity(pid === 42 ? 'original' : 'descendant') };
  });
  boundary.signalIdentity.mockImplementation(async (saved: OwnedProcessEvidence) => ({ state: saved.pid === 11 ? 'absent' : captureFinished ? 'mismatch' : 'match' }));
  await expect(recoverWorkspaceServiceGroups('/fixture', async () => state, write)).rejects.toThrow('unconfirmed');
  expect(signals).not.toHaveBeenCalled();
  expect(state.groups![0].members).toEqual([member(42, 'original')]);
});

it('holds an unknown supervisor probe without taking recovery ownership', async () => {
  boundary.signalIdentity.mockResolvedValue({ state: 'unknown', detail: 'fixture probe failed' });
  await expect(recoverWorkspaceServiceGroups('/fixture', async () => state, write)).rejects.toThrow('unconfirmed');
  expect(boundary.acquire).not.toHaveBeenCalled();
  expect(signals).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it.each(['Z', 'reaped'])('recovers owned groups when a matching supervisor cookie is %s', async status => {
  boundary.rows = `${status === 'Z' ? '11 11 Z\n' : ''}42 42 S\n43 42 S\n`;
  boundary.signalIdentity.mockResolvedValue({ state: 'match' });
  signals.mockImplementation(() => { boundary.rows = status === 'Z' ? '11 11 Z\n' : ''; return true; });
  await recoverWorkspaceServiceGroups('/fixture', async () => state, write);
  expect(signals).toHaveBeenCalledWith(-42, 'SIGTERM');
  expect(state).toMatchObject({ state: 'failed', groups: [], cleanupUnconfirmed: false, teardown: { state: 'failed' } });
});

it('does not recover a live matching supervisor', async () => {
  boundary.rows = '11 11 S\n42 42 S\n';
  boundary.signalIdentity.mockResolvedValue({ state: 'match' });
  await recoverWorkspaceServiceGroups('/fixture', async () => state, write);
  expect(boundary.acquire).not.toHaveBeenCalled();
  expect(signals).not.toHaveBeenCalled();
});
