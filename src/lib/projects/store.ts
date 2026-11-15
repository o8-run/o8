/**
 * Projects storage — better-sqlite3 directly (matches the rest of the SQLite
 * surface; Drizzle is reserved for the schema-owning tables in `@/lib/db`).
 *
 * The schema lives in `@/lib/db` (v11 migration); this file is the read/write
 * layer used by the API routes and the cortex MCP tools.
 */

import 'server-only';

import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { projectMergeModeKey } from '@/lib/lane/project-merge-mode-migration';
import type {
  Project,
  ProjectRepo,
  ProjectRole,
  ProjectWithRepos,
  SuggestionOrigin,
} from './types';

// ── Helpers ──

function db() {
  return getSqlite();
}

function nowMs(): number {
  return Date.now();
}

/** Recognize the persisted primary-key format emitted by this store, not a panel alias. */
export function isGeneratedProjectId(value: string): boolean {
  return /^proj-[0-9a-f]{8}-[0-9a-f]{3}$/.test(value);
}

function generateProjectId(): string {
  return `proj-${randomUUID().slice(0, 12)}`;
}

/**
 * Slugify a name into a URL-safe identifier. Uniqueness is guarded by the
 * UNIQUE index on `projects.slug`; collisions append a numeric suffix.
 */
function slugifyName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'project';
}

