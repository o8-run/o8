/**
 * BM25 / FTS5 retriever (epic #915 sub-1).
 *
 * Runs the question (or pre-computed BM25 variants) against all five FTS5
 * indexes in parallel — outcomes, prs, issues, directives, docs — then merges
 * the per-index top-20 hits via reciprocal rank fusion (RRF).
 *
 *   RRF score = sum over indexes of 1 / (60 + rank_in_index)
 *
 * The constant 60 is the canonical "k" from the Cormack/Clarke paper
 * (Reciprocal Rank Fusion outperforms Condorcet, 2009). Higher k = flatter
 * curve; 60 gives FTS5's BM25 enough room to express confidence without
 * a single retriever's #1 hit dominating the merge.
 *
 * Sub-200ms target. FTS5 is in-process and indexed-on-write, so the cost
 * is dominated by the join from FTS rowid → parent table for excerpt
 * rendering.
 */

import 'server-only';

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path, { basename, join } from 'node:path';

import { parseDirectiveFile, type ParsedDirective } from '@/lib/cortex/directives/parse';
import {
  type DirectiveProjectScope,
  directiveAppliesToRepo,
} from '@/lib/cortex/directives/filter';
import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { isFts5Available } from '@/lib/db/v14-fts5-migration';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { parseGithubRemoteIdentity } from '@/lib/repos/github-identity';
import { requestProjectSnapshot, requestRepositoryNames } from '@/lib/repos/request-project-scope';

const PER_INDEX_LIMIT = 20;
// Comments compete with the rest of the indexes inside the FTS retriever's
// own RRF merge, then again in retrieve.ts. Capping the per-table input at
// 8 keeps comment hits from flooding the top-30 — they should be substrate
// for decisions/specs, not the dominant voice.
const PER_COMMENTS_LIMIT = 8;
const DEFAULT_LIMIT = 30;
const RRF_K = 60;
// #915 path-to-70 phase 1.7 #3 — docs are typically large and would dominate
// the merged top-30 if uncapped. 8 lets cross-repo questions that genuinely
// hinge on CLAUDE.md / README content surface relevant pages without crowding
// out directives/outcomes/PRs/issues. Tweak alongside MERGE_LIMIT in
// retrieve.ts if recall starts slipping.
const DOCS_PER_INDEX_LIMIT = 8;
// #1228 — directives get scope-filtered (directiveInScope) AFTER the FTS top-N
// cut, so out-of-scope rows (e.g. orphaned old-slug directives after a repo
// rename) used to occupy all PER_INDEX_LIMIT (20) slots and starve live ones
// out of the candidate pool entirely. Over-fetch the directives index so the
// scope-filter has enough headroom to surface in-scope directives even when
// many stale rows match. The downstream RRF merge still caps the final output.
const DIRECTIVES_PER_INDEX_LIMIT = 80;

/** Sanitize a query string for FTS5 MATCH. FTS5 is picky:
 *   - Bare punctuation = parse error
 *   - Unbalanced quotes = parse error
 *   - Empty tokens after split = parse error
 *
 * We strip everything except alphanumerics + spaces, collapse runs of
 * whitespace, and quote each token as a prefix-allowed phrase so the
 * query is robust against operator typos.
 */
