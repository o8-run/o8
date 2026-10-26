import { isUnmappedEffortLead } from '@/lib/lane/orchestrator-backends/unmapped-effort';
import { realpathSync } from 'node:fs';
import { getSqlite } from '@/lib/db';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { appendEvent, getLane } from '@/lib/lane/registry';
import { isOrchestratorBackendId, type OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { isComposerWireMode } from '@/lib/orchestrator/composer-wire';
import type { ReviewContinuationLane } from '@/lib/orchestrator/review-continuation';
import { isOrchestratorPermissionMode, supportsOutsideWorkspace } from './permission-mode';

export interface ReviewChatOrigin {
  threadId: string;
  turnId: string;
  backend: OrchestratorBackendId;
  model: string;
  effort: ThinkingEffort;
  mode: 'single' | 'fleet' | 'fusion';
  permissionMode?: import('@/lib/orchestrator/permission-mode').OrchestratorPermissionMode;
  pickedMode?: 'solo' | 'multitask' | 'fast' | 'moa' | 'fusion';
  projectId?: string;
}
export type ReviewOriginResolution = { kind: 'legacy' } | { kind: 'refused'; reason: string }
  | { kind: 'bound'; origin: ReviewChatOrigin };

/** Backends whose review turn resumes the originating thread: Codex, Claude and the built-in agent (Pi, and o8 on Pi). */
function isThreadedContinuationBackend(backend: unknown): boolean {
  return backend === 'codex' || backend === 'claude' || backend === 'pi' || backend === 'o8';
}

/** Read the exact dispatching turn, never the current operator defaults. */
export function resolveReviewChatOrigin(lane: ReviewContinuationLane): ReviewOriginResolution {
  const packets = [readOrchestratorControlPlaneState(), ...listMissionRegistryEntries({ includeArchived: true }).map(row => row.mission)]
    .flatMap(state => state.packets.filter(packet => packet.id === lane.packetId));
  if (!packets.length) return { kind: 'refused', reason: 'Review packet is unavailable.' };
  if (packets.every(packet => !packet.orchestratorThreadId && !packet.orchestratorTurnId)) return { kind: 'legacy' };
  const packet = packets[0];
  const threadId = packet.orchestratorThreadId;
  const turnId = packet.orchestratorTurnId;
  if (!threadId || threadId.length > 256 || !/^thoughts-[a-zA-Z0-9_-]+$/.test(threadId) || !turnId
    || packets.some(row => row.orchestratorThreadId !== threadId || row.orchestratorTurnId !== turnId)) {
    return { kind: 'refused', reason: 'Review packet has a missing or conflicting chat origin.' };
  }
  const projectId = (readPersistedLlmChat(threadId)?.history as { projectId?: string } | undefined)?.projectId;
  if (projectId && packets.some(row => row.projectId !== projectId)) {
    return { kind: 'refused', reason: 'Review chat project binding changed.' };
  }
  return resolveChatTurnOrigin({ threadId, turnId, repoPath: lane.repoPath });
}

/** Resolve a recorded parent turn, never infer one from a repository or current defaults. */
export function resolveChatTurnOrigin({ threadId, turnId, repoPath }: {
  threadId: string; turnId: string; repoPath: string;
}): ReviewOriginResolution {
  if (!/^thoughts-[a-zA-Z0-9_-]{1,80}$/.test(threadId) || !turnId) {
    return { kind: 'refused', reason: 'Chat origin is invalid.' };
  }
  const history = readPersistedLlmChat(threadId)?.history as (NonNullable<ReturnType<typeof readPersistedLlmChat>>['history'] & { archivedAt?: unknown; backend?: unknown; projectId?: unknown }) | undefined;
  if (history?.archivedAt || (history?.backend && !isThreadedContinuationBackend(history.backend))) {
    return { kind: 'refused', reason: 'Review chat is archived or its backend is unavailable.' };
  }
  try {
    if (!history?.repoPath || realpathSync(history.repoPath) !== realpathSync(repoPath)) {
      return { kind: 'refused', reason: 'Review chat repository binding changed or is unavailable.' };
    }
  } catch { return { kind: 'refused', reason: 'Review repository is unavailable.' }; }
  const turns = history.messages.filter(row => row && row.id === turnId);
  const turn = turns[0];
  const receipt = turn?.receipt;
  if (turns.length !== 1 || turn.role !== 'assistant' || !isOrchestratorBackendId(turn.backend)
    || typeof receipt?.leadModel !== 'string' || !receipt.leadModel.trim() || receipt.leadModel !== receipt.leadModel.trim()
    || receipt.leadModel.length > 256 || !isThinkingEffort(receipt.effort) || !isComposerWireMode(receipt.mode)
    || (receipt.permissionMode !== undefined && !isOrchestratorPermissionMode(receipt.permissionMode))
    || (receipt.permissionMode === 'outside-workspace' && !supportsOutsideWorkspace(turn.backend))
    || (turn.model && turn.model !== receipt.leadModel)) {
    return { kind: 'refused', reason: 'Review originating turn routing receipt is unavailable or conflicting.' };
  }
  if (!isThreadedContinuationBackend(turn.backend)) {
    return { kind: 'refused', reason: 'Review origin backend does not support a complete threaded continuation binding.' };
  }
  const latest = history.messages.filter(row => row && row.role === 'assistant' && row.backend).at(-1);
  if (latest?.backend !== turn.backend || (history.backend && history.backend !== turn.backend)
    || (latest.model && latest.model !== receipt.leadModel)
    || (latest.receipt && (latest.receipt.leadModel !== receipt.leadModel || latest.receipt.effort !== receipt.effort
      || latest.receipt.permissionMode !== receipt.permissionMode || latest.receipt.mode !== receipt.mode
      || latest.receipt.pickedMode !== receipt.pickedMode || latest.receipt.effortSource !== receipt.effortSource))) {
    return { kind: 'refused', reason: 'Review chat routing choice changed.' };
  }
  return { kind: 'bound', origin: { threadId, turnId, backend: turn.backend, model: receipt.leadModel,
    effort: isUnmappedEffortLead(turn.backend) || receipt.effortSource === 'service-tier' || receipt.effortSource === 'runtime-default' ? 'adaptive' : receipt.effort,
    ...(receipt.permissionMode ? { permissionMode: receipt.permissionMode } : {}),
    ...(receipt.pickedMode ? { pickedMode: receipt.pickedMode } : {}),
    ...(typeof history.projectId === 'string' ? { projectId: history.projectId } : {}),
    mode: receipt.mode === 'solo' ? 'single' : receipt.mode === 'fusion' ? 'fusion' : 'fleet' } };
}

/** Consume a review transition before launching; uncertain outcomes are never replayed. */
export function claimReviewChatContinuation(lane: ReviewContinuationLane, origin: ReviewChatOrigin): boolean {
  return getSqlite().transaction(() => {
    const currentLane = getLane(lane.id);
    if (!currentLane || currentLane.packetId !== lane.packetId || currentLane.status !== 'reviewing') return false;
    try { if (realpathSync(currentLane.repoPath) !== realpathSync(lane.repoPath)) return false; } catch { return false; }
    const db = getSqlite();
    const transition = db.prepare("SELECT id FROM lane_events WHERE lane_id = ? AND verb = 'status_change' ORDER BY timestamp DESC, rowid DESC LIMIT 1")
      .get(lane.id) as { id: string } | undefined;
    const key = transition?.id ?? lane.id;
    const claimed = db.prepare("SELECT id FROM lane_events WHERE lane_id = ? AND json_extract(payload_json, '$.event') = 'chat_review_continuation_claimed' AND json_extract(payload_json, '$.transition') = ? LIMIT 1").get(lane.id, key);
    if (claimed) return false;
    appendEvent(lane.id, 'update', 'system', { event: 'chat_review_continuation_claimed', transition: key,
      packetId: lane.packetId, threadId: origin.threadId, turnId: origin.turnId });
    return true;
  })();
}
