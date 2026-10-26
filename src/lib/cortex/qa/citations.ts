import type { CitationKind, TypedRow } from '@/lib/cortex/qa/types';

/**
 * Extract the longest readable text from a row's `fields` payload. Used to
 * feed the composer LLM full content instead of the BM25-truncated FTS snippet
 * (which strips the very numbers/values most questions are asking about).
 *
 * Field shapes are heterogeneous across retrievers — facts have `content`,
 * comments + directives have `body`, PRs/issues have `title` + `body`, etc.
 * We pick the most informative field per row kind, capped at ~1500 chars so
 * a single row can't crowd out the rest of the slice.
 */
export function rowFullText(row: TypedRow): string {
  const fields = row.fields as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = fields?.[k];
      if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    return '';
  };
  let text = '';
  switch (row.citation.kind) {
    case 'fact':
      text = pick('content');
      break;
    case 'directive':
      text = [pick('title'), pick('body')].filter(Boolean).join(' — ');
      break;
    case 'comment':
      text = pick('body');
      break;
    case 'outcome':
      text = pick('summary', 'body', 'title');
      break;
    case 'pr':
    case 'issue':
      text = [pick('title'), pick('body')].filter(Boolean).join(' — ');
      break;
    case 'doc':
      text = pick('content', 'body', 'excerpt');
      break;
    case 'correction':
      text = [pick('title'), pick('body')].filter(Boolean).join(' — ');
      break;
    default:
      text = pick('body', 'content', 'title', 'excerpt');
  }
  if (text.length > 1500) text = text.slice(0, 1500) + '…';
  return text;
}

/**
 * Derive a human-readable display title for a row (2026-06-11 parity pass).
 *
 * Every kind already carries a title-ish field in `fields` at retrieval time
 * — directives have frontmatter titles, PRs/issues have GitHub titles,
 * outcomes have summaries — but the citation payload historically dropped
 * them, leaving every surface to render the opaque kind:rowId handle. This
 * is THE single derivation point: composer emits, the SSE `sources` event,
 * and Symon's o8_ask all read the result.
 */
export function rowDisplayTitle(row: TypedRow): string {
  const fields = row.fields as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = fields?.[k];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    return '';
  };
  let title = '';
  switch (row.citation.kind) {
    case 'directive':
      title = pick('title');
      break;
    case 'outcome':
      title = pick('summary').split('\n')[0] ?? '';
      break;
    case 'pr':
    case 'issue':
      title = pick('title');
      break;
    case 'comment': {
      const parent = pick('parentKind') || 'thread';
      const num = fields?.parentNumber;
      const author = pick('author');
      title = `${parent}${typeof num === 'number' || typeof num === 'string' ? ` #${num}` : ''}${author ? ` — ${author}` : ''}`;
      break;
    }
    case 'doc':
      title = pick('title', 'relPath');
      break;
    case 'fact':
      title = fields?.sourceKind === 'knowledge' ? `${pick('sourceName')} · ${pick('title')}` : pick('content').split('\n')[0] ?? '';
      break;
    case 'symbol':
      title = [pick('kind'), pick('symbol')].filter(Boolean).join(' ');
      break;
    case 'project':
      title = pick('name');
      break;
    case 'project_repo':
      title = [pick('repoName'), pick('projectName')].filter(Boolean).join(' → ');
      break;
    default:
      title = pick('title', 'name', 'content');
  }
  if (!title) title = row.citation.excerpt?.replace(/[«»]/g, '') ?? row.citation.rowId;
  title = title.replace(/\s+/g, ' ').trim();
  if (title.length > 120) title = `${title.slice(0, 119)}…`;
  return title;
}

/**
 * Resolve the source-of-truth authority for a row (#915 follow-up).
 *
 * Fact rows carry the explicit `source_authority` field populated by the
 * worker / structured seeder / v18 backfill. Non-fact rows (raw directive,
 * outcome, PR, issue, comment hits) don't carry it, so we derive a default
 * from `citation.kind` matching the same hierarchy. State-aware tiers
 * (merged-vs-open PR, closed-vs-open issue) collapse to the lower bound
 * since the raw retrievers don't surface that state in `fields`. The
 * facts retriever path stays the canonical signal — non-fact retrievers
 * are coarser-grained on purpose.
 */
export function rowAuthority(row: TypedRow): number {
  const explicit = (row.fields as Record<string, unknown>)?.source_authority;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  switch (row.citation.kind) {
    case 'directive':
      return 1.0;
    case 'outcome':
      return 0.9;
    case 'pr':
      return 0.8;
    case 'issue':
      return 0.75;
    case 'comment':
      return 0.7;
    case 'correction':
      // An explicit operator ruling on a packet — below directives, above
      // agent-written outcomes.
      return 0.95;
    case 'fact':
      // No explicit field on a fact row — legacy data pre-v18 backfill.
      // 0.5 is the column default and signals "unknown" to the LLM.
      return 0.5;
    default:
      return 0.5;
  }
}