function buildMatchQuery(question: string): string | null {
  if (!question?.trim()) return null;
  const tokens = question
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  // Each token becomes a prefix-allowed phrase. OR-join them so any token
  // match scores. FTS5 treats unquoted ORs as AND by default; explicit OR
  // gives recall over precision, which is what we want before the RRF + LLM
  // composer narrows down.
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

interface FtsRow {
  rowId: string;
  rank: number;
  excerpt: string;
}

function ftsSearch(
  sqlite: ReturnType<typeof getSqlite>,
  table: string,
  rowIdCol: string,
  match: string,
  limit: number = PER_INDEX_LIMIT,
): FtsRow[] {
  try {
    // bm25() returns a negative rank — lower is better. We negate so higher
    // scores are better, matching the rest of the codebase.
    const sql = `
      SELECT ${rowIdCol} AS rowId,
             -bm25(${table}) AS rank,
             snippet(${table}, -1, '«', '»', '…', 8) AS excerpt
      FROM ${table}
      WHERE ${table} MATCH ?
      ORDER BY bm25(${table})
      LIMIT ${limit}
    `;
    return sqlite.prepare(sql).all(match) as FtsRow[];
  } catch (error) {
    console.warn(
      `[qa][fts] ${table} match failed for ${JSON.stringify(match)}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

interface OutcomeRow {
  id: string;
  outcome: string;
  summary: string;
  plan_text: string | null;
  repo_path: string;
  completed_at: string;
}

interface PrRow {
  pull_request_id: number;
  number: number;
  title: string;
  url: string;
  body: string | null;
  repo_full_name: string;
}

interface IssueRow {
  issue_id: number;
  number: number;
  title: string;
  url: string;
  body: string | null;
  repo_full_name: string;
}

/** Maps directive_id → typed row. Directives have no SQL parent, so we
 *  hold the FTS title/body in the row's `fields` directly. */
interface DirectiveRow {
  directive_id: string;
  title: string;
  body: string;
}

interface CommentRow {
  id: string;
  parent_kind: 'issue' | 'pull_request';
  parent_number: number;
  repo_full_name: string;
  author_login: string | null;
  body: string;
  url: string | null;
  updated_at: string | null;
}

/** docs has a real parent table (`docs`) — pull metadata from there. */
interface DocRow {
  id: string;
  repo_path: string | null;
  repo_name: string;
  rel_path: string;
  kind: string;
  title: string;
}

function buildScope(input: RetrieverInput) {
  const active = getActiveProjectScopeForRepoSync(input.repoPath);
  const explicitRepoPath = input.repoPath?.trim();
  const normalizedExplicitRepoPath = explicitRepoPath ? path.resolve(explicitRepoPath) : null;
  const projectRepoPaths = active.repoPaths.map((repoPath) => path.resolve(repoPath));
  const repoPaths = explicitRepoPath
    ? (active.repoInActiveProject ? projectRepoPaths : [])
    : projectRepoPaths;
  const repoNames = new Set(repoPaths.map((repoPath) => basename(repoPath).toLowerCase()));
  const grantedNames = requestRepositoryNames();
  const repoFullNames = new Set<string>(grantedNames);
  let primaryRepoFullName: string | null = null;
  try {
    const registry = JSON.parse(readFileSync(join(getDataDir(), 'repos.json'), 'utf8')) as {
      repos: Array<{ localPath: string; remoteUrl?: string | null }>;
    };
    for (const repo of registry.repos) {
      const canonical = existsSync(repo.localPath) ? realpathSync(repo.localPath) : path.resolve(repo.localPath);
      if (!repoPaths.includes(canonical)) continue;
      const identity = parseGithubRemoteIdentity(repo.remoteUrl);
      if (identity.githubOwner && identity.githubRepo) {
        const fullName = `${identity.githubOwner}/${identity.githubRepo}`.toLowerCase();
        if (!grantedNames) repoFullNames.add(fullName);
        if (canonical === normalizedExplicitRepoPath) primaryRepoFullName = fullName;
      }
    }
  } catch { /* Unknown repository identity grants no remote rows. */ }
  const primaryRepoPath = active.repoInActiveProject ? normalizedExplicitRepoPath : null;
  const primaryRepoName = primaryRepoPath ? basename(primaryRepoPath).toLowerCase() : null;
  const directiveScope: DirectiveProjectScope = {
    projectIds: new Set([active.projectId.toLowerCase()]),
    projectSlugs: new Set([active.projectSlug.toLowerCase()]),
    repoInActiveProject: active.repoInActiveProject,
  };
  return { repoPaths: new Set(repoPaths), repoNames, repoFullNames, primaryRepoPath, primaryRepoName, primaryRepoFullName, directiveScope };
}

function pathInScope(repoPath: string | null | undefined, scopedPaths: Set<string>): boolean {
  if (scopedPaths.size === 0) return false;
  if (!repoPath?.trim()) return false;
  try {
    return scopedPaths.has(path.resolve(repoPath));
  } catch {
    return false;
  }
}

function repoFullNameInScope(fullName: string | null | undefined, repoNames: Set<string>): boolean {
  if (repoNames.size === 0) return false;
  const normalized = fullName?.trim().toLowerCase();
  if (!normalized) return false;
  return repoNames.has(normalized);
}

function repoPathScoreMultiplier(
  repoPath: string | null | undefined,
  scope: ReturnType<typeof buildScope>,
): number {
  if (!scope.primaryRepoPath) return 1;
  if (!repoPath?.trim()) return 1;
  try {
    return path.resolve(repoPath) === scope.primaryRepoPath ? 1.2 : 0.88;
  } catch {
    return 1;
  }
}

function repoNameScoreMultiplier(
  repoName: string | null | undefined,
  scope: ReturnType<typeof buildScope>,
): number {
  if (!scope.primaryRepoName) return 1;
  const normalized = repoName?.trim().toLowerCase();
  if (!normalized) return 1;
  return normalized === (normalized.includes('/') ? scope.primaryRepoFullName : scope.primaryRepoName) ? 1.2 : 0.88;
}

/**
 * Resolve a directive id to its on-disk filename.
 *
 * #1119 — spec-ingest writes filenames with `:` flattened to `__` so the path
 * is portable across tooling (see `spec-ingest.ts` line 297). Legacy directives
 * (seed-*, d-*) never contained `:` so their id = filename. We try the legacy
 * `<id>.md` first to preserve fast-path reads for the 100+ existing
 * directives, then fall back to the spec-ingest convention. The bug surfaced
 * as "ALL 868 spec-ingest directives silently filtered out of the FTS
 * retriever's output" — `readDirective` returned null for every one of them
 * because `directives/spec-ingest:cortex-ide:design:06-7-*.md` doesn't exist
 * on disk; only the `__`-separated variant does.
 */
function resolveDirectivePath(id: string): string | null {
  const dir = join(getDataDir(), 'directives');
  const legacyPath = join(dir, `${id}.md`);
  if (existsSync(legacyPath)) return legacyPath;
  if (id.includes(':')) {
    const flatPath = join(dir, `${id.replace(/:/g, '__')}.md`);
    if (existsSync(flatPath)) return flatPath;
  }
  return null;
}

function readDirective(id: string): ParsedDirective | null {
  try {
    const filePath = resolveDirectivePath(id);
    if (!filePath) return null;
    return parseDirectiveFile(readFileSync(filePath, 'utf-8'), id);
  } catch {
    return null;
  }
}

function directiveInScope(id: string, input: RetrieverInput, projectScope: DirectiveProjectScope): boolean {
  const parsed = readDirective(id);
  if (!parsed) return false;
  const snapshot = requestProjectSnapshot();
  if (snapshot && !['global', '', 'project'].includes(parsed.scope.toLowerCase())) {
    const selectors = [parsed.repoName?.toLowerCase(), parsed.scope.toLowerCase() !== 'repo' ? parsed.scope.toLowerCase() : null];
    return selectors.some(selector => selector && (selector.includes('/')
      ? snapshot.repositoryNames.includes(selector)
      : !snapshot.ambiguousRepoNames.includes(selector) && selector === basename(input.repoPath ?? '').toLowerCase()));
  }
  if (input.repoPath?.trim()) {
    return directiveAppliesToRepo(parsed, input.repoPath, projectScope);
  }
  const scope = parsed.scope.toLowerCase();
  if (scope === 'global' || scope === '') return true;
  if (scope !== 'project') return false;
  for (const projectId of parsed.projectIds) {
    if (projectScope.projectIds.has(projectId.toLowerCase())) return true;
  }
  for (const projectSlug of parsed.projects) {
    if (projectScope.projectSlugs.has(projectSlug.toLowerCase())) return true;
  }
  return false;
}

export async function ftsRetriever(input: RetrieverInput): Promise<RetrieverResult> {
  const start = Date.now();
  const rows: TypedRow[] = [];

  try {
    const sqlite = getSqlite();
    const scope = buildScope(input);
    if (!isFts5Available(sqlite)) {
      // FTS5 unavailable — return empty rows so the orchestrator can still
      // serve SQL + graph hits. No throw.
      return { retriever: 'fts', rows, durationMs: Date.now() - start };
    }

    // Variants come from the classifier (#1115). The grok-generated rephrasings
    // often substitute domain tokens with synonyms ("ceiling" → "limit",
    // "exempt" → "excluded") and pad each variant with stop-words, which
    // pumps BM25 scores for off-topic directives that share the stop-words
    // and starves the canonical section.
    //
    // #1122: route by question class.
    //   - Class A (lookup) → use ONLY the raw question. Class A asks "what is
    //     the X" where precise canonical phrasing beats paraphrased recall.
    //   - Class B / unknown → original behavior (variants OR question).
    //
    // Even when variants are used, the raw question is always prepended so
    // domain-specific tokens always reach BM25.
    const isClassA = input.questionClass === 'A';
    const variantBag = isClassA
      ? [input.question]
      : input.bm25Variants?.length
        ? [input.question, ...input.bm25Variants]
        : [input.question];
    const variants = Array.from(new Set(variantBag.filter((v) => v?.trim().length > 0)));
    const matches = variants
      .map((v) => buildMatchQuery(v))
      .filter((m): m is string => Boolean(m));
    if (matches.length === 0) {
      return { retriever: 'fts', rows, durationMs: Date.now() - start };
    }

    // Run a single MATCH per variant per table, take the top-N per pair, then
    // dedupe by row id (keep the best rank). FTS5 doesn't accept bound params
    // for MATCH against multiple sub-queries cleanly, so we issue one prepare
    // per variant — cheap, ≤4 variants per question by design.

    type TableHits = Map<string, { rank: number; excerpt: string }>;
    const outcomesHits: TableHits = new Map();
    const prsHits: TableHits = new Map();
    const issuesHits: TableHits = new Map();
    const directivesHits: TableHits = new Map();
    const commentsHits: TableHits = new Map();
    const docsHits: TableHits = new Map();

    const merge = (target: TableHits, hits: FtsRow[]) => {
      for (const hit of hits) {
        const prev = target.get(String(hit.rowId));
        if (!prev || hit.rank > prev.rank) {
          target.set(String(hit.rowId), { rank: hit.rank, excerpt: hit.excerpt });
        }
      }
    };

    for (const match of matches) {
      merge(outcomesHits, ftsSearch(sqlite, 'outcomes_fts', 'outcome_id', match));
      merge(prsHits, ftsSearch(sqlite, 'prs_fts', 'pr_id', match));
      merge(issuesHits, ftsSearch(sqlite, 'issues_fts', 'issue_id', match));
      // Over-fetch (#1228): scope-filtering happens after this cut, so a wider
      // candidate pool keeps orphaned old-slug rows from starving live directives.
      merge(directivesHits, ftsSearch(sqlite, 'directives_fts', 'directive_id', match, DIRECTIVES_PER_INDEX_LIMIT));
      // Comments table may not exist on installs that haven't applied schema
      // v15 yet — ftsSearch swallows the error and returns []. The retriever
      // stays no-op in that case and the rest of the FTS5 path keeps working.
      merge(
        commentsHits,
        ftsSearch(sqlite, 'comments_fts', 'comment_id', match, PER_COMMENTS_LIMIT),
      );
      // #915 path-to-70 phase 1.7 #3 — docs (CLAUDE.md / README / AGENTS.md /
      // DESIGN/THEME / docs/**). Capped at the same PER_INDEX_LIMIT (20) by
      // ftsSearch; we narrow to the top-N docs via DOCS_PER_INDEX_LIMIT below
      // so docs don't crowd out directives/outcomes/PRs/issues in the merged
      // top-30.
      merge(docsHits, ftsSearch(sqlite, 'docs_fts', 'doc_id', match));
    }

    // Convert per-table maps into ranked lists, then RRF-merge into the
    // final TypedRow output. We score = sum of 1 / (k + rank_in_table).
    const rrfScores = new Map<string, number>();
    const rrfRows = new Map<string, TypedRow>();
    const accumulate = (key: string, score: number, row: TypedRow) => {
      const prev = rrfScores.get(key) ?? 0;
      rrfScores.set(key, prev + score);
      const existing = rrfRows.get(key);
      if (existing) {
        existing.score = (existing.score ?? 0) + score;
      } else {
        rrfRows.set(key, { ...row, score });
      }
    };

    // outcomes
    if (outcomesHits.size > 0) {
      const sortedIds = [...outcomesHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const records = sqlite
        .prepare(
          `SELECT id, outcome, summary, COALESCE(plan_text, '') AS plan_text, repo_path, completed_at
           FROM session_outcomes
           WHERE id IN (${sortedIds.map(() => '?').join(',')})`,
        )
        .all(...sortedIds) as OutcomeRow[];
      const byId = new Map(records
        .filter((record) => pathInScope(record.repo_path, scope.repoPaths))
        .map((r) => [r.id, r]));
      sortedIds.forEach((id, idx) => {
        const record = byId.get(id);
        if (!record) return;
        const hit = outcomesHits.get(id)!;
        const score = (1 / (RRF_K + idx)) * repoPathScoreMultiplier(record.repo_path, scope);
        accumulate(`outcome:${id}`, score, {
          citation: {
            kind: 'outcome',
            rowId: id,
            table: 'session_outcomes',
            excerpt: hit.excerpt,
          },
          fields: {
            id: record.id,
            outcome: record.outcome,
            summary: record.summary,
            planText: record.plan_text,
            repoPath: record.repo_path,
            completedAt: record.completed_at,
          },
          score: 0,
        });
      });
    }

    // prs
    if (prsHits.size > 0) {
      const sortedIds = [...prsHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const intIds = sortedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
      if (intIds.length > 0) {
        const records = sqlite
          .prepare(
            `SELECT pull_request_id, number, title, url, body, repo_full_name
             FROM github_pull_requests
             WHERE pull_request_id IN (${intIds.map(() => '?').join(',')})`,
          )
          .all(...intIds) as PrRow[];
        const byId = new Map(records
          .filter((record) => repoFullNameInScope(record.repo_full_name, scope.repoFullNames))
          .map((r) => [String(r.pull_request_id), r]));
        sortedIds.forEach((id, idx) => {
          const record = byId.get(id);
          if (!record) return;
          const hit = prsHits.get(id)!;
          const score = (1 / (RRF_K + idx)) * repoNameScoreMultiplier(record.repo_full_name, scope);
          accumulate(`pr:${id}`, score, {
            citation: {
              kind: 'pr',
              rowId: id,
              table: 'github_pull_requests',
              url: record.url,
              excerpt: hit.excerpt,
            },
            fields: {
              id: record.pull_request_id,
              number: record.number,
              title: record.title,
              url: record.url,
              repoFullName: record.repo_full_name,
            },
            score: 0,
          });
        });
      }
    }

    // issues
    if (issuesHits.size > 0) {
      const sortedIds = [...issuesHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const intIds = sortedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
      if (intIds.length > 0) {
        const records = sqlite
          .prepare(
            `SELECT issue_id, number, title, url, body, repo_full_name
             FROM github_issues
             WHERE issue_id IN (${intIds.map(() => '?').join(',')})`,
          )
          .all(...intIds) as IssueRow[];
        const byId = new Map(records
          .filter((record) => repoFullNameInScope(record.repo_full_name, scope.repoFullNames))
          .map((r) => [String(r.issue_id), r]));
        sortedIds.forEach((id, idx) => {
          const record = byId.get(id);
          if (!record) return;
          const hit = issuesHits.get(id)!;
          const score = (1 / (RRF_K + idx)) * repoNameScoreMultiplier(record.repo_full_name, scope);
          accumulate(`issue:${id}`, score, {
            citation: {
              kind: 'issue',
              rowId: id,
              table: 'github_issues',
              url: record.url,
              excerpt: hit.excerpt,
            },
            fields: {
              id: record.issue_id,
              number: record.number,
              title: record.title,
              url: record.url,
              repoFullName: record.repo_full_name,
            },
            score: 0,
          });
        });
      }
    }

    // docs — content-backed against the `docs` parent table. Hard-cap the
    // contribution at DOCS_PER_INDEX_LIMIT so the unionMerge top-30 stays a
    // fair mix across indexes (directives + outcomes + PRs + issues + docs).
    if (docsHits.size > 0) {
      const sortedIds = [...docsHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id)
        .slice(0, DOCS_PER_INDEX_LIMIT);
      const records = sqlite
        .prepare(
          `SELECT id, repo_path, repo_name, rel_path, kind, title FROM docs
           WHERE id IN (${sortedIds.map(() => '?').join(',')})`,
        )
        .all(...sortedIds) as DocRow[];
      const byId = new Map(records
        .filter((record) => pathInScope(record.repo_path, scope.repoPaths))
        .map((r) => [r.id, r]));
      sortedIds.forEach((id, idx) => {
        const record = byId.get(id);
        if (!record) return;
        const hit = docsHits.get(id)!;
        const score = (1 / (RRF_K + idx)) * repoNameScoreMultiplier(record.repo_name, scope);
        accumulate(`doc:${id}`, score, {
          citation: {
            kind: 'doc',
            rowId: id,
            table: 'docs',
            sourcePath: record.rel_path,
            excerpt: hit.excerpt,
          },
          fields: {
            id: record.id,
            repoName: record.repo_name,
            relPath: record.rel_path,
            kind: record.kind,
            title: record.title,
          },
          score: 0,
        });
      });
    }

    // directives — title/body live in the FTS index itself.
    if (directivesHits.size > 0) {
      const sortedIds = [...directivesHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const records = sqlite
        .prepare(
          `SELECT directive_id, title, body FROM directives_fts
           WHERE directive_id IN (${sortedIds.map(() => '?').join(',')})`,
        )
        .all(...sortedIds) as DirectiveRow[];
      const byId = new Map(records
        .map((record) => ({ record, directive: readDirective(record.directive_id) }))
        .filter((entry) => entry.directive !== null
          && directiveInScope(entry.record.directive_id, input, scope.directiveScope))
        .map((entry) => [entry.record.directive_id, entry]));
      // #1228 health signal — if most directive candidates fall out of scope,
      // the repo likely has orphaned old-slug directives (a rename left them
      // stamped with the previous basename). Log loudly so it never silently
      // blanks the brain again; the fix is scripts/migrate-directive-repo-slug.ts.
      if (records.length >= 8 && byId.size / records.length < 0.5) {
        console.warn(
          `[brain-health] ${records.length - byId.size}/${records.length} directive candidates scope-filtered out for repo ${input.repoPath ?? '(none)'} — possible orphaned slug after a repo rename. Run scripts/migrate-directive-repo-slug.ts <oldSlug> <repoPath> if directives went missing.`,
        );
      }
      sortedIds.forEach((id, idx) => {
        const entry = byId.get(id);
        if (!entry?.directive) return;
        const { record, directive } = entry;
        const hit = directivesHits.get(id)!;
        const score = 1 / (RRF_K + idx);
        // #1119 — surface the on-disk filename (which uses `__` for
        // spec-ingest directives) so the citation link resolves. Falls back
        // to the raw id for legacy directives that never contained `:`.
        const sourceFileName = id.includes(':') ? id.replace(/:/g, '__') : id;
        accumulate(`directive:${id}`, score, {
          citation: {
            kind: 'directive',
            rowId: id,
            table: 'directives_fts',
            sourcePath: `~/.o8/directives/${sourceFileName}.md`,
            excerpt: hit.excerpt,
          },
          fields: {
            id: record.directive_id,
            title: record.title,
            body: record.body,
            priority: directive.priority,
          },
          score: 0,
        });
      });
    }

    // comments — join back to github_comments for author + url metadata.
    // The table may not exist on installs that haven't applied v15 yet;
    // wrap in try/catch so the rest of the retriever still returns rows.
    if (commentsHits.size > 0) {
      try {
        const sortedIds = [...commentsHits.entries()]
          .sort((a, b) => b[1].rank - a[1].rank)
          .map(([id]) => id);
        const records = sqlite
          .prepare(
            `SELECT id, parent_kind, parent_number, repo_full_name, author_login,
                    body, url, updated_at
             FROM github_comments
             WHERE id IN (${sortedIds.map(() => '?').join(',')})`,
          )
          .all(...sortedIds) as CommentRow[];
        const byId = new Map(records
          .filter((record) => repoFullNameInScope(record.repo_full_name, scope.repoFullNames))
          .map((r) => [r.id, r]));
        sortedIds.forEach((id, idx) => {
          const record = byId.get(id);
          if (!record) return;
          const hit = commentsHits.get(id)!;
          const score = (1 / (RRF_K + idx)) * repoNameScoreMultiplier(record.repo_full_name, scope);
          accumulate(`comment:${id}`, score, {
            citation: {
              kind: 'comment',
              rowId: id,
              table: 'github_comments',
              url: record.url ?? undefined,
              excerpt: hit.excerpt,
            },
            fields: {
              id: record.id,
              parentKind: record.parent_kind,
              parentNumber: record.parent_number,
              repoFullName: record.repo_full_name,
              author: record.author_login,
              body: record.body,
              url: record.url,
              updatedAt: record.updated_at,
            },
            score: 0,
          });
        });
      } catch (error) {
        // github_comments missing — pre-v15 install. Quietly skip.
        console.warn(
          '[qa][fts] comments join skipped:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    // #1119 — guarantee the top SPEC_INGEST_QUOTA spec-ingest directives
    // survive the per-retriever slice. Without this, the directive RRF score
    // (best ~0.0161 for an idx=2 hit) loses to outcomes/PRs/issues whose RRF
    // score is ~0.0167 at idx=0. The orchestrator's unionMerge wants to pin
    // the canonical spec but can't find directives to pin if they were
    // already dropped here. Quota is small (4) so non-directive rows still
    // fill 26 of the 30 returned slots.
    //
    // #1122 — reserve additional slots for ANY directive (seed-* or other
    // non-spec-ingest directive ids) so legacy seed directives that hold the
    // canonical lookup answer (e.g. `seed-cortex-ide-800-line-ceiling`) reach
    // unionMerge. Without this they're filtered out by `others.slice(limit-4)`
    // because outcome/PR/issue RRF scores beat the directive RRF.
    const SPEC_INGEST_QUOTA = 4;
    const ANY_DIRECTIVE_QUOTA = 4;
    const sorted = [...rrfRows.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const limit = input.limit ?? DEFAULT_LIMIT;
    const isDirective = (row: TypedRow): boolean => row.citation.kind === 'directive';
    const isSpecIngest = (row: TypedRow): boolean =>
      isDirective(row) &&
      typeof row.citation.rowId === 'string' &&
      row.citation.rowId.startsWith('spec-ingest:');
    const specIngestPicks = sorted.filter(isSpecIngest).slice(0, SPEC_INGEST_QUOTA);
    const reservedKeys = new Set(
      specIngestPicks.map((r) => `${r.citation.kind}:${r.citation.rowId}`),
    );
    const otherDirectivePicks = sorted
      .filter(
        (r) =>
          isDirective(r) && !reservedKeys.has(`${r.citation.kind}:${r.citation.rowId}`),
      )
      .slice(0, ANY_DIRECTIVE_QUOTA);
    for (const r of otherDirectivePicks) {
      reservedKeys.add(`${r.citation.kind}:${r.citation.rowId}`);
    }
    const reservedDirectives = [...specIngestPicks, ...otherDirectivePicks];
    const others = sorted
      .filter((r) => !reservedKeys.has(`${r.citation.kind}:${r.citation.rowId}`))
      .slice(0, Math.max(0, limit - reservedDirectives.length));
    rows.push(...reservedDirectives, ...others);
  } catch (error) {
    console.warn(
      '[qa][fts] retriever failed:',
      error instanceof Error ? error.message : error,
    );
  }

  return {
    retriever: 'fts',
    rows,
    durationMs: Date.now() - start,
  };
}
