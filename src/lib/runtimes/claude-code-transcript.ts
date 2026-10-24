import { mergeCacheTokens } from '@/lib/prompt-cache/usage-evidence';
import type { RuntimeTranscriptEntry } from './types';

/** Coalesce narration while preserving each API call's cache counters and last tool metadata. */
export function coalesceClaudeTranscript(entries: RuntimeTranscriptEntry[]) {
  const coalesced: RuntimeTranscriptEntry[] = [];
  for (const entry of entries) {
    const prev = coalesced[coalesced.length - 1];
    const mergeable =
      entry.role === 'assistant'
      && entry.type === 'message'
      && prev
      && prev.role === 'assistant'
      && prev.type === 'message';
    if (mergeable && prev) {
      const sep = entry.text.trim().length > 0 && prev.text.trim().length > 0 ? '\n\n' : '';
      prev.text = `${prev.text}${sep}${entry.text}`;
      prev.toolName = entry.toolName ?? prev.toolName;
      prev.filePath = entry.filePath ?? prev.filePath;
      prev.timestamp = entry.timestamp;
      const mixedModel = prev.tokens && entry.tokens && prev.model !== entry.model;
      const model = prev.tokens ? prev.model : entry.model;
      prev.tokens = mergeCacheTokens(prev.tokens, entry.tokens);
      prev.model = mixedModel ? undefined : model;
      if (mixedModel && prev.tokens) prev.tokens.cacheObserved = false;
      if (entry.toolCalls && entry.toolCalls.length > 0) {
        prev.toolCalls = [...(prev.toolCalls ?? []), ...entry.toolCalls];
      }
      continue;
    }
    coalesced.push({ ...entry });
  }

  // Strip self-review tags from assistant narration — internal scaffolding
  // shouldn't appear in the operator-facing transcript.
  const SELF_REVIEW_RE = /\s*<self-review>[\s\S]*?<\/self-review>\s*/gi;
  for (const entry of coalesced) {
    if (entry.role === 'assistant' && entry.type === 'message') {
      entry.text = entry.text.replace(SELF_REVIEW_RE, ' ').replace(/\s+$/, '').trim();
    }
  }
  return coalesced;
}
