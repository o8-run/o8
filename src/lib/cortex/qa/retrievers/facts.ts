import { knowledgeProvenance } from '@/lib/cortex/knowledge';
/**
 * Facts retriever — Engineering Brain Indexer surface (#915 north star #1).
 *
 * BM25 against `facts_fts`, joined back to the `facts` parent for confidence
 * + source_excerpt + source_kind/source_id provenance. Returns top 8 rows
 * with `confidence >= 0.6` so low-quality distillations don't poison the
 * composer's prompt.
 *
 * #962 — Hybrid scorer (flag-gated):
 * When `O8_HYBRID_SCORER=1` is set AND `OPENAI_API_KEY` is available, the
 * retriever embeds the question and re-ranks candidates with:
 *   score = bm25_norm × 0.6 + cosine × 0.4
 * Without the flag the retriever behaves identically to before (#962 was
 * introduced). This keeps smoke tests regression-free while the flag is off.
 *
 * Mirrors the per-table BM25 pattern from `retrievers/fts.ts` (`ftsSearch`
 * helper), but lives in its own file because facts are surfaced into
 * retrieve.ts as a sibling to `ftsRetriever`/`sqlRetriever`/`graphRetriever`,
 * not as another sub-index inside the FTS retriever's internal RRF merge.
 *
 * Foundation only — no virtual-high-rank-row injection, no MERGE_LIMIT bump.
 * Composer integration (#3) is a separate agent.
 */

import 'server-only';
import { currentComposerBrainRoute } from '@/lib/operator/composer-brain-context';

import path from 'node:path';

import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { getSqlite } from '@/lib/db';
import { isFts5Available } from '@/lib/db/v14-fts5-migration';
import {
  cosineSimilarity,
  decodeEmbedding,
  embedText,
  isAvailable as embeddingsAvailable,
} from '@/lib/cortex/embeddings';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { usesManagedBrainInferenceSync } from '@/lib/operator/brain-routing';

const DEFAULT_LIMIT = 8;
const CONFIDENCE_FLOOR = 0.6;

/** Sanitize a question for FTS5 MATCH — same shape as fts.ts so behaviour
 *  matches across retrievers. Strips punctuation, splits on whitespace,
 *  builds an OR-joined prefix-allowed phrase. */
