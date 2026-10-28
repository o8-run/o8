import { removeTranscriptReadingPositions } from '@/components/desktop/thoughts/chat-panel/transcript-reading-position';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  buildMissionArchiveTitle,
  extractLatestCompactionSummary,
  serializeThoughtsHistoryMessages,
  transcriptMatchesStoredHistory,
} from '@/lib/orchestrator/history-transcript';
import { markMissionCarded, type OrchestratorMissionCompletedDetail } from '@/lib/orchestrator/store';
import type { OrchestratorStatusEventData } from '@/lib/orchestrator/status-events';
import { normalizeRepoPath } from './shared';

interface ThoughtsHistoryListEntry {
  tabId: string;
  messageCount: number;
  modifiedAt?: string;
  repoPath?: string | null;
}

interface ArchiveMissionThreadOptions {
  planText: string | null;
  replaceTranscript: (entries: MobileTranscriptEntry[]) => void;
  getTranscript: () => MobileTranscriptEntry[];
  repoPath: string;
  reset: () => void;
  transcript: MobileTranscriptEntry[];
  transitionStripTimerRef: { current: number | null };
}

function buildMissionTransitionEntry(id: string, text: string, timestamp: number): MobileTranscriptEntry {
  return { id, role: 'system', text, timestamp };
}

async function findStoredThoughtsThreadTabId(
  transcript: MobileTranscriptEntry[],
  repoPath: string,
): Promise<string | null> {
  if (transcript.length === 0) return null;

  try {
    const listResponse = await fetch('/api/v2/chat-history/list?include=orchestrator', { cache: 'no-store' });
    if (!listResponse.ok) return null;
    const payload = await listResponse.json() as { conversations?: ThoughtsHistoryListEntry[] };
    const repoPathKey = normalizeRepoPath(repoPath);
    const candidates = (payload.conversations ?? [])
      .filter((thread) => thread.tabId.startsWith('thoughts-') && thread.messageCount === transcript.length)
      .filter((thread) => {
        const candidateRepoPath = normalizeRepoPath(thread.repoPath);
        return !repoPathKey || !candidateRepoPath || candidateRepoPath === repoPathKey;
      })
      .sort((left, right) => new Date(right.modifiedAt ?? 0).getTime() - new Date(left.modifiedAt ?? 0).getTime())
      .slice(0, 8);

    for (const candidate of candidates) {
      const historyResponse = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(candidate.tabId)}`, { cache: 'no-store' });
      if (!historyResponse.ok) continue;
      const history = await historyResponse.json() as { messages?: unknown[] };
      if (transcriptMatchesStoredHistory(transcript, history.messages)) {
        return candidate.tabId;
      }
    }
  } catch {
    // silent
  }

  return null;
}

/** FNV-1a over the RAW mission id — stable across processes and restarts. */
function missionIdentityHash(missionId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < missionId.length; index += 1) {
    hash ^= missionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * One mission, one snapshot record. The archive id is derived from the mission
 * id rather than the wall clock, so every replay of the same mission-completed
 * event resolves to the SAME record instead of minting a new one.
 *
 * Mission ids are NOT charset-constrained — `buildMissionId()` is uuid-shaped,
 * but the task pool, GitHub intake and any persisted `missionId` string reach
 * this code too. Sanitizing for the history store's filename charset and
 * truncating would let distinct ids alias onto one record (`a/b` and `a_b`, or
 * two long ids sharing a prefix), so the readable prefix carries a hash of the
 * raw id: aliasing would need the prefix AND the hash to collide. That is
 * collision-resistant by construction, not a cryptographic guarantee.
 */
export function missionArchiveTabId(missionId: string | null | undefined): string | null {
  const raw = (missionId ?? '').trim();
  // A blank id is a BROKEN INVARIANT, not a case to route around: the
  // completion path proves the id is nonblank before it emits the detail
  // (`buildMissionCompletedDetail` returns null without one). With no identity
  // there is nothing to dedupe on, so any id invented here would mint a fresh
  // snapshot on every replay — exactly the non-idempotent minting this change
  // removes. Report the absence and let the caller fail closed.
  if (!raw) return null;
  const readable = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return `thoughts-mission-${readable}-${missionIdentityHash(raw)}-archive`;
}

/**
 * Durable "already archived" fact, read from the persisted record itself. This
 * is deliberately NOT the carded-mission set: that set records that a
 * mission-complete CARD was claimed for delivery (the lifecycle detector claims
 * it before it delivers), which is a different fact from whether this mission's
 * transcript was persisted. Reading the snapshot keeps first delivery working
 * no matter which surface claimed the card.
 */
async function missionArchiveExists(archiveTabId: string): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/v2/chat-history?tabId=${encodeURIComponent(archiveTabId)}`,
      { cache: 'no-store' },
    );
    // A real non-OK answer is an unknown state, not an absence — fail closed.
    if (!response.ok) return true;
    const record = await response.json() as { exists?: unknown; messages?: unknown[] };
    // The route answers 200 for a tabId that was never written and says so
    // explicitly with `exists: false`; a stored record carries no `exists` key.
    // That field is the durable fact, so read it rather than inferring absence.
    if (record.exists === false) return false;
    // Unreadable shape — unknown state, fail closed.
    if (!Array.isArray(record.messages)) return true;
    // A record that exists but holds nothing has no snapshot in it. Calling that
    // archived would permanently block the only write that would fill it, and
    // the history POST merges non-destructively, so writing again is safe.
    return record.messages.length > 0;
  } catch {
    // Unknown state. Skipping leaves the live thread intact and the mission
    // rotatable on the next completion signal; guessing "not archived" would
    // cut a duplicate AND delete the live thread.
    return true;
  }
}

