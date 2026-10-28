import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { dedupeDisplayMessages } from './dedupe-display-messages';
import { visibleVoiceTranscript } from '@/lib/transcripts/voice-captions';
import { mergeCompactionMarkers, withoutCompactionReplay } from '@/lib/transcripts/compaction';
import { mergeTranscriptSources } from '@/lib/transcripts/merge-ordered';

export function resolveVisibleChatMessages(sources: Parameters<typeof resolveDisplayMessages>[0] & {
  isOrchestratorMode: boolean;
  isChatMode: boolean;
}): MobileTranscriptEntry[] {
  return sources.isOrchestratorMode && !sources.isChatMode
    ? visibleVoiceTranscript(resolveDisplayMessages(sources)) : sources.chatMessages;
}

/**
 * Compose the orchestrator transcript that actually renders.
 *
 * Three sources feed it:
 *  - `historyEntries` — older pages pulled in by scroll-up backfill (oldest);
 *  - `chatMessages`   — the thread's persisted history, already merged with any
 *                       live transcript by the thread-load path;
 *  - `streamMessages` — the live orchestrator stream for the current turn.
 *
 * This used to pick `streamMessages` OR `chatMessages`, never both. The stream
 * starts empty and fills on the first live event, so a restored thread rendered
 * correctly until ANY event arrived — then the whole persisted history was
 * dropped in favour of that one entry. A thread holding 25 stored messages
 * showed a single dispatch card in whitespace, which reads as a lost session
 * exactly when the history matters most (#1839).
 *
 * Shared identities place unseen runs at their original boundaries. Concatenating
 * and deduplicating by first occurrence could append an older live block below
 * a fetched tail page. The final dedupe also handles optimistic user echoes.
 */
export function resolveDisplayMessages(sources: {
  historyEntries: MobileTranscriptEntry[];
  chatMessages: MobileTranscriptEntry[];
  streamMessages: MobileTranscriptEntry[];
}): MobileTranscriptEntry[] {
  const { historyEntries, chatMessages, streamMessages } = sources;
  const restored = mergeTranscriptSources(historyEntries, chatMessages);
  const base = restored.length ? mergeCompactionMarkers(restored, streamMessages) : restored;
  return withoutCompactionReplay(dedupeDisplayMessages(mergeTranscriptSources(base, streamMessages)));
}
