import { listLanes } from '@/lib/lane/registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { completedParkedWorkspace } from '@/lib/workspace/completed-packet';
import { listParkedWorkspaceReceipts } from '@/lib/worktree/snapshot-state';
import { inboxPackets, runtimeInboxIdentity } from './subjects';
import type { InboxReadContext } from './store';
import type { InboxSubject } from './settlement-state';

export interface ParkedInboxWorkspace {
  packetId: string;
  repositoryUuid: string;
  reclaimedAvailableBytes: number | null;
}
type ParkedContext = Map<string, ParkedInboxWorkspace[]>;
const subjectKey = (subject: InboxSubject) => JSON.stringify([subject.kind, subject.workspace, subject.id]);

/** Request-local membership and receipt reads; no checkout traversal or per-row global scan. */
export function createParkedWorkspaceContext(packets?: OrchestratorPacket[], inbox?: InboxReadContext,
  visibleSubjects?: InboxSubject[]): ParkedContext {
  const context: ParkedContext = new Map();
  const receipts = listParkedWorkspaceReceipts();
  if (!receipts.length) return context;
  const canonical = packets ?? inboxPackets();
  const conversationIds = new Set(visibleSubjects?.filter(subject => subject.kind === 'conversation').map(subject => subject.id));
  const runtimeIds = new Set(visibleSubjects?.filter(subject => subject.kind === 'runtime').map(subject => subject.id));
  // This only removes unrelated inventory candidates. Exact workspace and
  // completed ownership are still checked below before projecting any receipt.
  const packetIds = new Set(canonical.filter(packet => !visibleSubjects
    || conversationIds.has(packet.orchestratorThreadId || packet.launchContext?.parentThreadId || '')
    || runtimeIds.has(packet.lane?.sessionKey ?? '')).map(packet => packet.id));
  const parked = receipts.filter(entry => packetIds.has(entry.snapshot.packetId));
  if (!parked.length) return context;
  const lanes = listLanes(new Set(parked.map(entry => entry.snapshot.packetId)));
  const parentHistories = new Map<string, ReturnType<typeof readPersistedLlmChat>>();
  const counts = new Map<string, number>();
  for (const { snapshot } of parked) counts.set(snapshot.packetId, (counts.get(snapshot.packetId) ?? 0) + 1);
  for (const { snapshot, reclaimedAvailableBytes } of parked) {
    if (counts.get(snapshot.packetId) !== 1) continue;
    const lane = lanes.find(candidate => candidate.id === snapshot.laneId);
    if (!lane || !lane.sessionKey || !completedParkedWorkspace(lane, snapshot, canonical)) continue;
    const { inboxSubject: subject } = runtimeInboxIdentity({ sessionKey: lane.sessionKey, workspace: lane.repoPath },
      canonical, lanes, inbox, parentHistories);
    const key = subjectKey(subject);
    const entries = context.get(key) ?? [];
    entries.push({ packetId: snapshot.packetId, repositoryUuid: snapshot.repositoryUuid, reclaimedAvailableBytes });
    context.set(key, entries);
  }
  return context;
}

export function parkedWorkspaceProjection(subject: InboxSubject, context: ParkedContext): { parkedWorkspaces?: ParkedInboxWorkspace[] } {
  const parkedWorkspaces = context.get(subjectKey(subject));
  return parkedWorkspaces?.length ? { parkedWorkspaces } : {};
}
