import type { OrchestratorRuntime, WorkerLaunchContext } from './types';

export interface OutsideWorkerSplitRequest {
  sessionKey: string;
  runtime: OrchestratorRuntime;
  repoPath: string;
  packetId?: string | null;
  laneId?: string | null;
  title?: string | null;
  branch?: string | null;
  launchContext?: WorkerLaunchContext | null;
}

export interface OutsideWorkerSplitClaim {
  tabId: string;
  repoPath: string;
  workspaceId?: string | null;
  threadId?: string | null;
}

export interface OutsideWorkerSplitMountSurface {
  workspaceId: string;
  getPlacement(): { repoPaths: string[]; threadIds: string[]; active?: boolean };
  mount(request: OutsideWorkerSplitRequest): string | null;
}

interface QueuedOutsideWorkerSplit {
  request: OutsideWorkerSplitRequest;
  claimedBy: string | null;
  deliveredSessionKey: string | null;
  mountRequestedBy: string | null;
}

const queued = new Map<string, QueuedOutsideWorkerSplit>();
const listeners = new Set<() => void>();
const mountSurfaces = new Map<string, OutsideWorkerSplitMountSurface>();
let mountOfferScheduled = false;

function normalizeId(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function normalizeRepoPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

function requestIdentity(request: OutsideWorkerSplitRequest): string {
  const packetId = normalizeId(request.packetId);
  if (packetId) return `packet:${packetId}`;
  const laneId = normalizeId(request.laneId);
  if (laneId) return `lane:${laneId}`;
  return `session:${request.sessionKey.trim()}`;
}

function requestsShareIdentity(
  left: OutsideWorkerSplitRequest,
  right: OutsideWorkerSplitRequest,
): boolean {
  const leftPacketId = normalizeId(left.packetId);
  const rightPacketId = normalizeId(right.packetId);
  const sameSession = left.sessionKey === right.sessionKey;
  const leftLaneId = normalizeId(left.laneId);
  const rightLaneId = normalizeId(right.laneId);
  const sameLane = Boolean(leftLaneId && rightLaneId && leftLaneId === rightLaneId);
  if (leftPacketId && rightPacketId) return leftPacketId === rightPacketId;
  if (leftPacketId || rightPacketId) return sameLane || sameSession;
  if (leftLaneId && rightLaneId) return sameLane;
  return sameSession;
}

/** Stable placement key used when an outside launch has no desktop parent. */
export function outsideWorkerPlacementKey(request: Pick<OutsideWorkerSplitRequest, 'repoPath' | 'launchContext'>): string {
  const workspaceId = normalizeId(request.launchContext?.parentWorkspaceId);
  const threadId = normalizeId(request.launchContext?.parentThreadId);
  const repoPath = normalizeRepoPath(request.repoPath);
  if (workspaceId || threadId) {
    return `parent:${workspaceId}:${threadId}:repo:${repoPath}`;
  }
  return `repo:${repoPath}`;
}

function claimMatchesRequest(
  claim: OutsideWorkerSplitClaim,
  request: OutsideWorkerSplitRequest,
): boolean {
  if (normalizeRepoPath(claim.repoPath) !== normalizeRepoPath(request.repoPath)) return false;
  const parentWorkspaceId = normalizeId(request.launchContext?.parentWorkspaceId);
  const parentThreadId = normalizeId(request.launchContext?.parentThreadId);
  if (parentWorkspaceId && parentWorkspaceId !== normalizeId(claim.workspaceId)) return false;
  if (parentThreadId && parentThreadId !== normalizeId(claim.threadId)) return false;
  return true;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function mountSurfaceForRequest(
  request: OutsideWorkerSplitRequest,
): OutsideWorkerSplitMountSurface | null {
  const surfaces = [...mountSurfaces.values()]
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  const parentWorkspaceId = normalizeId(request.launchContext?.parentWorkspaceId);
  const parentThreadId = normalizeId(request.launchContext?.parentThreadId);
  if (parentWorkspaceId) {
    return mountSurfaces.get(parentWorkspaceId) ?? null;
  }
  if (parentThreadId) {
    return surfaces.find((surface) => surface.getPlacement().threadIds.some((threadId) => (
      normalizeId(threadId) === parentThreadId
    ))) ?? null;
  }
  const repoPath = normalizeRepoPath(request.repoPath);
  return surfaces.find((surface) => surface.getPlacement().repoPaths.some((path) => (
    normalizeRepoPath(path) === repoPath
  ))) ?? surfaces.find((surface) => surface.getPlacement().active === true) ?? surfaces[0] ?? null;
}

function offerQueuedMounts(): void {
  for (const entry of queued.values()) {
    if (entry.claimedBy || entry.mountRequestedBy) continue;
    const surface = mountSurfaceForRequest(entry.request);
    if (!surface) continue;
    entry.mountRequestedBy = surface.workspaceId;
    try {
      if (!surface.mount(entry.request)) entry.mountRequestedBy = null;
    } catch {
      entry.mountRequestedBy = null;
    }
  }
}

function scheduleQueuedMountOffer(): void {
  if (mountOfferScheduled) return;
  mountOfferScheduled = true;
  queueMicrotask(() => {
    mountOfferScheduled = false;
    offerQueuedMounts();
  });
}

function mergeRequestIdentity(
  previous: OutsideWorkerSplitRequest | undefined,
  next: OutsideWorkerSplitRequest,
): OutsideWorkerSplitRequest {
  if (!previous) return next;
  const previousContext = previous.launchContext;
  const nextContext = next.launchContext;
  const launchContext = nextContext ? {
    ...nextContext,
    parentWorkspaceId: normalizeId(nextContext.parentWorkspaceId)
      || previousContext?.parentWorkspaceId,
    parentThreadId: normalizeId(nextContext.parentThreadId)
      || previousContext?.parentThreadId,
  } : previousContext;
  return {
    ...next,
    packetId: normalizeId(next.packetId) || previous.packetId,
    laneId: normalizeId(next.laneId) || previous.laneId,
    ...(launchContext ? { launchContext } : {}),
  };
}

export function queueOutsideWorkerSplit(request: OutsideWorkerSplitRequest): void {
  const proposedIdentity = requestIdentity(request);
  const matched = [...queued.entries()].find(([key, entry]) => (
    key === proposedIdentity
    || requestsShareIdentity(entry.request, request)
  ));
  const mergedRequest = mergeRequestIdentity(matched?.[1].request, request);
  const identity = requestIdentity(mergedRequest);
  if (matched && matched[0] !== identity) queued.delete(matched[0]);
  queued.set(identity, {
    request: mergedRequest,
    claimedBy: matched?.[1].claimedBy ?? null,
    deliveredSessionKey: matched?.[1].deliveredSessionKey ?? null,
    mountRequestedBy: matched?.[1].mountRequestedBy ?? null,
  });
  offerQueuedMounts();
  notify();
}

export function registerOutsideWorkerSplitMountSurface(
  surface: OutsideWorkerSplitMountSurface,
): () => void {
  const workspaceId = surface.workspaceId.trim();
  if (!workspaceId) return () => {};
  mountSurfaces.set(workspaceId, { ...surface, workspaceId });
  // A split workspace registers each pane in one React effect flush. Defer the
  // offer by one microtask so the broker can see which pane is active instead
  // of binding to whichever passive effect happened to run first.
  scheduleQueuedMountOffer();
  return () => {
    if (mountSurfaces.get(workspaceId)?.mount !== surface.mount) return;
    mountSurfaces.delete(workspaceId);
    for (const entry of queued.values()) {
      if (entry.mountRequestedBy === workspaceId && !entry.claimedBy) {
        entry.mountRequestedBy = null;
      }
    }
    offerQueuedMounts();
  };
}

export function claimOutsideWorkerSplits(
  claim: OutsideWorkerSplitClaim,
): OutsideWorkerSplitRequest[] {
  const tabId = claim.tabId.trim();
  if (!tabId) return [];
  const claimed: OutsideWorkerSplitRequest[] = [];
  let changed = false;
  for (const entry of queued.values()) {
    if (!claimMatchesRequest(claim, entry.request)) continue;
    if (entry.claimedBy && entry.claimedBy !== tabId) continue;
    if (entry.claimedBy === tabId && entry.deliveredSessionKey === entry.request.sessionKey) continue;
    entry.claimedBy = tabId;
    entry.deliveredSessionKey = entry.request.sessionKey;
    changed = true;
    claimed.push(entry.request);
  }
  if (changed) notify();
  return claimed;
}

export function releaseOutsideWorkerSplits(tabId: string): void {
  let changed = false;
  for (const entry of queued.values()) {
    if (entry.claimedBy !== tabId) continue;
    entry.claimedBy = null;
    entry.mountRequestedBy = null;
    changed = true;
  }
  if (changed) {
    offerQueuedMounts();
    notify();
  }
}

export function removeOutsideWorkerSplits(sessionKeys: Iterable<string>): void {
  const keys = new Set(sessionKeys);
  let changed = false;
  for (const [identity, entry] of queued) {
    if (!keys.has(entry.request.sessionKey)) continue;
    changed = queued.delete(identity) || changed;
  }
  if (changed) notify();
}

export function outsideWorkerSessionKeysForLane(laneId: string): string[] {
  return [...queued.values()]
    .filter((entry) => entry.request.laneId === laneId)
    .map((entry) => entry.request.sessionKey);
}

export function outsideWorkerSessionKeysForPacketIds(packetIds: ReadonlySet<string>): string[] {
  return [...queued.values()]
    .filter((entry) => entry.request.packetId && packetIds.has(entry.request.packetId))
    .map((entry) => entry.request.sessionKey);
}

export function outsideWorkerSessionKeysForSettledPackets(
  packets: ReadonlyArray<{ id: string; status: string; releaseState: string; archivedAt?: string | null; standingLaneId?: string }>,
): string[] {
  return outsideWorkerSessionKeysForPacketIds(new Set(packets
    .filter((packet) => !packet.standingLaneId && (packet.releaseState === 'released' || packet.status === 'archived' || Boolean(packet.archivedAt)))
    .map((packet) => packet.id)));
}

export function subscribeOutsideWorkerSplits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetOutsideWorkerSplitsForTest(): void {
  queued.clear();
  listeners.clear();
  mountSurfaces.clear();
  mountOfferScheduled = false;
}
