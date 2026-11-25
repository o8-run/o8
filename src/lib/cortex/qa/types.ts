/**
 * Canonical types for the Cortex Q&A retrieval foundation (epic #915 sub-1).
 *
 * Three retrievers (SQL / FTS5 / symbol graph) each return `TypedRow[]` with a
 * `Citation` so the LLM composer (later sub-issue) can render answers backed
 * by row-level provenance instead of opaque vector hits.
 *
 * Locked-architecture rules from #915:
 *   - NO vectors. The prior retrieval pipeline silently accepted embedding
 *     failures as empty results; BM25 either returns ranked tokens or nothing
 *     — no silent-degradation mode.
 *   - Every fact gets a row id (`rowId` + `table`) so contradictions can be
 *     resolved against the originating row, not a free-text blob.
 */
export type CitationKind =
  | 'directive'
  | 'outcome'
  | 'pr'
  | 'issue'
  | 'comment'
  | 'doc'
  | 'fact'
  | 'project'
  | 'project_repo'
  /** #2219 — operator rejection or steer reason (approvals / lane_events). */
  | 'correction';

/**
 * Engineering Brain Indexer typed-row shape (epic #915 north star #1).
 *
 * `factsRetriever` returns `TypedRow` with `citation.kind === 'fact'`. The
 * fields below describe the distilled-fact payload the composer reads. Kept
 * as a documentation-only interface so retrievers can spread it into the
 * `fields` slot without forcing a discriminated union on TypedRow.
 */
export interface FactRowFields {
  /** Distilled fact category (e.g. 'decision', 'spec', 'directive'). */
  factKind: string;
  /** The extracted fact content (≤500 chars). */
  content: string;
  /** Source substrate kind (e.g. 'comment', 'doc', 'outcome'). */
  sourceKind: string;
  /** Source row id within the substrate table. */
  sourceId: string;
  /** Verbatim substring of the source body the fact derives from. */
  sourceExcerpt: string;
  /** Distillation confidence (0.0-1.0). */
  confidence: number;
}

export interface Citation {
  kind: CitationKind;
  /** Stable row identifier within `table`. Cast to string so symbol/project
   *  citations (which don't carry an int row id) share the same shape. */
  rowId: string;
  /** Underlying SQLite table name (or a logical name for non-table sources
   *  like the symbol graph). */
  table: string;
  /** Repo-relative path of the source artifact when known (directive .md
   *  file, symbol definition file, etc.). */
  sourcePath?: string;
  /** Line number for symbol citations. */
  line?: number;
  /** External URL for issue/PR citations. */
  url?: string;
  /** Short snippet rendered in citation pills. Caller-controlled length. */
  excerpt?: string;
  /** Human-readable display title derived per kind at emit time (directive
   *  title, PR title, outcome summary head, …). Every surface — ScratchChat
   *  pills, orchestrator tool results, Symon's dock, MCP consumers — renders
   *  this instead of the opaque kind:rowId handle (2026-06-11 parity pass). */
  title?: string;
}

/**
 * A typed row returned by any retriever. `fields` carries the raw selected
 * columns (the SQL SELECT shape, the FTS5 row, etc.) so downstream layers
 * can render whatever shape they need without re-querying.
 */
export interface TypedRow {
  citation: Citation;
  fields: Record<string, unknown>;
  /** Retriever-local relevance score. SQL gives 1.0 (deterministic),
   *  FTS5 gives BM25 rank, graph gives 1.0 by default. */
  score?: number;
}

export interface RetrieverResult {
  retriever: 'sql' | 'fts' | 'facts' | 'corrections';
  rows: TypedRow[];
  durationMs: number;
}

export interface RetrieverInput {
  /** Operator question. Free text, lowercased downstream as needed. */
  question: string;
  /** Absolute repo path for scoping — when set, retrievers narrow to this
   *  repo where the underlying schema supports it. */
  repoPath?: string;
  /** Project id for cross-repo questions (epic #899). */
  projectId?: string;
  /** Optional pre-computed BM25 query variants (Flash classifier output —
   *  later sub-issue). When unset, retrievers tokenize `question` directly. */
  bm25Variants?: string[];
  /** Cap on rows returned by a single retriever. Defaults are retriever-
   *  specific; each respects this when set. */
  limit?: number;
  /** Classifier output (#1122). Class A = lookup ("what is the X"); the
   *  orchestrator uses this in `unionMerge` to route directive-first when
   *  spec-ingest has authoritative content, preventing stale facts from
   *  winning over the canonical CLAUDE.md/AGENTS.md/docs/design/DESIGN.md substrate. */
  questionClass?: 'A' | 'B';
}
