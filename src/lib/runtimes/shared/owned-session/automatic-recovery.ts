import { packetAutomaticRecoveryHoldReason, packetCompletionHoldReason } from '@/lib/lane/packet-stop-hold';
import { withOwnedActionGuard } from './action-admission';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ownedRoots, readOwnedSessionRecord } from '../owned-session-index';
import { createOwnedSessionIo, type OwnedSessionIo } from './session-io';
import type { OwnedSessionRecord } from './types';
import { refuseOwnedSingleAttemptResume } from './execution-policy';

export class AutomaticRecoveryRefusedError extends Error {}

type SurfaceLock = <T>(surfaceId: string, operation: () => Promise<T>) => Promise<T>;
const stores = new Map<string, { io: OwnedSessionIo; lock: SurfaceLock }>();
const recoveryRequest = new AsyncLocalStorage<{ surfaceId: string; runId: string; active: boolean }>();

export function registerOwnedRecoveryStore(prefix: string, io: OwnedSessionIo, lock: SurfaceLock): void {
  stores.set(prefix, { io, lock });
}

export function currentRecoveryRun(session: OwnedSessionRecord) {
  return session.activeRun ?? session.recentRuns[0];
}

export function recoveryPacketHoldReason(session: OwnedSessionRecord): string | null {
  return session.packetId ? packetAutomaticRecoveryHoldReason(session.packetId) : null;
}

export function assertRecoveryPacketAdmission(session: OwnedSessionRecord | null): void {
  const reason = session && recoveryPacketHoldReason(session);
  if (reason) throw new AutomaticRecoveryRefusedError(`Automatic recovery refused: ${reason}. Use an explicit governed recovery.`);
}

export function recoveryInterrupted(session: OwnedSessionRecord): boolean {
  const run = currentRecoveryRun(session);
  return Boolean(run && (run.outcome === 'interrupted' || run.interruptRequestedAt));
}

/** Read durable current-generation evidence, without refreshing or retrying it. */
async function readOwnedState(surfaceId: string, options?: { includeArchived?: boolean }, completion = false) {
  const root = ownedRoots().find(entry => surfaceId.startsWith(entry.marker));
  if (!root) return { owned: false as const };
  const store = stores.get(root.marker);
  const io = store?.io ?? createOwnedSessionIo({ root: root.root, surfacePrefix: root.marker, invalidateFleetCache: () => {} });
  const live = await io.findSession(surfaceId).catch(() => null);
  const session = live ?? (options?.includeArchived ? await readOwnedSessionRecord(surfaceId) : null);
  const recoveryHoldReason = session ? recoveryPacketHoldReason(session) : null;
  const packetHoldReason = completion && session?.packetId ? packetCompletionHoldReason(session.packetId) : recoveryHoldReason;
  return { owned: true as const, packetHoldReason, runId: session ? currentRecoveryRun(session)?.id : undefined,
    startedAt: session ? currentRecoveryRun(session)?.startedAt : undefined,
    finishedAt: session ? currentRecoveryRun(session)?.finishedAt : undefined,
    automaticRecoveryAllowed: Boolean(live && live.executionPolicy === undefined && !recoveryHoldReason),
    outcome: session ? currentRecoveryRun(session)?.outcome : undefined,
    interrupted: session ? recoveryInterrupted(session) : false };
}

export function readOwnedRecoveryState(surfaceId: string, options?: { includeArchived?: boolean }) {
  return readOwnedState(surfaceId, options);
}

/** Completion observation never grants recovery admission. */
export function readOwnedCompletionState(surfaceId: string) {
  return readOwnedState(surfaceId, undefined, true);
}

export function assertAutomaticRecoveryGeneration(session: OwnedSessionRecord | null, runId: string): void {
  assertRecoveryPacketAdmission(session);
  if (session?.executionPolicy !== undefined) {
    throw new AutomaticRecoveryRefusedError('Automatic recovery refused: this is a single-attempt worker.');
  }
  if (!session || session.detachedAt || session.orphanedAt
    || currentRecoveryRun(session)?.id !== runId || recoveryInterrupted(session)) {
    throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the current run changed or was interrupted. Use an explicit resume.');
  }
}

export function requestedAutomaticRecoveryRun(surfaceId: string): string | undefined {
  const request = recoveryRequest.getStore();
  if (!request?.active) return undefined;
  if (request.surfaceId !== surfaceId) throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the owned target changed.');
  return request?.runId;
}

export function withAutomaticRecoveryRequest<T>(surfaceId: string, runId: string, operation: () => Promise<T>): Promise<T> {
  if (![...stores.keys()].some(prefix => surfaceId.startsWith(prefix))) {
    throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the owned session lock is unavailable.');
  }
  const request = { surfaceId, runId, active: true };
  return recoveryRequest.run(request, async () => {
    try { return await withOwnedActionGuard(assertRecoveryPacketAdmission, operation); }
    finally { request.active = false; }
  });
}

/** A restrictive generation fence, never an authorization or an explicit resume. */
export async function withOwnedAutomaticRecovery<T>(surfaceId: string, runId: string, operation: () => Promise<T>): Promise<T> {
  const store = [...stores.entries()].find(([prefix]) => surfaceId.startsWith(prefix))?.[1];
  if (!store) throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the owned session lock is unavailable.');
  return store.lock(surfaceId, async () => {
    const current = await store.io.findSession(surfaceId);
    refuseOwnedSingleAttemptResume(current);
    assertAutomaticRecoveryGeneration(current, runId);
    return withOwnedActionGuard(() => assertRecoveryPacketAdmission(current), operation);
  });
}
