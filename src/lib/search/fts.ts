import type Database from 'better-sqlite3';
import type { SearchResult } from './types';

export function toFts5Query(query: string): string | null {
  const tokens = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, 12) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

/**
 * Recover one misspelled word only after fewer than three strict hits.
 * At most six indexed existence probes and one recovery MATCH per index;
 * 512 one-edit spellings. Providers rank only 32 recovery documents.
 * Input words have the same initial letter and 4–16 letters.
 * Generate spellings before FTS tokenization: Porter vocabulary terms have
 * already lost suffixes, e.g. "compaction" becomes "compact".
 */
export function toTypoFts5Query(
  sqlite: Database.Database,
  table: 'chat_history_fts' | 'transcript_fts' | 'outcomes_fts',
  query: string,
  strictCount: number,
): string | null {
  if (strictCount >= 3 || query.length > 128) return null;
  const tokens = query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const eligible = (token: string) => /^\p{L}{4,16}$/u.test(token);
  if (!tokens.length || tokens.length > 6 || !tokens.some(eligible)) return null;
  const missing: number[] = [];
  try {
    const probe = sqlite.prepare(`SELECT 1 FROM ${table} WHERE ${table} MATCH ? LIMIT 1`);
    for (let index = 0; index < tokens.length; index++) {
      if (!probe.get(toFts5Query(tokens[index]))) missing.push(index);
    }
  } catch {
    // Recovery is optional, including when a legacy index is unavailable.
    return null;
  }
  // Do not drop constraints or guess which of several words was misspelled.
  // A single-token query can also recover alongside an existing literal typo.
  if (missing.length !== 1 && tokens.length !== 1) return null;
  const index = missing[0] ?? 0;
  const token = tokens[index];
  if (!eligible(token)) return null;
  const letters = Array.from(token);
  const variants = new Set<string>();
  const add = (word: string) => {
    if (word !== token && Array.from(word).length >= 4 && variants.size < 512) variants.add(word);
  };
  // Preserve the first letter. Prioritize transpositions and deletions, then
  // insertions and substitutions; the latter use the bounded Latin alphabet.
  for (let at = 1; at < letters.length - 1; at++) {
    const swapped = [...letters];
    [swapped[at], swapped[at + 1]] = [swapped[at + 1], swapped[at]];
    add(swapped.join(''));
  }
  for (let at = 1; at < letters.length; at++) add(letters.filter((_, position) => position !== at).join(''));
  for (let at = 1; at <= letters.length; at++) {
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') add([...letters.slice(0, at), letter, ...letters.slice(at)].join(''));
  }
  for (let at = 1; at < letters.length; at++) {
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') add([...letters.slice(0, at), letter, ...letters.slice(at + 1)].join(''));
  }
  return tokens.map((word, position) => position === index
    ? `(${[...variants].map(variant => toFts5Query(variant)).join(' OR ')})`
    : toFts5Query(word)).join(' AND ');
}

/** Materialize a posting-list window before sorting; never rank all typo hits. */
export function boundedTypoSelect(select: string): string {
  return `WITH typo_candidates AS MATERIALIZED (${select} LIMIT 32) SELECT * FROM typo_candidates`;
}

export function approximateSearchResult(result: SearchResult): SearchResult {
  return {
    ...result,
    detail: `Approximate match · ${result.detail}`,
    // Keep every strict history result above recovery, including when the
    // route sorts conversation and transcript groups together by score.
    score: Math.min(40, result.score - 100),
  };
}

export function matchedTextSnippet(text: string, query: string, maxLength = 150): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const lowered = normalized.toLowerCase();
  const queryLowered = query.trim().toLowerCase();
  let matchIndex = lowered.indexOf(queryLowered);
  if (matchIndex < 0) {
    const tokens = queryLowered.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    matchIndex = tokens.reduce((best, token) => {
      const index = lowered.indexOf(token);
      if (index < 0) return best;
      return best < 0 ? index : Math.min(best, index);
    }, -1);
  }
  if (normalized.length <= maxLength) return normalized;
  if (matchIndex < 0) return `${normalized.slice(0, maxLength - 1)}…`;
  const before = Math.max(0, matchIndex - Math.floor(maxLength * 0.35));
  const after = Math.min(normalized.length, before + maxLength);
  return `${before > 0 ? '…' : ''}${normalized.slice(before, after)}${after < normalized.length ? '…' : ''}`;
}
