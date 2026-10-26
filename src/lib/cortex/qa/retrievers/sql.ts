/**
 * Structured-SQL retriever (epic #915 sub-1).
 *
 * Returns deterministic typed rows for "who/when/where/what" questions by
 * joining directives ↔ session_outcomes ↔ lanes ↔ github_pull_requests ↔
 * projects on `repo_path` / `packet_id`. Sub-100ms target on the founder's
 * DB.
 *
 * Output strategy: pick the most-recent live session_outcomes for the
 * requested repo (or any repo when none specified) and emit them as typed
 * rows with citations. The orchestrator will RRF-merge these with FTS hits
 * and graph hits — so we don't need a relevance model here, just freshness.
 *
 * Ownership intent (Phase 1.4 of #915 path-to-70):
 *   When the question matches ownership keywords ("which project", "what
 *   project", "who owns", "members of project", "what's in project"), we
 *   ALSO emit `project` and `project_repo` rows joined to ~/.o8/repos.json
 *   so the composer can answer "which project does cortex-ide belong to?"
 *   without ever falling back to vector search. Outcomes still emit on
 *   every run — ownership rows just stack on top.
 */

import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { getSqlite } from '@/lib/db';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { requestProjectSnapshot } from '@/lib/repos/request-project-scope';
import { parseGithubRemoteIdentity } from '@/lib/repos/github-identity';
import { getDataDir } from '@/lib/data-dir-migration';

const DEFAULT_LIMIT = 20;

interface OutcomeQueryIntent {
  since?: string;
  before?: string;
  runtime?: string;
  packetsOnly: boolean;
  shippedOnly: boolean;
}
interface OutcomeRow {
  id: string;
  repo_path: string;
  branch: string | null;
  runtime: string;
  outcome: string;
  summary: string;
  plan_text: string | null;
  packet_id: string | null;
  lane_id: string | null;
  completed_at: string;
  pr_number: number | null;
  pr_title: string | null;
  pr_url: string | null;
  pr_id: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

interface ProjectRepoRow {
  project_id: string;
  repo_id: string;
  role: string | null;
  suggestion_origin: string;
}

interface RegistryRepo {
  id: string;
  name: string;
  localPath: string;
  remoteUrl?: string | null;
}

// ── Ownership intent detection ───────────────────────────────────────────────

/**
 * Lightweight keyword match for ownership / project / membership questions.
 * Cheap (single regex pass) and deterministic — sits in front of the more
 * expensive project queries so the default outcome path stays sub-100ms when
 * no project signal is needed.
 *
 * The classifier (Flash) sits one layer up and emits BM25 variants — those
 * help the FTS retriever, but project rows aren't BM25-indexed, so we need
 * an explicit keyword check here.
 */
function isOwnershipQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  return (
    /\bwhich project\b/.test(lower) ||
    /\bwhat project\b/.test(lower) ||
    /\bwhat\s+(?:other\s+)?(?:repos?|repositories)\b/.test(lower) ||
    /\bwho owns\b/.test(lower) ||
    /\bowner of\b/.test(lower) ||
    /\bmembers? of (?:the )?project\b/.test(lower) ||
    /\bin (?:the )?project\b/.test(lower) ||
    /\bwhat'?s? in project\b/.test(lower) ||
    /\bbelongs? to\b/.test(lower) ||
    /\bpart of (?:the )?(?:project|o8|product)\b/.test(lower) ||
    // "repo X" / "project X" naming probes
    /\bproject\s+\w+/.test(lower)
  );
}

function canonicalRepoPathForScope(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  const marker = `${path.sep}.cortex-worktrees${path.sep}`;
  const markerIdx = resolved.indexOf(marker);
  return markerIdx > 0 ? resolved.slice(0, markerIdx) : resolved;
}

function isoLocalDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function detectOutcomeQueryIntent(question: string): OutcomeQueryIntent | null {
  const lower = question.toLowerCase();
  const outcomeSignal =
    /\bpackets?\b/.test(lower) ||
    /\bship(?:ped)?\b/.test(lower) ||
    /\bmerged?\b/.test(lower) ||
    /\bsession outcomes?\b/.test(lower);
  if (!outcomeSignal) return null;

  let runtime: string | undefined;
  if (/\bcodex\b/.test(lower)) runtime = 'codex';
  else if (/\bclaude(?: code)?\b/.test(lower)) runtime = 'claude-code';
  else if (/\bgemini\b/.test(lower)) runtime = 'gemini';
  else if (/\bopencode\b/.test(lower)) runtime = 'opencode';

  let since: string | undefined;
  let before: string | undefined;
  if (/\byesterday\b/.test(lower)) {
    since = isoLocalDay(-1);
    before = isoLocalDay(0);
  } else if (/\btoday\b/.test(lower)) {
    since = isoLocalDay(0);
    before = isoLocalDay(1);
  } else if (/\bthis week\b/.test(lower)) {
    since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  return {
    since,
    before,
    runtime,
    packetsOnly: /\bpackets?\b/.test(lower),
    shippedOnly: /\bship(?:ped)?\b/.test(lower) || /\bmerged?\b/.test(lower),
  };
}

// ── Repo registry (sync read) ────────────────────────────────────────────────

const REPO_REGISTRY_PATH = path.join(getDataDir(), 'repos.json');

/** Sync read of the repo registry. Returns [] on any error so the retriever
 *  never throws. */
function readRepoRegistrySync(): RegistryRepo[] {
  try {
    if (!existsSync(REPO_REGISTRY_PATH)) return [];
    const raw = readFileSync(REPO_REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { repos?: unknown };
    if (!parsed || !Array.isArray(parsed.repos)) return [];
    const repos: RegistryRepo[] = [];
    for (const entry of parsed.repos as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id : null;
      const name = typeof rec.name === 'string' ? rec.name : null;
      const localPath = typeof rec.localPath === 'string'
        ? rec.localPath
        : typeof rec.path === 'string'
          ? rec.path
          : null;
      if (!id || !name || !localPath) continue;
      repos.push({ id, name, localPath, remoteUrl: typeof rec.remoteUrl === 'string' ? rec.remoteUrl : null });
    }
    return repos;
  } catch (error) {
    console.warn(
      '[qa][sql] repo registry read failed:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// ── Project rows ─────────────────────────────────────────────────────────────

/**
 * Emit project + project_repo rows for ownership intent.
 *
 * Strategy:
 *   1. If `repoPath` is set, find that repo in the registry and emit every
 *      project it belongs to (plus all sibling project_repos rows so the
 *      composer can list teammates).
 *   2. If `projectId` is set OR no repoPath, list all projects + repos —
 *      bounded by `limit` so we never flood the merge.
 *
 * The composer renders project rows as `[PROJ-<id>]` and project_repo rows
 * as `[PRJREPO-<repoId>]` — see `buildCitationHandle` in composer.ts.
 */
function emitProjectRows(
  sqlite: ReturnType<typeof getSqlite>,
  input: RetrieverInput,
  rows: TypedRow[],
  limit: number,
): void {
  const snapshot = requestProjectSnapshot();
  const registry = snapshot?.repositories ?? readRepoRegistrySync();
  const repoById = new Map(registry.map((r) => [r.id, r]));

  // Resolve target project_ids: from explicit projectId, from repoPath, or
  // ALL projects when neither is set.
  const targetProjectIds = new Set<string>();

  if (input.projectId) {
    targetProjectIds.add(input.projectId);
  }

  if (input.repoPath && !snapshot) {
    const target = path.resolve(input.repoPath);
    const repo = registry.find((r) => path.resolve(r.localPath) === target);
    if (repo) {
      // Find every project this repo participates in.
      const projectLinks = sqlite
        .prepare('SELECT project_id FROM project_repos WHERE repo_id = ?')
        .all(repo.id) as Array<{ project_id: string }>;
      for (const link of projectLinks) targetProjectIds.add(link.project_id);
    }
  }

  // No specific scope — pull every project (capped). Useful for "list the
  // projects" / cross-repo questions that don't pin a single repo.
  let projects: ProjectRow[];
  if (snapshot) {
    projects = [snapshot.project];
  } else if (targetProjectIds.size > 0) {
    const ids = [...targetProjectIds];
    projects = sqlite
      .prepare(
        `SELECT id, name, slug, description FROM projects
         WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as ProjectRow[];
  } else {
    projects = sqlite
      .prepare('SELECT id, name, slug, description FROM projects ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as ProjectRow[];
  }

  if (projects.length === 0) return;

  // Pre-fetch every project_repos row for the projects in scope (one round-
  // trip, not N) so the composer can describe membership without re-querying.
  const projectIds = projects.map((p) => p.id);
  const links: ProjectRepoRow[] = snapshot ? snapshot.project.repos
    .filter(link => snapshot.repositories.some(repo => repo.id === link.repoId))
    .map(link => ({ project_id: link.projectId, repo_id: link.repoId, role: link.role,
      suggestion_origin: link.suggestionOrigin })) : sqlite
    .prepare(
      `SELECT project_id, repo_id, role, suggestion_origin FROM project_repos
       WHERE project_id IN (${projectIds.map(() => '?').join(',')})`,
    )
    .all(...projectIds) as ProjectRepoRow[];

  const linksByProject = new Map<string, ProjectRepoRow[]>();
  for (const link of links) {
    const list = linksByProject.get(link.project_id) ?? [];
    list.push(link);
    linksByProject.set(link.project_id, list);
  }

  for (const project of projects) {
    const projectLinks = linksByProject.get(project.id) ?? [];
    const repoSummaries = projectLinks
      .map((link) => {
        const repo = repoById.get(link.repo_id);
        const repoLabel = repo ? repo.name : link.repo_id;
        return link.role ? `${repoLabel} (${link.role})` : repoLabel;
      })
      .join(', ');
    const excerpt = repoSummaries
      ? `${project.name} — repos: ${repoSummaries}`
      : project.description ?? project.name;

    rows.push({
      citation: {
        kind: 'project',
        rowId: project.id,
        table: 'projects',
        excerpt: excerpt.length > 160 ? `${excerpt.slice(0, 157)}…` : excerpt,
      },
      fields: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        repos: projectLinks.map((link) => {
          const repo = repoById.get(link.repo_id);
          return {
            repoId: link.repo_id,
            repoName: repo?.name ?? null,
            repoPath: repo?.localPath ?? null,
            role: link.role,
            suggestionOrigin: link.suggestion_origin,
          };
        }),
      },
      score: 1,
    });

    // Emit one project_repo row per link so the composer can cite "cortex-ide
    // is the fullstack repo in o8 [PRJREPO-...]" with row-level provenance.
    for (const link of projectLinks) {
      const repo = repoById.get(link.repo_id);
      const repoLabel = repo ? repo.name : link.repo_id;
      const linkExcerpt = link.role
        ? `${repoLabel} → ${project.name} (role: ${link.role})`
        : `${repoLabel} → ${project.name}`;
      rows.push({
        citation: {
          kind: 'project_repo',
          // repoId is the canonical handle — there's a unique
          // (project_id, repo_id) pair so within a project's context
          // it's unambiguous, and the eval cases reference rowIds
          // shaped like the registry uuid.
          rowId: link.repo_id,
          table: 'project_repos',
          excerpt: linkExcerpt,
        },
        fields: {
          projectId: link.project_id,
          projectName: project.name,
          projectSlug: project.slug,
          repoId: link.repo_id,
          repoName: repo?.name ?? null,
          repoPath: repo?.localPath ?? null,
          role: link.role,
          suggestionOrigin: link.suggestion_origin,
        },
        score: 1,
      });
    }
  }
}

export async function sqlRetriever(input: RetrieverInput): Promise<RetrieverResult> {
  const start = Date.now();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const rows: TypedRow[] = [];

  try {
    const sqlite = getSqlite();
    const params: Array<string | number> = [];
    const where: string[] = ['so.valid_to IS NULL'];
    const orderParams: Array<string | number> = [];
    const scopedRepoPath = input.repoPath ? canonicalRepoPathForScope(input.repoPath) : null;
    const outcomeIntent = detectOutcomeQueryIntent(input.question);

    if (scopedRepoPath) {
      const active = getActiveProjectScopeForRepoSync(scopedRepoPath);
      if (active.repoInActiveProject && active.repoPaths.length > 0) {
        const scopedRepoPaths = Array.from(new Set([
          path.resolve(scopedRepoPath),
          ...active.repoPaths.map((repoPath) => path.resolve(repoPath)),
        ]));
        where.push(`so.repo_path IN (${scopedRepoPaths.map(() => '?').join(',')})`);
        params.push(...scopedRepoPaths);
        orderParams.push(path.resolve(scopedRepoPath));
      } else {
        where.push('so.repo_path = ?');
        params.push(scopedRepoPath);
      }
    }
    if (input.projectId) {
      where.push('so.project_id = ?');
      params.push(input.projectId);
    }
    if (outcomeIntent?.runtime) {
      where.push('so.runtime = ?');
      params.push(outcomeIntent.runtime);
    }
    if (outcomeIntent?.since) {
      where.push('datetime(so.completed_at) >= datetime(?)');
      params.push(outcomeIntent.since);
    }
    if (outcomeIntent?.before) {
      where.push('datetime(so.completed_at) < datetime(?)');
      params.push(outcomeIntent.before);
    }
    if (outcomeIntent?.packetsOnly) {
      where.push("so.packet_id IS NOT NULL AND so.packet_id != ''");
    }
    if (outcomeIntent?.shippedOnly) {
      where.push("so.outcome = 'succeeded'");
    }

    // A shared branch name is not repository identity. Resolve each outcome's
    // full repository name before selecting its newest matching PR.
    const joinParams: string[] = [];
    const registry = requestProjectSnapshot()?.repositories ?? readRepoRegistrySync();
    const repositoryCases = registry.flatMap(repo => {
      const identity = parseGithubRemoteIdentity(repo.remoteUrl);
      if (!identity.githubOwner || !identity.githubRepo) return [];
      joinParams.push(canonicalRepoPathForScope(repo.localPath), `${identity.githubOwner}/${identity.githubRepo}`.toLowerCase());
      return ['WHEN ? THEN ?'];
    });
    const repositoryCase = repositoryCases.length ? `CASE so.repo_path ${repositoryCases.join(' ')} END` : 'NULL';
    const sql = `
      SELECT
        so.id,
        so.repo_path,
        so.branch,
        so.runtime,
        so.outcome,
        so.summary,
        so.plan_text,
        so.packet_id,
        so.lane_id,
        so.completed_at,
        pr.number AS pr_number,
        pr.title AS pr_title,
        pr.url AS pr_url,
        pr.pull_request_id AS pr_id
      FROM session_outcomes so
      LEFT JOIN github_pull_requests pr ON pr.pull_request_id = (
        SELECT MAX(p.pull_request_id) FROM github_pull_requests p
        WHERE p.head_ref_name = so.branch AND lower(p.repo_full_name) = ${repositoryCase}
      )
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderParams.length > 0 ? 'CASE WHEN so.repo_path = ? THEN 0 ELSE 1 END,' : ''} so.completed_at DESC
      LIMIT ?
    `;
    params.push(...orderParams, limit);

    const records = sqlite.prepare(sql).all(...joinParams, ...params) as OutcomeRow[];

    for (const record of records) {
      const excerpt = record.summary.length > 160
        ? `${record.summary.slice(0, 157)}…`
        : record.summary;
      rows.push({
        citation: {
          kind: 'outcome',
          rowId: record.id,
          table: 'session_outcomes',
          excerpt,
        },
        fields: {
          id: record.id,
          repoPath: record.repo_path,
          branch: record.branch,
          runtime: record.runtime,
          outcome: record.outcome,
          summary: record.summary,
          planText: record.plan_text,
          packetId: record.packet_id,
          laneId: record.lane_id,
          completedAt: record.completed_at,
          prNumber: record.pr_number,
          prTitle: record.pr_title,
          prUrl: record.pr_url,
          retrievalIntent: outcomeIntent ? 'recent_session_outcomes' : undefined,
        },
        score: 1,
      });

      // When a PR is attached, emit a sibling pr citation so RRF can rank
      // the outcome and the PR separately. Cheap — one extra row per match.
      if (record.pr_id != null && record.pr_url) {
        rows.push({
          citation: {
            kind: 'pr',
            rowId: String(record.pr_id),
            table: 'github_pull_requests',
            url: record.pr_url,
            excerpt: record.pr_title ?? undefined,
          },
          fields: {
            id: record.pr_id,
            number: record.pr_number,
            title: record.pr_title,
            url: record.pr_url,
            outcomeId: record.id,
          },
          score: 1,
        });
      }
    }

    // Ownership/project intent — emit project + project_repo rows when the
    // question is asking about membership/ownership, or when the caller
    // already pinned a projectId. Stacks on top of the outcomes path so RRF
    // gets both signals.
    if (input.projectId || isOwnershipQuestion(input.question)) {
      try {
        emitProjectRows(sqlite, input, rows, limit);
      } catch (error) {
        console.warn(
          '[qa][sql] project rows failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  } catch (error) {
    console.warn(
      '[qa][sql] retriever failed:',
      error instanceof Error ? error.message : error,
    );
  }

  return {
    retriever: 'sql',
    rows,
    durationMs: Date.now() - start,
  };
}
