import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { SteerTranscriptAnchor } from '@/lib/transcripts/steer-anchor';

function repoKey(repoPath: string) {
  try { return realpathSync(repoPath); } catch { return resolve(repoPath); }
}

const turns = new Map<string, { repoPath: string; snapshot: () => SteerTranscriptAnchor }>();

/** The runtime invocation owns this observer until completion, cancellation or failure. */
export function observeSteerTranscript(repoPath: string, threadId: string | null | undefined, assistantMessageId: string | null | undefined) {
  if (!threadId || !assistantMessageId) return { close: () => {}, event: (_event: OrchestratorEvent) => {} };
  const text: string[] = [], thinking: string[] = [], toolIds: string[] = [];
  let toolCount = 0, sequence = 0;
  const owner = { repoPath: repoKey(repoPath), snapshot: (): SteerTranscriptAnchor => ({ assistantMessageId, sequence: ++sequence,
    text: text.join(''), blockText: text.join('\n'), thinking: thinking.join(''), blockThinking: thinking.join('\n'), toolCount }) };
  if (threadId && assistantMessageId) turns.set(threadId, owner);
  const close = () => { if (threadId && turns.get(threadId) === owner) turns.delete(threadId); };
  return { close, event: (event: OrchestratorEvent) => {
    if (event.type === 'text') text.push(event.text);
    if (event.type === 'thinking') thinking.push(event.text);
    if (event.type === 'tool_use' && (!event.id || !toolIds.includes(event.id))) {
      toolCount += 1; if (event.id) toolIds.push(event.id);
    }
    if (event.type === 'turn_retry') { text.length = 0; thinking.length = 0; toolIds.length = 0; toolCount = 0; }
    if (event.type === 'done') close();
  } };
}

export function readSteerTranscriptAnchor(repoPath: string, threadId: string): SteerTranscriptAnchor | undefined {
  const turn = turns.get(threadId);
  return turn?.repoPath === repoKey(repoPath) ? turn.snapshot() : undefined;
}