function showMissionThreadTransition(
  detail: OrchestratorMissionCompletedDetail,
  options: Pick<ArchiveMissionThreadOptions, 'replaceTranscript' | 'getTranscript' | 'transitionStripTimerRef'>,
) {
  if (options.transitionStripTimerRef.current) {
    clearTimeout(options.transitionStripTimerRef.current);
    options.transitionStripTimerRef.current = null;
  }

  // Claim this mission so the lifecycle-driven status feed (the fallback for
  // MCP-dispatched missions) doesn't also card it.
  markMissionCarded(detail.missionId);

  const startedAt = Date.now();
  const confirmationId = `orch-mission-complete-${startedAt}`;
  const mergeCount = detail.mergedCount;
  const summary = mergeCount > 0
    ? `Mission complete — ${mergeCount} ${mergeCount === 1 ? 'packet' : 'packets'} merged and archived. Ready for the next one.`
    : 'Mission archived. Ready for the next one.';
  const statusEvent: OrchestratorStatusEventData = {
    kind: 'mission-complete',
    mergedCount: mergeCount,
    archivedCount: detail.archivedCount,
    summary: detail.summary || undefined,
    repoPath: detail.repoPath,
    packets: detail.packets,
  };
  options.replaceTranscript([{ ...buildMissionTransitionEntry(confirmationId, summary, startedAt), statusEvent }]);

  // After a beat, clear the confirmation so the thread returns to its empty
  // state (greeting + quick-action cards) — the completed mission is preserved
  // in the history list, so the live thread doesn't need to keep a marker.
  // Guard against wiping a turn the operator started in the meantime: only
  // clear when the confirmation is still the sole entry.
  options.transitionStripTimerRef.current = window.setTimeout(() => {
    options.transitionStripTimerRef.current = null;
    const current = options.getTranscript();
    if (current.length === 1 && current[0]?.id === confirmationId) {
      options.replaceTranscript([]);
    }
  }, 4600);
}

export async function archiveMissionThread(
  detail: OrchestratorMissionCompletedDetail,
  options: ArchiveMissionThreadOptions,
): Promise<void> {
  const hasArchivableMessages = options.transcript.some((entry) => entry.role === 'user');
  // Empty transcript → full no-op. Mission-completed re-fires on boot (WS
  // reconnect / incremental packet load oscillates non-terminal→terminal) used
  // to fall through to reset(): each one minted an empty thoughts-* placeholder,
  // repointed the live thread ref, suppressed reload-restore, and killed the
  // warm backend session — the 2026-07-14 "my chats vanished" storm (10 empty
  // files in one boot). Nothing to archive means nothing to rotate.
  if (!hasArchivableMessages) return;

  // A mission is archived once. The caller's dedupe (`rotatedMissionIds`) is
  // module scope, so it is gone after a restart, and a mission-completed event
  // that replays on a later boot — mission state loads non-terminal→terminal
  // again — reached this mint site with a clean slate. Under the old wall-clock
  // archive id that replay cut a second snapshot and retired whatever thread was
  // live at the time; the regression test drives exactly that sequence. Repeated
  // snapshots of one thread (#1848) are the reported symptom and this is one
  // demonstrated way to grow them — not a reconstruction of how each existing
  // record was written. The mission-scoped id makes the replay a no-op.
  const archiveTabId = missionArchiveTabId(detail.missionId);
  // No identity means no idempotent write is possible. Do nothing at all —
  // no snapshot, no live-thread delete, no session reset — so the transcript
  // survives and the mission stays rotatable once a real id arrives.
  if (!archiveTabId) return;
  if (await missionArchiveExists(archiveTabId)) return;

  const currentTabId = await findStoredThoughtsThreadTabId(options.transcript, options.repoPath);
  const archiveResponse = await fetch('/api/v2/chat-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tabId: archiveTabId,
      messages: serializeThoughtsHistoryMessages(options.transcript),
      model: 'claude-code',
      title: buildMissionArchiveTitle({
        messages: options.transcript,
        missionSummary: detail.summary,
        compactionSummary: extractLatestCompactionSummary(options.transcript),
        outcomeTitles: detail.packets.map((packet) => packet.title),
      }),
      planText: options.planText ?? undefined,
      repoPath: options.repoPath,
      // A completed mission's snapshot is history, not a live chat — persist it
      // archived so it lands in the Archived group instead of the Chats rail.
      archivedAt: new Date().toISOString(),
    }),
  });
  if (!archiveResponse.ok) {
    throw new Error('Unable to archive the completed mission thread.');
  }
  if (currentTabId) {
    const deleted = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(currentTabId)}`, { method: 'DELETE' }).catch(() => null);
    if (deleted?.ok && typeof window !== 'undefined') {
      removeTranscriptReadingPositions(currentTabId);
    }
  }

  await fetch('/api/orchestrator/reset-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath: options.repoPath }),
  }).catch(() => null);

  options.reset();
  showMissionThreadTransition(detail, options);
}
