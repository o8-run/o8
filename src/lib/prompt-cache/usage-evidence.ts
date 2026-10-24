import type { MobileTranscriptEntry } from '@/lib/mobile/types';

/** Preserve missing counters as unknown; retain a lifetime only when reported by the provider. */
const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function cacheUsageEvidence(usage: Record<string, unknown>) {
  const input = usage.input_tokens ?? usage.inputTokens;
  const read = usage.cache_read_input_tokens ?? usage.cacheReadTokens;
  const write = usage.cache_creation_input_tokens ?? usage.cacheWriteTokens;
  const creation = usage.cache_creation && typeof usage.cache_creation === 'object'
    ? usage.cache_creation as Record<string, unknown> : {};
  const ttl = count(usage.cacheRetentionMs) && usage.cacheRetentionMs > 0 && usage.cacheRetentionMs <= 86400_000
    ? usage.cacheRetentionMs : count(creation.ephemeral_5m_input_tokens) && creation.ephemeral_5m_input_tokens > 0 ? 300_000
      : count(creation.ephemeral_1h_input_tokens) && creation.ephemeral_1h_input_tokens > 0 ? 3600_000 : null;
  return {
    ...(!count(input) || !count(read) || (write !== undefined && !count(write)) || usage.cacheObserved === false ? { cacheObserved: false as const } : {}),
    ...(ttl ? { cacheRetentionMs: ttl } : {}),
  };
}

export function observedCacheTokens(usage: Record<string, unknown>, inclusiveInput = false) {
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const read = usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cached_input_tokens;
  // Codex reports inclusive input and its cached subset. Writes are already part of
  // fresh input, so the exclusive write contribution is zero (never added twice).
  const write = inclusiveInput ? 0 : usage.cache_creation_input_tokens ?? usage.cacheWriteTokens;
  return {
    input: count(input) ? Math.max(0, input - (inclusiveInput && count(read) ? read : 0)) : 0,
    output: count(output) ? output : 0,
    ...(count(read) ? { cacheRead: read } : {}),
    ...(count(write) ? { cacheWrite: write } : {}),
    ...cacheUsageEvidence({ ...usage, cacheReadTokens: read }),
    ...(inclusiveInput && count(read) && count(input) && read > input ? { cacheObserved: false as const } : {}),
  };
}

/** Aggregate only counters explicitly reported on every contributing API call. */
export function mergeCacheTokens(a: MobileTranscriptEntry['tokens'], b: MobileTranscriptEntry['tokens']) {
  if (!a) return b;
  if (!b) return a;
  const sum = (field: 'input' | 'output' | 'cacheRead' | 'cacheWrite') =>
    count(a[field]) && count(b[field]) && count(a[field]! + b[field]!) ? a[field]! + b[field]! : undefined;
  return { input: sum('input') ?? 0, output: sum('output') ?? 0,
    ...(sum('cacheRead') !== undefined ? { cacheRead: sum('cacheRead') } : {}),
    ...(sum('cacheWrite') !== undefined ? { cacheWrite: sum('cacheWrite') } : {}),
    ...(a.cacheObserved === false || b.cacheObserved === false || sum('input') === undefined ? { cacheObserved: false as const } : {}),
    ...(a.cacheRetentionMs && b.cacheRetentionMs ? { cacheRetentionMs: Math.min(a.cacheRetentionMs, b.cacheRetentionMs) } : {}),
  };
}

/** A mutable session selection is not evidence of the model used by a historical run. */
export function reportedRunModel(raw: string): string | undefined {
  const models = new Set<string>();
  for (const line of raw.split('\n')) {
    try {
      const row = JSON.parse(line);
      const model = row.type === 'assistant' ? row.message?.model : row.type === 'turn_context' ? row.payload?.model
        : row.type === 'system' || row.type === 'turn.completed' ? row.model : undefined;
      if (typeof model === 'string' && model.trim()) models.add(model);
    } catch { /* Partial JSONL lines do not supply model evidence. */ }
  }
  return models.size === 1 ? [...models][0] : undefined;
}
