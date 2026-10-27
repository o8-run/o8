import { getLane } from '@/lib/lane/registry';
import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import type { OwnedRunMode, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

export type WorkerMemorySession = Pick<OwnedSessionRecord, 'surfaceId' | 'laneId' | 'packetId' | 'cwd' | 'threadId' | 'initialPrompt' | 'promptMemoryRevision'>;

/** Opaque old prompts/transcripts cannot be safely string-redacted after a forget. */
export function workerMemoryIsCurrent(session: WorkerMemorySession): boolean {
  return (session.promptMemoryRevision ?? '0') === readMemoryRevision();
}

export function workerMemoryNeedsRefresh(session: WorkerMemorySession): boolean {
  return Boolean(session.packetId || (session.laneId && getLane(session.laneId)?.packetId)) && !workerMemoryIsCurrent(session);
}

/** Rebuild from task authority and current recall readers; never reuse the old assembled prompt. */
export async function rebuildWorkerMemoryContext(session: WorkerMemorySession): Promise<string> {
  const lane = session.laneId ? getLane(session.laneId) : null;
  const packetId = session.packetId ?? lane?.packetId;
  if (!packetId) throw new Error('Cannot rebuild forgotten worker context without its packet identity.');
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const { findMissionRegistryEntryByPacketId } = await import('@/lib/orchestrator/mission-registry');
  const current = readOrchestratorControlPlaneState();
  const state = current.packets.some(packet => packet.id === packetId) ? current
    : findMissionRegistryEntryByPacketId(packetId)?.mission;
  const packet = state?.packets.find(candidate => candidate.id === packetId);
  if (!packet || !state) throw new Error('Cannot rebuild forgotten worker context: the packet is unavailable.');
  const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
  return buildPacketPrompt(packet, state.packets, lane?.baseBranch ?? 'main', lane?.worktreePath ?? session.cwd);
}

/** Every automatic retry shares this boundary, including compatibility and capacity recovery. */
export async function refreshOwnedWorkerMemory(session: WorkerMemorySession, prompt: string, mode: OwnedRunMode, freshRequest = false) {
  const revision = readMemoryRevision();
  if (workerMemoryNeedsRefresh(session)) {
    const request = freshRequest ? prompt : '';
    prompt = await rebuildWorkerMemoryContext(session);
    if (request) prompt += `\n\nCurrent operator request:\n${request}`;
    // A resumed provider thread still holds forgotten memory despite a clean prompt.
    mode = 'launch';
    session.threadId = undefined;
    session.initialPrompt = prompt;
  }
  if (revision !== readMemoryRevision()) throw new Error('Worker memory changed during rebuild. Retry dispatch.');
  session.promptMemoryRevision = revision;
  return { prompt, mode };
}

/** Do not let the pre-spawn durable admission reload restore an old provider thread. */
export function mergePreparedWorkerMemory(session: OwnedSessionRecord, durable: OwnedSessionRecord | null) {
  const { threadId, initialPrompt, promptMemoryRevision } = session;
  Object.assign(session, durable, { threadId, initialPrompt, promptMemoryRevision });
}

export function assertWorkerMemoryCurrent(session: WorkerMemorySession): void {
  if (workerMemoryNeedsRefresh(session)) {
    throw new Error('Worker memory changed before provider launch. Start a fresh dispatch.');
  }
}