/** Build the citation handle an LLM would use in bracket notation. */
export function buildCitationHandle(row: TypedRow): string {
  const { kind, rowId } = row.citation;
  switch (kind) {
    case 'directive':
      return `D-${rowId}`;
    case 'outcome':
      return `O-${rowId}`;
    case 'pr':
      return `PR-${rowId}`;
    case 'issue':
      return `ISS-${rowId}`;
    case 'comment':
      // CMT- prefix avoids collision with the rest. The rowId is the
      // composite `<parent_kind>-<parent_number>-<gh_comment_id>` from the
      // ingestion job.
      return `CMT-${rowId}`;
    case 'symbol':
      return `SYM-${rowId}`;
    case 'project':
      return `PROJ-${rowId}`;
    case 'project_repo':
      // PRJREPO- prefix avoids collision with PR- (pull requests).
      return `PRJREPO-${rowId}`;
    case 'doc':
      // Doc rowIds are `<repoPath>:<relPath>` — too long to embed verbatim
      // in an LLM bracket. Hash deterministically to a 10-char tag so the
      // handle stays bracket-safe and the lookup map can index both forms.
      return `DOC-${shortDocHandle(rowId)}`;
    case 'correction':
      return `COR-${rowId}`;
    case 'fact':
      // Engineering Brain Indexer (#915 north star #1). Fact rowIds are short
      // ULIDs/uuids so we embed verbatim — no hashing needed. FACT- prefix
      // avoids any collision with the existing handles above.
      return `FACT-${rowId}`;
    default:
      return rowId;
  }
}

/**
 * 10-char alphanumeric hash for doc citation handles. Stable for a given
 * rowId so the LLM can re-emit the same bracket and we still resolve it.
 *
 * djb2 is overkill for ~50 docs, but cheap; collision probability across
 * the realistic doc set is well below the floor of accidental hallucinations
 * the composer already filters at translation time.
 */
function shortDocHandle(rowId: string): string {
  let hash = 5381;
  for (let i = 0; i < rowId.length; i += 1) {
    hash = ((hash << 5) + hash + rowId.charCodeAt(i)) & 0xffffffff;
  }
  // base36, padded to 8+ chars by pre-pending the length-mod-9 char so the
  // tag is fixed-width and easy to spot in the answer text.
  const tail = (hash >>> 0).toString(36).padStart(7, '0').slice(-7);
  const head = (rowId.length % 36).toString(36);
  return `${head}${tail}`.toUpperCase();
}

/**
 * Lookup tables built from topRows so the citation translator can resolve
 * whatever shape the LLM happens to emit:
 *
 *   - `exact`   maps the full bracket handle (`FACT-<full-uuid>`, `D-014`,
 *               `PR-3605666757`, etc.) and the bare rowId to its row.
 *   - `prefix`  maps a `<kind-prefix>:<lowercased-first-8-chars>` key to the
 *               row. Used to rescue abbreviated handles like `FACT-6f634881`
 *               that the Codex composer tier emits instead of the full UUID
 *               (#1118). Only populated for kinds whose rowId is long enough
 *               that an 8-char prefix is unambiguous (facts/docs/projects);
 *               populated only when exactly one row in this batch shares the
 *               prefix, so we never silently mis-attribute a citation.
 */
export interface CitationLookup {
  exact: Map<string, TypedRow>;
  prefix: Map<string, TypedRow>;
}

/** Kinds where the rowId is opaque + long enough that an 8-char prefix is
 *  meaningful for disambiguation. Adding a new kind here also requires the
 *  retriever to emit handles long enough that a prefix collision is unlikely. */
const PREFIX_FRIENDLY_KINDS: ReadonlySet<CitationKind> = new Set<CitationKind>([
  'fact',
  'doc',
  'project',
  'project_repo',
]);

/**
 * Build the exact + prefix lookup maps used by `translateCitations`. See the
 * `CitationLookup` doc above for the shape rationale.
 */
export function buildCitationLookup(rows: TypedRow[]): CitationLookup {
  const exact = new Map<string, TypedRow>();
  // Track every row keyed by `<kind>:<8-char-prefix>` along with how many rows
  // share that prefix. We only promote to the prefix map at the end when the
  // count is exactly 1 — collisions stay unresolved so we don't silently
  // mis-attribute a citation when two facts happen to share an 8-char prefix.
  const prefixCandidates = new Map<string, { row: TypedRow; count: number }>();

  for (const row of rows) {
    const handle = buildCitationHandle(row).toUpperCase();
    exact.set(handle, row);
    exact.set(row.citation.rowId.toUpperCase(), row);

    if (PREFIX_FRIENDLY_KINDS.has(row.citation.kind)) {
      // Take the first 8 chars after the kind prefix in the bracket handle
      // (e.g. `FACT-6F634881-...` → `6F634881`). That matches the Codex
      // truncation pattern; 8 chars is the empirical sweet spot — long enough
      // to be ~unique across a 30-row retrieval batch, short enough to match
      // what abbreviating LLMs emit.
      const dashIdx = handle.indexOf('-');
      if (dashIdx > 0) {
        const kindPrefix = handle.slice(0, dashIdx); // e.g. "FACT"
        const tail = handle.slice(dashIdx + 1);
        const short = tail.slice(0, 8);
        if (short.length === 8) {
          const key = `${kindPrefix}-${short}`;
          const existing = prefixCandidates.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            prefixCandidates.set(key, { row, count: 1 });
          }
        }
      }
    }
  }

  const prefix = new Map<string, TypedRow>();
  for (const [key, entry] of prefixCandidates) {
    if (entry.count === 1) prefix.set(key, entry.row);
  }

  return { exact, prefix };
}