function buildMatchQuery(question: string): string | null {
  if (!question?.trim()) return null;
  const tokens = question
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

interface FactsFtsHit {
  rowId: string;
  rank: number;
  excerpt: string;
}

interface FactRow {
  id: string;
  kind: string;
  content: string;
  source_kind: string;
  source_id: string;
  source_excerpt: string;
  repo_path: string | null;
  confidence: number;
  fingerprint: string;
  created_at: string;
  extracted_by: string;
  /** Source-of-truth authority (#915 follow-up). 0.5 default for legacy
   *  rows; populated to 0.7-1.0 by the v18 backfill + new writes from the
   *  worker / structured seeder. */
  source_authority: number;
  /** 1536-dim float32 embedding BLOB (#962). NULL for un-embedded rows. */
  embedding: Buffer | null;
}

function buildScopedRepoScope(input: RetrieverInput): {
  repoPaths: Set<string>;
  primaryRepoPath: string | null;
  projectId: string;
} {
  const active = getActiveProjectScopeForRepoSync(input.repoPath);
  const explicitRepoPath = input.repoPath?.trim();
  const normalizedExplicitRepoPath = explicitRepoPath ? path.resolve(explicitRepoPath) : null;
  const projectRepoPaths = active.repoPaths.map((repoPath) => path.resolve(repoPath));
  const repoPaths = explicitRepoPath
    ? (active.repoInActiveProject ? projectRepoPaths : [])
    : projectRepoPaths;
  return {
    projectId: input.projectId?.trim() || active.projectId,
    repoPaths: new Set(repoPaths),
    primaryRepoPath: active.repoInActiveProject ? normalizedExplicitRepoPath : null,
  };
}

function factRepoInScope(repoPath: string | null, scopedRepoPaths: Set<string>): boolean {
  if (scopedRepoPaths.size === 0) return false;
  if (!repoPath?.trim()) return false;
  try {
    return scopedRepoPaths.has(path.resolve(repoPath));
  } catch {
    return false;
  }
}

function repoPathScoreMultiplier(repoPath: string | null, primaryRepoPath: string | null): number {
  if (!primaryRepoPath) return 1;
  if (!repoPath?.trim()) return 1;
  try {
    return path.resolve(repoPath) === primaryRepoPath ? 1.2 : 0.88;
  } catch {
    return 1;
  }
}

/**
 * Whether the hybrid BM25+cosine scorer is enabled. Gated behind
 * `O8_HYBRID_SCORER=1` so smoke tests run without the flag and pass
 * identically to pre-#962 behaviour. When enabled, requires OPENAI_API_KEY.
 */
function isHybridScorerEnabled(): boolean {
  return process.env.O8_HYBRID_SCORER === '1';
}

/**
 * BM25 search against `facts_fts`. Mirrors `ftsSearch` in retrievers/fts.ts
 * but inlined so this retriever has no internal coupling to the FTS retriever.
 * Returns rowIds + BM25 rank (negated, higher=better) + a snippet for the
 * citation pill.
 */
function factsFtsSearch(
  sqlite: ReturnType<typeof getSqlite>,
  match: string,
  limit: number,
  projectId: string,
): FactsFtsHit[] {
  try {
    const sql = `
      SELECT fact_id AS rowId,
             -bm25(facts_fts) AS rank,
             snippet(facts_fts, -1, '«', '»', '…', 8) AS excerpt
      FROM facts_fts
      WHERE facts_fts MATCH ?
        AND EXISTS (SELECT 1 FROM facts f WHERE f.id = facts_fts.fact_id
          AND (f.source_kind != 'outcome' OR EXISTS (
            SELECT 1 FROM session_outcomes so WHERE ('outcome:' || so.id = f.source_id OR so.id = f.source_id)
              AND so.project_id IS ?)))
      ORDER BY bm25(facts_fts)
      LIMIT ${limit}
    `;
    return sqlite.prepare(sql).all(match, projectId) as FactsFtsHit[];
  } catch (error) {
    // Likely the v17 migration hasn't been applied (FTS5 missing or migration
    // skipped) — return empty so the rest of the retrieval pipeline still works.
    console.warn(
      `[qa][facts] facts_fts match failed for ${JSON.stringify(match)}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * `retrieveFacts` — top-N distilled facts that match the question, ranked by
 * BM25 with a hard `confidence >= 0.6` floor. Multi-variant input is OR-merged
 * (best rank per fact wins) before the floor + slice.
 *
 * Excerpt strategy: prefer the FTS5 snippet (it highlights the matched terms);
 * fall back to the fact's `content` when the snippet is empty (rare — only
 * happens when the matched terms appear only in `kind` and not `content`).
 */
export async function retrieveFacts(input: RetrieverInput): Promise<RetrieverResult> {
  const start = Date.now();
  const rows: TypedRow[] = [];

  try {
    const sqlite = getSqlite();
    const scopedRepoScope = buildScopedRepoScope(input);
    if (!isFts5Available(sqlite)) {
      // FTS5 missing — facts_fts wasn't created. Worker writes still go to
      // `facts`, but we have no BM25 index to search. Return empty.
      return { retriever: 'facts', rows, durationMs: Date.now() - start };
    }

    const variants = input.bm25Variants?.length ? input.bm25Variants : [input.question];
    const matches = variants
      .map((v) => buildMatchQuery(v))
      .filter((m): m is string => Boolean(m));
    if (matches.length === 0) {
      return { retriever: 'facts', rows, durationMs: Date.now() - start };
    }

    const limit = input.limit ?? DEFAULT_LIMIT;

    // Multi-variant merge — keep the best rank per fact id across variants.
    const hits = new Map<string, { rank: number; excerpt: string }>();
    for (const match of matches) {
      // Search a generous slice per variant so the post-confidence-filter
      // population isn't starved when many low-confidence rows top the BM25
      // ordering. limit*4 keeps us inside ~32 rows in the worst case.
      const variantHits = factsFtsSearch(sqlite, match, limit * 4, scopedRepoScope.projectId);
      for (const hit of variantHits) {
        const prev = hits.get(String(hit.rowId));
        if (!prev || hit.rank > prev.rank) {
          hits.set(String(hit.rowId), { rank: hit.rank, excerpt: hit.excerpt });
        }
      }
    }

    if (hits.size === 0) {
      return { retriever: 'facts', rows, durationMs: Date.now() - start };
    }

    // Join back to `facts` for confidence + provenance. We sort by BM25 rank
    // first, slice generously, then drop anything below the confidence floor,
    // then re-slice to the final limit. Doing the floor cut after the join is
    // fine — `facts` rows are small and we cap at ~32 ids.
    const candidateIds = [...hits.entries()]
      .sort((a, b) => b[1].rank - a[1].rank)
      .map(([id]) => id);

    // When the hybrid scorer is enabled, fetch embedding BLOBs so we can
    // compute cosine similarity against the question embedding. When the
    // flag is off, we skip the embedding column entirely (no schema read
    // overhead for the common path).
    // Managed Brain has one payer. This optional scorer has its own
    // OpenAI/local embedding route, so keep lexical retrieval for this query.
    const useHybridScorer = !currentComposerBrainRoute()?.runtime && isHybridScorerEnabled() && !usesManagedBrainInferenceSync();
    const embeddingColSql = useHybridScorer ? ', embedding' : '';
    const records = sqlite
      .prepare(
        `SELECT id, kind, content, source_kind, source_id, source_excerpt,
                repo_path, confidence, fingerprint, created_at, extracted_by,
                source_authority${embeddingColSql}
         FROM facts
         WHERE id IN (${candidateIds.map(() => '?').join(',')})`,
      )
      .all(...candidateIds) as FactRow[];

    const byId = new Map(records.map((r) => [r.id, r]));

    // Hybrid scorer: optionally re-rank candidates by BM25 × 0.6 + cosine × 0.4.
    // The question embedding is computed once and reused for all candidates.
    // Rows missing an embedding fall back to their BM25 rank (cosine = 0).
    let questionVec: Float32Array | null = null;
    if (useHybridScorer && embeddingsAvailable()) {
      try {
        questionVec = await embedText(input.question);
      } catch (err) {
        console.warn(
          '[qa][facts] hybrid scorer: failed to embed question — falling back to BM25 only:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Normalise BM25 scores to [0, 1] so they can be combined with cosine.
    // BM25 ranks are positive (we stored -bm25 = rank, so higher = better).
    // Max across candidateIds so the blend is relative within this query.
    let maxBm25 = 0;
    for (const [id] of hits) {
      const h = hits.get(id)!;
      if (h.rank > maxBm25) maxBm25 = h.rank;
    }

    // Build a scored candidate list.
    const scored: Array<{ id: string; score: number }> = [];
    for (const id of candidateIds) {
      const hit = hits.get(id)!;
      const bm25Norm = maxBm25 > 0 ? hit.rank / maxBm25 : 0;

      const record = byId.get(id);
      let hybridScore = hit.rank; // default: pure BM25 rank (unnormalised)
      if (questionVec !== null) {
        const factVec = record ? decodeEmbedding(record.embedding ?? null) : null;
        const cosine = factVec ? cosineSimilarity(questionVec, factVec) : 0;
        // Blend: BM25 normalised × 0.6 + cosine × 0.4
        hybridScore = bm25Norm * 0.6 + cosine * 0.4;
      }
      const repoMultiplier = record
        ? repoPathScoreMultiplier(record.repo_path, scopedRepoScope.primaryRepoPath)
        : 1;
      scored.push({ id, score: hybridScore * repoMultiplier });
    }

    // Re-sort by score. Without the hybrid scorer this preserves BM25 while
    // nudging the repo the operator is currently in above sibling repos.
    scored.sort((a, b) => b.score - a.score);

    for (const { id, score } of scored) {
      if (rows.length >= limit) break;
      const record = byId.get(id);
      if (!record) continue;
      if (record.source_kind === 'outcome' && !sqlite.prepare(`SELECT 1 FROM session_outcomes
        WHERE (id = ? OR 'outcome:' || id = ?) AND project_id IS ?`).get(record.source_id, record.source_id, scopedRepoScope.projectId)) continue;
      const knowledge = record.source_kind === 'knowledge' ? knowledgeProvenance(record.source_id) : null;
      if (record.source_kind === 'knowledge' ? !knowledge : !factRepoInScope(record.repo_path, scopedRepoScope.repoPaths)) continue;
      if (record.confidence < CONFIDENCE_FLOOR) continue;

      const hit = hits.get(id)!;
      const excerpt = hit.excerpt?.trim() ? hit.excerpt : record.content;

      rows.push({
        citation: {
          kind: 'fact',
          rowId: record.id,
          table: 'facts',
          ...(knowledge ? { sourcePath: knowledge.sourcePath, title: knowledge.title } : {}),
          excerpt,
        },
        fields: {
          ...(knowledge ?? {}),
          factKind: record.kind,
          content: record.content,
          sourceKind: record.source_kind,
          sourceId: record.source_id,
          sourceExcerpt: record.source_excerpt,
          confidence: record.confidence,
          repoPath: record.repo_path,
          createdAt: record.created_at,
          extractedBy: record.extracted_by,
          // Source-of-truth hierarchy (#915 follow-up). The composer prefers
          // higher-authority rows when facts conflict — directives (1.0)
          // outrank merged-PRs (0.95), which outrank closed-outcomes (0.9),
          // and so on down to comment-distilled facts (0.7). Default 0.5 for
          // legacy rows pre-v18 backfill.
          source_authority: record.source_authority ?? 0.5,
        },
        // Use hybrid score (BM25 × 0.6 + cosine × 0.4 when O8_HYBRID_SCORER=1)
        // or BM25 rank alone. retrieve.ts re-ranks via RRF over the per-retriever
        // ordering, so absolute magnitudes don't matter as long as higher = better
        // within this list.
        score: score,
      });
    }
  } catch (error) {
    console.warn(
      '[qa][facts] retriever failed:',
      error instanceof Error ? error.message : error,
    );
  }

  return {
    retriever: 'facts',
    rows,
    durationMs: Date.now() - start,
  };
}
