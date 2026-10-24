import { assertKnowledgeAnswerCurrent } from '@/lib/cortex/knowledge/answer-validity';
/**
 * Cortex Q&A public API (epic #915 sub-2).
 *
 * `askCortex(question, repoPath)` — the single entry point used by:
 *   - The eval runner (src/lib/cortex/qa/eval/runner.ts)
 *   - Any script that needs a non-streaming answer (e.g. scripts/smoke-qa-ask.ts)
 *
 * For the streaming HTTP path see the POST handler in
 * src/app/api/cortex/ask/route.ts which calls `runAskPipeline()` directly.
 *
 * Cache:
 *   30-minute in-process TTL keyed by sha256(normalized question + repoPath
 *   + projectId). `?force=1` query param on the HTTP route bypasses it.
 *   Invalidation: knowledge writes call `invalidateAnswerCache()` —
 *   spec ingest (directives changed) and the session-outcome ledger write
 *   (new "what shipped" rows). The long TTL is safe because both write
 *   paths invalidate eagerly; the clock is only a backstop.
 */

import 'server-only';
import { readMemoryRevision } from '@/lib/cortex/memory-revision';

import { createHash } from 'node:crypto';

import { classifyQuestion } from '@/lib/cortex/qa/classifier';
import { composeClassA, composeClassB, rowDisplayTitle, type ComposeOptions, type SseEmit } from '@/lib/cortex/qa/composer';
import { rowFullText } from '@/lib/cortex/qa/citations';
import { buildGrepArmTopRows } from '@/lib/cortex/qa/grep-arm';
import { embedQuestion } from '@/lib/cortex/qa/llm/gemini-embed';
import { prewarmHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { prewarmSonnetCli } from '@/lib/cortex/qa/llm/sonnet-adapter';
import {
  withBrainRetrievalUsage,
  type BrainRetrievalUsageContext,
} from '@/lib/cortex/qa/llm/brain-spend';
import { detectLiteralLookup } from '@/lib/cortex/qa/literal-lookup';
import { retrieveAll, unionMerge } from '@/lib/cortex/qa/retrieve';
import {
  findSemanticMatch,
  invalidateRegisteredSemanticCaches,
  normalizeSemanticCacheQuestion,
} from '@/lib/cortex/qa/semantic-cache';
import type { Citation, TypedRow } from '@/lib/cortex/qa/types';
import { getActiveProjectScopeForRepo } from '@/lib/repos/projects';
import { currentComposerBrainRoute } from '@/lib/operator/composer-brain-context';
import { brainRouteCacheKeySync, usesManagedBrainInferenceSync } from '@/lib/operator/brain-routing';

// ── In-process cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60_000;

type CachedSourcesPayload = {
  count: number;
  retrievalMs: number;
  top: Array<{ kind: string; title: string }>;
  classifier?: 'referee';
  classificationReceiptId?: string | null;
};

interface CacheEntry {
  answer: string;
  citations: Citation[];
  /** The retrieval provenance emitted with the answer. Optional because an
   *  entry can outlive a hot reload that introduced this field. */
  sources?: CachedSourcesPayload;
  expiresAt: number;
  /** Scope fingerprint (repoPath + projectId) — semantic matches must never
   *  cross repo/project boundaries. */
  scope: string;
  /** Unit-normalized question embedding, attached fire-and-forget after the
   *  entry is stored (#1226). Entries without one are exact-match only. */
  vector?: number[];
}

const answerCache = new Map<string, CacheEntry>();

function scopeKey(repoPath: string | undefined, projectId: string | undefined, terse = false): string {
  return `${readMemoryRevision()}\x00${brainRouteCacheKeySync()}\x00${repoPath ?? ''}\x00${projectId ?? ''}${terse ? '\x00terse' : ''}`;
}

/**
 * Scan same-scope vectored entries for a cosine-near duplicate (#1226).
 * Pure given the candidates — exported for tests.
 */
export { findSemanticMatch } from '@/lib/cortex/qa/semantic-cache';

/**
 * Semantic lookup: agent fleets ask the same thing ten structurally-different
 * ways; key normalization only catches the trivial ones. Costs one embedding
 * call (~150-400ms) — but ONLY when the cache actually holds same-scope
 * vectored entries, so a cold cache adds zero latency. Returns null on any
 * embedding failure (silent miss, never an error).
 */
async function getSemanticCached(question: string, scope: string): Promise<CacheEntry | null> {
  if (currentComposerBrainRoute()?.runtime) return null;
  const now = Date.now();
  const candidates: Array<{ key: string; vector: number[] }> = [];
  for (const [key, entry] of answerCache) {
    if (entry.scope === scope && entry.vector && now <= entry.expiresAt) {
      candidates.push({ key, vector: entry.vector });
    }
  }
  if (candidates.length === 0) return null;

  const vector = await embedQuestion(normalizeQuestionForCache(question));
  if (!vector) return null;

  const match = findSemanticMatch(vector, candidates);
  if (!match) return null;
  const entry = answerCache.get(match.key);
  if (!entry || now > entry.expiresAt) return null;
  console.info(`[qa][semantic-cache] hit (cos=${match.score.toFixed(3)}) for "${question.slice(0, 80)}"`);
  return entry;
}

/** Fire-and-forget: attach the question embedding to a stored entry so future
 *  near-duplicates can hit it semantically. */
function attachVector(key: string, question: string): void {
  if (currentComposerBrainRoute()?.runtime) return;
  void embedQuestion(normalizeQuestionForCache(question))
    .then((vector) => {
      if (!vector) return;
      const entry = answerCache.get(key);
      if (entry) entry.vector = vector;
    })
    .catch(() => undefined);
}

/**
 * Normalize a question for cache keying: trim, lowercase, collapse runs of
 * whitespace. "What's the line ceiling?" and "what's  the line ceiling?"
 * are the same question — the classifier cache already normalizes this way,
 * the answer cache historically didn't.
 */
export const normalizeQuestionForCache = normalizeSemanticCacheQuestion;

/**
 * Drop every cached answer. Called by the knowledge write paths (spec ingest,
 * session-outcome ledger) so a freshly-ingested directive is reflected in the
 * very next ask instead of after TTL expiry.
 */
export function invalidateAnswerCache(): void {
  answerCache.clear();
  invalidateRegisteredSemanticCaches();
}

function cacheKey(
  question: string,
  repoPath: string | undefined,
  projectId: string | undefined,
  terse = false,
): string {
  return createHash('sha256')
    .update(`${readMemoryRevision()}\x00${brainRouteCacheKeySync()}\x00${normalizeQuestionForCache(question)}\x00${repoPath ?? ''}\x00${projectId ?? ''}${terse ? '\x00terse' : ''}`)
    .digest('hex');
}

function getCached(key: string): CacheEntry | null {
  const entry = answerCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    answerCache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key: string, entry: Omit<CacheEntry, 'expiresAt' | 'vector'>): void {
  answerCache.set(key, { ...entry, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict stale entries lazily.
  if (answerCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of answerCache) {
      if (now > v.expiresAt) answerCache.delete(k);
    }
  }
}

async function routeGrepArm(question: string, repoPath: string | undefined): Promise<TypedRow[] | null> {
  if (process.env.O8_HYBRID_RETRIEVAL === '0' || !detectLiteralLookup(question)) {
    console.info('[qa][router] arm=brain');
    return null;
  }
  try {
    const topRows = await buildGrepArmTopRows(question, repoPath);
    if (topRows.length > 0) {
      console.info('[qa][router] arm=grep');
      return topRows;
    }
  } catch {}
  console.info('[qa][router] arm=brain (grep-empty-fallback)');
  return null;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface AskCortexResult {
  answer: string;
  citations: Citation[];
  class: 'A' | 'B';
  retrievalMs: number;
  classifyMs: number;
  /** How many rows retrieval put in front of the composer (cited ⊆ considered).
   *  Lets consumers say "consulted 30 sources, cited 3". 0 on cache hits. */
  sourcesConsidered: number;
  /** Set when the answer was served from cache — 'semantic' means a
   *  cosine-near duplicate question's answer was reused (#1226). Callers can
   *  re-ask with bypassCache when freshness matters more than speed. */
  cacheHit?: 'exact' | 'semantic';
  /** Total chars of composer-visible source text across the considered rows
   *  (each row capped at ~1500 chars by `rowFullText`). The honest "what a
   *  raw read would have cost" denominator for the Brain→Fable offload line
   *  (metered-orchestrator transparency card). Absent on cache hits — the
   *  Brain read nothing this time, so no offload is derivable. */
  consideredChars?: number;
  /** Set to 'referee' when the judgment referee tier classified the question (#2436). */
  classifier?: 'referee';
  /** Judgment receipt id for that classification. */
  classificationReceiptId?: string | null;
}

type ClassifierMeta = Pick<AskCortexResult, 'classifier' | 'classificationReceiptId'>;

/** Classifier metadata for results and the sources line; empty unless the referee answered. */
function classifierMeta(classification: { classifier?: 'referee'; receiptId?: string | null }): ClassifierMeta {
  return classification.classifier === 'referee'
    ? { classifier: 'referee', classificationReceiptId: classification.receiptId ?? null }
    : {};
}

/**
 * Build the early `sources` payload emitted the moment retrieval lands —
 * BEFORE composition starts. This is what lets a surface show "found N
 * sources" live while the model is still writing, with the top titles as
 * the minimal preview ("what is he looking at").
 */
function buildSourcesPayload(topRows: TypedRow[], retrievalMs: number, meta: ClassifierMeta = {}): CachedSourcesPayload {
  return {
    count: topRows.length,
    retrievalMs,
    top: topRows.slice(0, 5).map((row) => ({
      kind: row.citation.kind,
      title: rowDisplayTitle(row),
    })),
    ...meta,
  };
}

/**
 * Run the full Q&A pipeline and collect the result (non-streaming).
 * Used by the eval runner and smoke tests.
 *
 * @param bypassCache  When true, skip both the cache lookup and the cache
 *                     write. Used by the eval runner so sequential runs don't
 *                     reuse stale answers.
 */
export async function askCortex(
  question: string,
  repoPath: string | undefined,
  options: {
    bypassCache?: boolean;
    projectId?: string | null;
    terse?: boolean;
    usageContext?: BrainRetrievalUsageContext;
  } = {},
): Promise<AskCortexResult> {
  return withBrainRetrievalUsage(
    question,
    { repoPath, ...options.usageContext },
    () => askCortexUnmetered(question, repoPath, options),
    (result) => result.answer,
  );
}

async function askCortexUnmetered(
  question: string,
  repoPath: string | undefined,
  options: {
    bypassCache?: boolean;
    projectId?: string | null;
    terse?: boolean;
  },
): Promise<AskCortexResult> {
  const { bypassCache = false, terse = false } = options;
  const projectId = options.projectId?.trim()
    || (await getActiveProjectScopeForRepo(repoPath)).projectId;
  const key = cacheKey(question, repoPath, projectId, terse);
  if (!bypassCache) {
    const cached = getCached(key);
    if (cached) {
      return {
        answer: cached.answer,
        citations: cached.citations,
        class: 'A', // cached result — class doesn't matter
        retrievalMs: 0,
        classifyMs: 0,
        sourcesConsidered: 0,
        cacheHit: 'exact',
      };
    }
    // Single-flight: concurrent identical questions share one pipeline run
    // instead of each spawning their own classifier + composer. This is the
    // path an MCP-timeout retry takes — without coalescing, the retry doubles
    // the CLI spawns while the first run is still composing.
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = runAskCortexUncached(question, repoPath, projectId, key, bypassCache, { terse })
      .finally(() => { inFlight.delete(key); });
    inFlight.set(key, run);
    return run;
  }

  return runAskCortexUncached(question, repoPath, projectId, key, bypassCache, { terse });
}

const inFlight = new Map<string, Promise<AskCortexResult>>();

async function runAskCortexUncached(
  question: string,
  repoPath: string | undefined,
  projectId: string | undefined,
  key: string,
  bypassCache: boolean,
  composeOptions: ComposeOptions,
): Promise<AskCortexResult> {
  const memoryRevision = readMemoryRevision();
  // Semantic cache (#1226) — a cosine-near duplicate of an already-answered
  // question replays its answer instead of re-running the pipeline.
  if (!bypassCache) {
    const semantic = await getSemanticCached(question, scopeKey(repoPath, projectId, composeOptions.terse === true));
    if (semantic) {
      return {
        answer: semantic.answer,
        citations: semantic.citations,
        class: 'A',
        retrievalMs: 0,
        classifyMs: 0,
        sourcesConsidered: 0,
        cacheHit: 'semantic',
      };
    }
  }

  // Pre-warm the Haiku REPL while classify + retrieve run — the composer's
  // CLI tier then finds a proc with its bootstrap already under way.
  if (!usesManagedBrainInferenceSync()) void prewarmHaiku();

  const grepStart = Date.now();
  const grepRows = await routeGrepArm(question, repoPath);
  // 1+2. Classify and retrieve OVERLAPPED (#1227). The speculative retrieval
  // uses the raw question only — for Class A that is byte-identical to the
  // classified retrieval (#1122 made Class A FTS ignore variants), so the
  // result is simply reused. Class B discards it and re-runs with the
  // classifier's variants: correct ranking, and the ~0.3s re-run is noise
  // next to Class B's Sonnet composition.
  const classifyStart = Date.now();
  const speculativeRetrieval = grepRows
    ? null
    : retrieveAll({ question, repoPath, projectId, bm25Variants: [question] }).catch(() => null);
  const classification: Awaited<ReturnType<typeof classifyQuestion>> = grepRows
    ? { class: 'A' as const, bm25Variants: [question] }
    : await classifyQuestion(question);
  const classifyMs = grepRows ? 0 : Date.now() - classifyStart;
  // Class B composes via Sonnet CLI — start its bootstrap before retrieval.
  if (classification.class === 'B' && !usesManagedBrainInferenceSync()) void prewarmSonnetCli();

  const retrievalStart = Date.now();
  let results: Awaited<ReturnType<typeof retrieveAll>> = [];
  if (!grepRows) {
    const speculative = classification.class === 'A' ? await speculativeRetrieval : null;
    results = speculative ?? await retrieveAll({
      question,
      repoPath,
      projectId,
      bm25Variants: classification.bm25Variants,
      questionClass: classification.class,
    });
  }
  const topRows = grepRows ?? unionMerge(results, { questionClass: classification.class });
  const retrievalMs = grepRows ? Date.now() - grepStart : Date.now() - retrievalStart;

  // [qa-debug] Log retrieval diagnostics so we can trace empty-answer false-positives.
  const isDebug = process.env.QA_DEBUG === '1';
  if (isDebug) {
    console.log('[qa-debug] question:', question);
    console.log('[qa-debug] bm25Variants:', classification.bm25Variants);
    for (const r of results) {
      console.log(`[qa-debug] retriever=${r.retriever} rows=${r.rows.length} durationMs=${r.durationMs}`);
    }
    console.log('[qa-debug] topRows after unionMerge:', topRows.length);
    console.log('[qa-debug] composer class:', classification.class);
    if (topRows.length === 0) {
      console.warn('[qa-debug] topRows is EMPTY — composer will respond "no data"');
    }
  }

  // 3. Compose (collect via emit accumulator)
  let answer = '';
  const citations: Citation[] = [];

  const assertKnowledgeCurrent = () => assertKnowledgeAnswerCurrent(topRows, memoryRevision);
  const emit: SseEmit = (name, payload) => {
    assertKnowledgeCurrent();
    if (name === 'token') {
      answer += (payload as { text: string }).text ?? '';
    } else if (name === 'citation') {
      const p = payload as {
        kind: Citation['kind'];
        rowId: string;
        table: string;
        title?: string;
        excerpt?: string;
        url?: string;
        sourcePath?: string;
      };
      citations.push({
        kind: p.kind,
        rowId: p.rowId,
        table: p.table,
        title: p.title,
        excerpt: p.excerpt,
        url: p.url,
        ...(p.sourcePath ? { sourcePath: p.sourcePath } : {}),
      });
    }
  };

  if (classification.class === 'A') {
    await composeClassA(question, repoPath, topRows, emit, composeOptions);
  } else {
    await composeClassB(question, repoPath, topRows, emit, composeOptions);
  }

  assertKnowledgeCurrent();
  const result: AskCortexResult = {
    answer: answer.trim(),
    citations,
    class: classification.class,
    retrievalMs,
    classifyMs,
    sourcesConsidered: topRows.length,
    consideredChars: topRows.reduce((sum, row) => sum + rowFullText(row).length, 0),
    ...classifierMeta(classification),
  };

  if (!bypassCache && memoryRevision === readMemoryRevision()) {
    setCache(key, {
      answer: result.answer,
      citations,
      sources: buildSourcesPayload(topRows, retrievalMs, classifierMeta(classification)),
      scope: scopeKey(repoPath, projectId, composeOptions.terse === true),
    });
    attachVector(key, question);
  }
  return result;
}

/**
 * Streaming pipeline — called by the HTTP route handler.
 *
 * Runs classifier → retriever → composer in sequence, emitting SSE frames
 * via the provided `emit` callback as data arrives.
 *
 * @param force  When true, bypass the 30s cache and re-run the full pipeline.
 */
export async function runAskPipeline(
  question: string,
  repoPath: string | undefined,
  emit: SseEmit,
  force = false,
  requestedProjectId?: string | null,
  options: ComposeOptions = {},
): Promise<void> {
  const memoryRevision = readMemoryRevision();
  const projectId = requestedProjectId?.trim()
    || (await getActiveProjectScopeForRepo(repoPath)).projectId;
  const key = cacheKey(question, repoPath, projectId, options.terse === true);

  if (!force) {
    const cached = getCached(key);
    if (cached) {
      // Replay cached answer from SSE frames.
      // Older in-memory entries predate stored provenance. Do not manufacture
      // a count or classifier for them.
      if (cached.sources) emit('sources', cached.sources);
      emit('token', { text: cached.answer });
      for (const c of cached.citations) {
        emit('citation', c);
      }
      emit('done', {});
      return;
    }
    // Semantic cache (#1226) — replay a cosine-near duplicate's answer.
    const semantic = await getSemanticCached(question, scopeKey(repoPath, projectId, options.terse === true));
    if (semantic) {
      // Semantic entries retain the source provenance of their original
      // answer and use the same old-entry boundary as exact hits.
      if (semantic.sources) emit('sources', semantic.sources);
      emit('token', { text: semantic.answer });
      for (const c of semantic.citations) {
        emit('citation', c);
      }
      emit('done', {});
      return;
    }
  }

  // Pre-warm the Haiku REPL while classify + retrieve run (see askCortex).
  if (!currentComposerBrainRoute() && !usesManagedBrainInferenceSync()) void prewarmHaiku();

  const grepRows = await routeGrepArm(question, repoPath);
  let classification: Awaited<ReturnType<typeof classifyQuestion>> = {
    class: 'A',
    bm25Variants: [question],
  };
  let topRows: TypedRow[] = grepRows ?? [];
  let cachedSources: CachedSourcesPayload;

  if (!grepRows) {
    // 1+2. Classify and retrieve OVERLAPPED (#1227) — see askCortex for the
    // Class A reuse / Class B re-run rationale.
    const speculativeRetrieval = retrieveAll({
      question,
      repoPath,
      projectId,
      bm25Variants: [question],
    }).catch(() => null);
    try {
      classification = currentComposerBrainRoute()?.runtime
        ? { class: 'B', bm25Variants: [question] }
        : await classifyQuestion(question);
    } catch (err) {
      console.warn('[qa][ask] classifier error:', err);
      classification = { class: 'B', bm25Variants: [question] };
    }
    // Class B composes via Sonnet CLI — start its bootstrap before retrieval.
    if (classification.class === 'B' && !currentComposerBrainRoute() && !usesManagedBrainInferenceSync()) void prewarmSonnetCli();

    const retrievalStart = Date.now();
    try {
      const speculative = classification.class === 'A' ? await speculativeRetrieval : null;
      const results = speculative ?? await retrieveAll({
        question,
        repoPath,
        projectId,
        bm25Variants: classification.bm25Variants,
        questionClass: classification.class,
      });
      topRows = unionMerge(results, { questionClass: classification.class });
    } catch (err) {
      console.warn('[qa][ask] retrieval error:', err);
      topRows = [];
    }
    // Surface what retrieval found BEFORE composition starts — the live
    // "found N sources" signal every UI renders while the model writes.
    cachedSources = buildSourcesPayload(topRows, Date.now() - retrievalStart, classifierMeta(classification));
    emit('sources', cachedSources);
  } else {
    cachedSources = buildSourcesPayload(topRows, 0);
    emit('sources', cachedSources);
  }

  // 3. Compose — stream answer tokens + citations.
  // We also accumulate so we can update the cache when done.
  let cachedAnswer = '';
  const cachedCitations: Citation[] = [];

  const assertKnowledgeCurrent = () => assertKnowledgeAnswerCurrent(topRows, memoryRevision);
  const trackingEmit: SseEmit = (name, payload) => {
    assertKnowledgeCurrent();
    if (name === 'token') {
      cachedAnswer += (payload as { text: string }).text ?? '';
    } else if (name === 'citation') {
      const p = payload as {
        kind: Citation['kind'];
        rowId: string;
        table: string;
        title?: string;
        excerpt?: string;
        url?: string;
        sourcePath?: string;
      };
      cachedCitations.push({
        kind: p.kind,
        rowId: p.rowId,
        table: p.table,
        title: p.title,
        excerpt: p.excerpt,
        url: p.url,
        ...(p.sourcePath ? { sourcePath: p.sourcePath } : {}),
      });
    }
    emit(name, payload);
  };

  if (classification.class === 'A') {
    await composeClassA(question, repoPath, topRows, trackingEmit, options);
  } else {
    await composeClassB(question, repoPath, topRows, trackingEmit, options);
  }

  assertKnowledgeCurrent();
  // Store in cache for follow-up identical questions.
  if (cachedAnswer.trim() && memoryRevision === readMemoryRevision()) {
    setCache(key, {
      answer: cachedAnswer.trim(),
      citations: cachedCitations,
      sources: cachedSources,
      scope: scopeKey(repoPath, projectId, options.terse === true),
    });
    attachVector(key, question);
  }
}