/**
 * Resolve a single bracket handle (uppercased) to its row, trying exact match
 * first and falling back to the unambiguous-prefix index. Returns `null` when
 * neither matches.
 */
function resolveHandle(handle: string, lookup: CitationLookup): TypedRow | null {
  const exact = lookup.exact.get(handle);
  if (exact) return exact;
  // Prefix rescue: `FACT-6F634881` → `FACT-6F634881-F11A-...` when exactly
  // one row in this batch shares the 8-char tail.
  return lookup.prefix.get(handle) ?? null;
}

/**
 * Parse bracket citations like [D-014], [O-481], [PR-650], [FACT-abc123],
 * and multi-handle clusters like [FACT-aaa, FACT-bbb] from an LLM answer.
 * Returns the deduped set of handles found (uppercased).
 *
 * Character class includes `:` so spec-ingest directive handles
 * (`D-spec-ingest:cortex-ide:design:06-motifs:06-7-flat-icon-button-...`)
 * survive the shape gate (#1121).
 */
export function parseBracketHandles(answer: string): string[] {
  // Bracket body can contain multiple handles separated by `,` `;` or
  // whitespace. We grab the whole body first, then split.
  const re = /\[([^\[\]\n]+)\]/g;
  const handles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const body = m[1];
    for (const piece of body.split(/[,;\s]+/)) {
      const clean = piece.trim().toUpperCase();
      // Skip bracket bodies that don't look like citation handles (numbers,
      // free text, etc.). A handle has at least one `-` and starts with a
      // letter (kind prefix) — e.g. `D-014`, `FACT-abc`, `PR-3605`,
      // `D-spec-ingest:cortex-ide:design:...` (colons for spec-ingest IDs).
      if (/^[A-Z][A-Z0-9_\-#.:]*-[A-Z0-9_\-#.:]+$/i.test(clean)) {
        handles.push(clean);
      }
    }
  }
  return [...new Set(handles)];
}

/**
 * Translate `[BRACKET-ID]` markers in the answer to `[CITATION:<kind>-<rowId>]`
 * format that AnswerStream expects. Drops any handle not in the lookup
 * (anti-hallucination). Also handles two #1118 cases:
 *   - Abbreviated handles (`FACT-6f634881` → `FACT-6F634881-F11A-...`) via the
 *     prefix index in `lookup`.
 *   - Multi-handle clusters (`[FACT-aaa, FACT-bbb]`) — each inner handle
 *     resolves independently, the bracket is rewritten with one
 *     `[CITATION:...]` per verified handle.
 */
export function translateCitations(answer: string, lookup: CitationLookup): {
  translatedAnswer: string;
  verifiedRows: TypedRow[];
} {
  const verifiedSet = new Set<string>();
  const verifiedRows: TypedRow[] = [];

  const recordRow = (row: TypedRow): string => {
    const key = `${row.citation.kind}:${row.citation.rowId}`;
    if (!verifiedSet.has(key)) {
      verifiedSet.add(key);
      verifiedRows.push(row);
    }
    return `[CITATION:${row.citation.kind}-${row.citation.rowId}]`;
  };

  // Match any non-nested bracket body. We accept whatever's inside and then
  // split on `,` `;` or whitespace so multi-handle clusters survive.
  const translated = answer.replace(/\[([^\[\]\n]+)\]/g, (_match, body: string) => {
    const pieces = body.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
    if (pieces.length === 0) return '';
    const verified: string[] = [];
    let sawCitationShape = false;
    for (const piece of pieces) {
      const handle = piece.toUpperCase();
      // Only treat pieces that look like citation handles. Anything else
      // (e.g. raw [link text]) falls through unchanged so we don't strip
      // unrelated brackets. Colons are allowed so spec-ingest directive
      // handles (`D-spec-ingest:cortex-ide:design:...`) survive (#1121).
      if (!/^[A-Z][A-Z0-9_\-#.:]*-[A-Z0-9_\-#.:]+$/i.test(handle)) continue;
      sawCitationShape = true;
      const row = resolveHandle(handle, lookup);
      if (row) verified.push(recordRow(row));
    }
    if (!sawCitationShape) {
      // No citation-looking piece in this bracket — leave the original text alone.
      return `[${body}]`;
    }
    // All pieces looked like handles but none verified → drop the bracket
    // (anti-hallucination). Otherwise concatenate the verified CITATION markers.
    return verified.join('');
  });

  return { translatedAnswer: translated.trim(), verifiedRows };
}