function makeUniqueSlug(sqlite: ReturnType<typeof db>, requested: string, ownerProjectId?: string): string {
  const base = requested.trim().toLowerCase() || 'project';
  const slugOwner = sqlite.prepare('SELECT id FROM projects WHERE slug = ? LIMIT 1');
  let slug = base;
  let suffix = 2;

  while (true) {
    const row = slugOwner.get(slug) as { id: string } | undefined;
    if (!row || row.id === ownerProjectId) return slug;
    if (suffix > 999) {
      throw new Error(`Could not find a unique slug starting with "${base}".`);
    }
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  main_repo_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ProjectRepoRow {
  project_id: string;
  repo_id: string;
  role: string | null;
  suggestion_origin: string;
  added_at: number;
}

function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    mainRepoId: row.main_repo_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectRepoRow(row: ProjectRepoRow): ProjectRepo {
  return {
    projectId: row.project_id,
    repoId: row.repo_id,
    role: (row.role as ProjectRole | null) ?? null,
    suggestionOrigin: row.suggestion_origin as SuggestionOrigin,
    addedAt: row.added_at,
  };
}

// ── Project CRUD ──

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string | null;
  mainRepoId?: string | null;
  /** Internal identity migration only; never accepted from a request body. */
  mergeModeSourceProjectId?: string;
}

export function createProject(input: CreateProjectInput): Project {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    throw new Error('Project name is required.');
  }

  const sqlite = db();
  const now = nowMs();
  const id = generateProjectId();
  const description = input.description?.trim() || null;
  const mainRepoId = input.mainRepoId?.trim() || null;

  // Pick a slug: explicit > slugified name. Collisions append -2, -3, etc.
  const requested = (input.slug?.trim() || slugifyName(trimmedName)).toLowerCase();
  const slug = makeUniqueSlug(sqlite, requested);

  sqlite.transaction(() => {
    sqlite.prepare(
      `INSERT INTO projects (id, name, slug, description, main_repo_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, trimmedName, slug, description, mainRepoId, now, now);
    if (input.mergeModeSourceProjectId) {
      sqlite.prepare(`INSERT OR IGNORE INTO app_state (key, value, updated_at)
        SELECT ?, value, ? FROM app_state WHERE key = ?`)
        .run(projectMergeModeKey(id), now, projectMergeModeKey(input.mergeModeSourceProjectId));
    }
  })();

  return {
    id,
    name: trimmedName,
    slug,
    description,
    mainRepoId,
    createdAt: now,
    updatedAt: now,
  };
}

export function getProject(id: string): Project | null {
  const row = db().prepare(
    'SELECT id, name, slug, description, main_repo_id, created_at, updated_at FROM projects WHERE id = ?',
  ).get(id) as ProjectRow | undefined;
  return row ? mapProjectRow(row) : null;
}

export function getProjectBySlug(slug: string): Project | null {
  const row = db().prepare(
    'SELECT id, name, slug, description, main_repo_id, created_at, updated_at FROM projects WHERE slug = ?',
  ).get(slug) as ProjectRow | undefined;
  return row ? mapProjectRow(row) : null;
}

function listReposForProject(projectId: string): ProjectRepo[] {
  const rows = db().prepare(
    `SELECT project_id, repo_id, role, suggestion_origin, added_at
     FROM project_repos
     WHERE project_id = ?
     ORDER BY added_at ASC`,
  ).all(projectId) as ProjectRepoRow[];
  return rows.map(mapProjectRepoRow);
}

export function getProjectWithRepos(id: string): ProjectWithRepos | null {
  const project = getProject(id);
  if (!project) return null;
  return { ...project, repos: listReposForProject(id) };
}

export function listProjects(): ProjectWithRepos[] {
  const sqlite = db();
  const projects = sqlite.prepare(
    `SELECT id, name, slug, description, main_repo_id, created_at, updated_at
     FROM projects
     ORDER BY created_at DESC`,
  ).all() as ProjectRow[];
  if (projects.length === 0) return [];

  // Single fetch of all repos, then bucket by project_id — avoids N queries.
  const repoRows = sqlite.prepare(
    `SELECT project_id, repo_id, role, suggestion_origin, added_at
     FROM project_repos
     ORDER BY added_at ASC`,
  ).all() as ProjectRepoRow[];

  const reposByProject = new Map<string, ProjectRepo[]>();
  for (const row of repoRows) {
    const list = reposByProject.get(row.project_id) ?? [];
    list.push(mapProjectRepoRow(row));
    reposByProject.set(row.project_id, list);
  }

  return projects.map((row) => ({
    ...mapProjectRow(row),
    repos: reposByProject.get(row.id) ?? [],
  }));
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  description?: string | null;
  mainRepoId?: string | null;
}

export function updateProject(id: string, input: UpdateProjectInput): Project | null {
  const existing = getProject(id);
  if (!existing) return null;

  const sqlite = db();
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  let nextName = existing.name;

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new Error('Project name cannot be empty.');
    }
    updates.push('name = ?');
    values.push(trimmed);
    nextName = trimmed;
  }

  const requestedSlug = input.slug !== undefined
    ? input.slug.trim()
    : input.name !== undefined
      ? slugifyName(nextName)
      : '';
  if (requestedSlug) {
    updates.push('slug = ?');
    values.push(makeUniqueSlug(sqlite, requestedSlug, id));
  }
  if (input.description !== undefined) {
    const trimmed = input.description?.trim() ?? null;
    updates.push('description = ?');
    values.push(trimmed && trimmed.length > 0 ? trimmed : null);
  }
  if (input.mainRepoId !== undefined) {
    const mainRepoId = input.mainRepoId?.trim() || null;
    if (mainRepoId) {
      const linked = sqlite.prepare(
        'SELECT 1 FROM project_repos WHERE project_id = ? AND repo_id = ? LIMIT 1',
      ).get(id, mainRepoId);
      if (!linked) {
        throw new Error('Main repo must be linked to the project.');
      }
    }
    updates.push('main_repo_id = ?');
    values.push(mainRepoId);
  }

  if (updates.length === 0) {
    return existing;
  }

  const now = nowMs();
  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  sqlite.prepare(
    `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`,
  ).run(...values);

  return getProject(id);
}

export function deleteProject(id: string): boolean {
  const result = db().prepare('DELETE FROM projects WHERE id = ?').run(id);
  // The FK on project_repos.project_id is ON DELETE CASCADE so no separate
  // cleanup is required.
  return (result.changes ?? 0) > 0;
}

// ── Project ↔ Repo links ──

export function addRepoToProject(
  projectId: string,
  repoId: string,
  role: ProjectRole | null = null,
  suggestionOrigin: SuggestionOrigin = 'manual',
): ProjectRepo {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const now = nowMs();
  const sqlite = db();

  // INSERT OR REPLACE so re-adding refreshes role/origin. We treat repeat
  // calls as "ensure this link exists with these attributes" rather than an
  // error — the orchestrator should be free to call this idempotently.
  sqlite.prepare(
    `INSERT INTO project_repos (project_id, repo_id, role, suggestion_origin, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, repo_id) DO UPDATE SET
       role = excluded.role,
       suggestion_origin = excluded.suggestion_origin`,
  ).run(projectId, repoId, role, suggestionOrigin, now);

  // Bump the project's updated_at so listProjects ordering stays sensible.
  sqlite.prepare(
    `UPDATE projects
     SET updated_at = ?,
         main_repo_id = COALESCE(main_repo_id, ?)
     WHERE id = ?`,
  ).run(now, repoId, projectId);

  const row = sqlite.prepare(
    `SELECT project_id, repo_id, role, suggestion_origin, added_at
     FROM project_repos
     WHERE project_id = ? AND repo_id = ?`,
  ).get(projectId, repoId) as ProjectRepoRow;
  return mapProjectRepoRow(row);
}

export function removeRepoFromProject(projectId: string, repoId: string): boolean {
  const sqlite = db();
  const project = getProject(projectId);
  const result = sqlite.prepare(
    'DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?',
  ).run(projectId, repoId);
  if ((result.changes ?? 0) > 0) {
    let nextMainRepoId = project?.mainRepoId ?? null;
    if (nextMainRepoId === repoId) {
      const fallback = sqlite.prepare(
        `SELECT repo_id FROM project_repos
         WHERE project_id = ?
         ORDER BY added_at ASC
         LIMIT 1`,
      ).get(projectId) as { repo_id: string } | undefined;
      nextMainRepoId = fallback?.repo_id ?? null;
    }
    sqlite.prepare('UPDATE projects SET updated_at = ?, main_repo_id = ? WHERE id = ?').run(nowMs(), nextMainRepoId, projectId);
    return true;
  }
  return false;
}

export function removeRepoFromAllProjects(repoId: string): number {
  const sqlite = db();
  const affectedProjects = sqlite.prepare(
    'SELECT DISTINCT project_id FROM project_repos WHERE repo_id = ?',
  ).all(repoId) as Array<{ project_id: string }>;
  if (affectedProjects.length === 0) return 0;

  const now = nowMs();
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM project_repos WHERE repo_id = ?').run(repoId);
    for (const { project_id: projectId } of affectedProjects) {
      const project = getProject(projectId);
      let nextMainRepoId = project?.mainRepoId ?? null;
      if (nextMainRepoId === repoId) {
        const fallback = sqlite.prepare(
          `SELECT repo_id FROM project_repos
           WHERE project_id = ?
           ORDER BY added_at ASC
           LIMIT 1`,
        ).get(projectId) as { repo_id: string } | undefined;
        nextMainRepoId = fallback?.repo_id ?? null;
      }
      sqlite.prepare('UPDATE projects SET updated_at = ?, main_repo_id = ? WHERE id = ?')
        .run(now, nextMainRepoId, projectId);
    }
  });
  tx();
  return affectedProjects.length;
}

export function setRepoRole(
  projectId: string,
  repoId: string,
  role: ProjectRole | null,
): ProjectRepo | null {
  const sqlite = db();
  const result = sqlite.prepare(
    'UPDATE project_repos SET role = ? WHERE project_id = ? AND repo_id = ?',
  ).run(role, projectId, repoId);
  if ((result.changes ?? 0) === 0) return null;

  sqlite.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowMs(), projectId);

  const row = sqlite.prepare(
    `SELECT project_id, repo_id, role, suggestion_origin, added_at
     FROM project_repos
     WHERE project_id = ? AND repo_id = ?`,
  ).get(projectId, repoId) as ProjectRepoRow | undefined;
  return row ? mapProjectRepoRow(row) : null;
}

export function setProjectMainRepo(projectId: string, repoId: string | null): Project | null {
  const project = getProject(projectId);
  if (!project) return null;
  const normalizedRepoId = repoId?.trim() || null;
  if (normalizedRepoId) {
    const linked = db().prepare(
      'SELECT 1 FROM project_repos WHERE project_id = ? AND repo_id = ? LIMIT 1',
    ).get(projectId, normalizedRepoId);
    if (!linked) {
      throw new Error('Main repo must be linked to the project.');
    }
  }
  db().prepare(
    'UPDATE projects SET main_repo_id = ?, updated_at = ? WHERE id = ?',
  ).run(normalizedRepoId, nowMs(), projectId);
  return getProject(projectId);
}

/**
 * Return every project that lists the given repo. Used by the directive scope
 * resolver and the cross-repo activity feed — both ask "what projects does
 * this repo participate in?" before fanning out signals.
 */
export function listProjectsByRepoId(repoId: string): ProjectWithRepos[] {
  const sqlite = db();
  const rows = sqlite.prepare(
    `SELECT p.id, p.name, p.slug, p.description, p.main_repo_id, p.created_at, p.updated_at
     FROM projects p
     INNER JOIN project_repos pr ON pr.project_id = p.id
     WHERE pr.repo_id = ?
     ORDER BY p.created_at DESC`,
  ).all(repoId) as ProjectRow[];

  if (rows.length === 0) return [];

  return rows.map((row) => ({
    ...mapProjectRow(row),
    repos: listReposForProject(row.id),
  }));
}

// ── Dismissed suggestions ──

export function recordDismissedSuggestion(fingerprint: string, reason?: string | null): void {
  if (!fingerprint) {
    throw new Error('Fingerprint is required.');
  }
  db().prepare(
    `INSERT INTO dismissed_suggestions (fingerprint, dismissed_at, reason)
     VALUES (?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       dismissed_at = excluded.dismissed_at,
       reason = excluded.reason`,
  ).run(fingerprint, nowMs(), reason ?? null);
}

export function isDismissed(fingerprint: string): boolean {
  if (!fingerprint) return false;
  const row = db().prepare(
    'SELECT 1 FROM dismissed_suggestions WHERE fingerprint = ? LIMIT 1',
  ).get(fingerprint);
  return Boolean(row);
}

/**
 * Return every dismissed suggestion fingerprint. Used by the Settings UI to
 * filter the GitHub-org auto-suggest strip in one round-trip rather than
 * issuing per-fingerprint `isDismissed` lookups.
 */
export function listDismissedFingerprints(): string[] {
  const rows = db().prepare(
    'SELECT fingerprint FROM dismissed_suggestions ORDER BY dismissed_at DESC',
  ).all() as Array<{ fingerprint: string }>;
  return rows.map((row) => row.fingerprint);
}
