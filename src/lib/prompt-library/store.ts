import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';

export const PROMPT_LIBRARY_TITLE_MAX = 120;
export const PROMPT_LIBRARY_BODY_MAX = 100_000;
export const PROMPT_LIBRARY_TAG_MAX = 32;
export const PROMPT_LIBRARY_TAG_COUNT_MAX = 12;
export const PROMPT_LIBRARY_QUERY_MAX = 200;
export const PROMPT_LIBRARY_LIST_LIMIT_MAX = 100;
export const PROMPT_LIBRARY_REPO_PATH_MAX = 4_096;
export const PROMPT_LIBRARY_SOURCE_ID_MAX = 512;
export const PROMPT_LIBRARY_IMPORT_MAX = 100;

export type PromptLibraryScope = 'global' | 'repo';
export type PromptLibrarySourceKind = 'manual' | 'automation' | 'watched_agent';
export type PromptLibraryScopeFilter = 'available' | 'global' | 'repo' | 'all';

export interface PromptLibraryEntry {
  id: string;
  title: string;
  body: string;
  tags: string[];
  scope: PromptLibraryScope;
  repoPath: string | null;
  sourceKind: PromptLibrarySourceKind;
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export interface CreatePromptLibraryEntryInput {
  title: string;
  body: string;
  tags?: string[];
  scope?: PromptLibraryScope;
  repoPath?: string | null;
  sourceKind?: PromptLibrarySourceKind;
  sourceId?: string | null;
}

export interface UpdatePromptLibraryEntryInput {
  expectedUpdatedAt?: number;
  title?: string;
  body?: string;
  tags?: string[];
  scope?: PromptLibraryScope;
  repoPath?: string | null;
}

export interface ListPromptLibraryEntriesInput {
  query?: string;
  scope?: PromptLibraryScopeFilter;
  repoPath?: string | null;
  limit?: number;
}

export interface PromptLibraryImportSource {
  key: string;
  sourceKind: Extract<PromptLibrarySourceKind, 'automation' | 'watched_agent'>;
  sourceId: string;
  title: string;
  preview: string;
  repoPath: string;
}

export interface PromptLibraryImportRef {
  sourceKind: PromptLibraryImportSource['sourceKind'];
  sourceId: string;
}

interface PromptLibraryImportRow {
  source_kind: PromptLibraryImportSource['sourceKind'];
  source_id: string;
  title: string;
  body: string;
  repo_path: string;
}

interface PromptLibraryRow {
  id: string;
  title: string;
  body: string;
  body_fingerprint: string;
  tags_json: string;
  scope: PromptLibraryScope;
  repo_path: string | null;
  source_kind: PromptLibrarySourceKind;
  source_id: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
}

export class PromptLibraryValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PromptLibraryValidationError';
  }
}

export class PromptLibraryDuplicateError extends Error {
  constructor(public readonly existing: PromptLibraryEntry) {
    super('A prompt with this body already exists in the selected scope.');
    this.name = 'PromptLibraryDuplicateError';
  }
}

function rowToEntry(row: PromptLibraryRow): PromptLibraryEntry {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) {
      tags = parsed.filter((tag): tag is string => typeof tag === 'string');
    }
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags,
    scope: row.scope,
    repoPath: row.repo_path,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (!title) {
    throw new PromptLibraryValidationError('title_required', 'A prompt title is required.');
  }
  if (title.length > PROMPT_LIBRARY_TITLE_MAX) {
    throw new PromptLibraryValidationError(
      'title_too_long',
      `Prompt titles must be ${PROMPT_LIBRARY_TITLE_MAX} characters or fewer.`,
    );
  }
  return title;
}

function normalizeBody(value: string): string {
  const body = value.replace(/\r\n?/g, '\n').trim();
  if (!body) {
    throw new PromptLibraryValidationError('body_required', 'Prompt text is required.');
  }
  if (body.length > PROMPT_LIBRARY_BODY_MAX) {
    throw new PromptLibraryValidationError(
      'body_too_long',
      `Prompt text must be ${PROMPT_LIBRARY_BODY_MAX} characters or fewer.`,
    );
  }
  return body;
}

function normalizeTags(values: string[]): string[] {
  if (values.length > PROMPT_LIBRARY_TAG_COUNT_MAX) {
    throw new PromptLibraryValidationError(
      'too_many_tags',
      `A prompt can have at most ${PROMPT_LIBRARY_TAG_COUNT_MAX} tags.`,
    );
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > PROMPT_LIBRARY_TAG_MAX) {
      throw new PromptLibraryValidationError(
        'tag_too_long',
        `Prompt tags must be ${PROMPT_LIBRARY_TAG_MAX} characters or fewer.`,
      );
    }
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function normalizeScope(
  scope: PromptLibraryScope | undefined,
  repoPath: string | null | undefined,
): { scope: PromptLibraryScope; repoPath: string | null } {
  const resolvedScope = scope ?? 'global';
  if (resolvedScope !== 'global' && resolvedScope !== 'repo') {
    throw new PromptLibraryValidationError('invalid_scope', 'Prompt scope must be global or repo.');
  }
  if (resolvedScope === 'global') return { scope: 'global', repoPath: null };
  const resolvedRepoPath = repoPath?.trim() ?? '';
  if (!resolvedRepoPath) {
    throw new PromptLibraryValidationError('repo_path_required', 'A repo-scoped prompt requires repoPath.');
  }
  if (resolvedRepoPath.length > PROMPT_LIBRARY_REPO_PATH_MAX) {
    throw new PromptLibraryValidationError(
      'repo_path_too_long',
      `repoPath must be ${PROMPT_LIBRARY_REPO_PATH_MAX} characters or fewer.`,
    );
  }
  return { scope: 'repo', repoPath: resolvedRepoPath };
}

function normalizeSource(
  sourceKind: PromptLibrarySourceKind | undefined,
  sourceId: string | null | undefined,
): { sourceKind: PromptLibrarySourceKind; sourceId: string | null } {
  const resolvedKind = sourceKind ?? 'manual';
  if (!['manual', 'automation', 'watched_agent'].includes(resolvedKind)) {
    throw new PromptLibraryValidationError('invalid_source_kind', 'Prompt source kind is invalid.');
  }
  const resolvedSourceId = sourceId?.trim() || null;
  if (resolvedSourceId && resolvedSourceId.length > PROMPT_LIBRARY_SOURCE_ID_MAX) {
    throw new PromptLibraryValidationError(
      'source_id_too_long',
      `Prompt source ids must be ${PROMPT_LIBRARY_SOURCE_ID_MAX} characters or fewer.`,
    );
  }
  return { sourceKind: resolvedKind, sourceId: resolvedSourceId };
}

function bodyFingerprint(body: string): string {
  const stableBody = body
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
  return createHash('sha256').update(stableBody).digest('hex');
}

function listImportRows(repoPath?: string | null): PromptLibraryImportRow[] {
  const scopedPath = repoPath?.trim() || null;
  const where = scopedPath ? 'WHERE repo_path = ?' : '';
  const values = scopedPath ? [scopedPath] : [];
  return getSqlite().prepare(`
    SELECT 'automation' AS source_kind, id AS source_id, name AS title, prompt AS body, repo_path
    FROM automations
    ${where}
    UNION ALL
    SELECT 'watched_agent' AS source_kind, surface_id AS source_id, name AS title, prompt AS body, repo_path
    FROM watched_agents
    ${where}
    ORDER BY title COLLATE NOCASE, source_id
  `).all(...values, ...values) as PromptLibraryImportRow[];
}

function importTitle(title: string, body: string): string {
  const fallback = body.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Imported prompt';
  const normalized = title.trim() || fallback;
  return normalized.length <= PROMPT_LIBRARY_TITLE_MAX
    ? normalized
    : `${normalized.slice(0, PROMPT_LIBRARY_TITLE_MAX - 3).trimEnd()}...`;
}

export function listPromptLibraryImportSources(input: {
  repoPath?: string | null;
  limit?: number;
} = {}): PromptLibraryImportSource[] {
  const limit = Math.max(1, Math.min(
    Number.isFinite(input.limit) ? Math.trunc(input.limit ?? PROMPT_LIBRARY_IMPORT_MAX) : PROMPT_LIBRARY_IMPORT_MAX,
    PROMPT_LIBRARY_IMPORT_MAX,
  ));
  const sources: PromptLibraryImportSource[] = [];
  for (const row of listImportRows(input.repoPath)) {
    const body = row.body.replace(/\r\n?/g, '\n').trim();
    const repoPath = row.repo_path.trim();
    if (!body || !repoPath || body.length > PROMPT_LIBRARY_BODY_MAX) continue;
    if (findSource(row.source_kind, row.source_id)) continue;
    if (findDuplicate('repo', repoPath, bodyFingerprint(body))) continue;
    sources.push({
      key: `${row.source_kind}:${row.source_id}`,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      title: importTitle(row.title, body),
      preview: body.replace(/\s+/g, ' ').slice(0, 160),
      repoPath,
    });
    if (sources.length >= limit) break;
  }
  return sources;
}

export function importPromptLibrarySources(input: {
  sources: PromptLibraryImportRef[];
  repoPath?: string | null;
}): { entries: PromptLibraryEntry[]; created: number; skipped: number } {
  if (input.sources.length > PROMPT_LIBRARY_IMPORT_MAX) {
    throw new PromptLibraryValidationError(
      'too_many_imports',
      `Import at most ${PROMPT_LIBRARY_IMPORT_MAX} prompts at a time.`,
    );
  }
  const requested = new Set(input.sources.map((source) => `${source.sourceKind}:${source.sourceId}`));
  const rows = listImportRows(input.repoPath).filter((row) => requested.has(`${row.source_kind}:${row.source_id}`));
  const entries: PromptLibraryEntry[] = [];
  let skipped = input.sources.length - rows.length;
  for (const row of rows) {
    try {
      const result = createPromptLibraryEntry({
        title: importTitle(row.title, row.body),
        body: row.body,
        tags: [row.source_kind === 'automation' ? 'automation' : 'watched agent'],
        scope: 'repo',
        repoPath: row.repo_path,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
      });
      if (result.created) entries.push(result.entry);
      else skipped += 1;
    } catch (error) {
      if (!(error instanceof PromptLibraryValidationError)) throw error;
      skipped += 1;
    }
  }
  return { entries, created: entries.length, skipped };
}

function findDuplicate(
  scope: PromptLibraryScope,
  repoPath: string | null,
  fingerprint: string,
  excludeId?: string,
): PromptLibraryEntry | null {
  const sqlite = getSqlite();
  const exclusion = excludeId ? ' AND id != ?' : '';
  const row = scope === 'global'
    ? sqlite.prepare(`
        SELECT * FROM prompt_library
        WHERE scope = 'global' AND body_fingerprint = ?${exclusion}
        LIMIT 1
      `).get(...(excludeId ? [fingerprint, excludeId] : [fingerprint])) as PromptLibraryRow | undefined
    : sqlite.prepare(`
        SELECT * FROM prompt_library
        WHERE scope = 'repo' AND repo_path = ? AND body_fingerprint = ?${exclusion}
        LIMIT 1
      `).get(...(excludeId ? [repoPath, fingerprint, excludeId] : [repoPath, fingerprint])) as PromptLibraryRow | undefined;
  return row ? rowToEntry(row) : null;
}

function findSource(sourceKind: PromptLibrarySourceKind, sourceId: string): PromptLibraryEntry | null {
  const row = getSqlite().prepare(`
    SELECT * FROM prompt_library
    WHERE source_kind = ? AND source_id = ?
    LIMIT 1
  `).get(sourceKind, sourceId) as PromptLibraryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function createPromptLibraryEntry(
  input: CreatePromptLibraryEntryInput,
): { entry: PromptLibraryEntry; created: boolean } {
  const title = normalizeTitle(input.title);
  const body = normalizeBody(input.body);
  const tags = normalizeTags(input.tags ?? []);
  const { scope, repoPath } = normalizeScope(input.scope, input.repoPath);
  const { sourceKind, sourceId } = normalizeSource(input.sourceKind, input.sourceId);
  const fingerprint = bodyFingerprint(body);
  const duplicate = findDuplicate(scope, repoPath, fingerprint);
  if (duplicate) return { entry: duplicate, created: false };

  const id = `prompt-${randomUUID()}`;
  const now = Date.now();
  const insert = getSqlite().prepare(`
    INSERT OR IGNORE INTO prompt_library (
      id, title, body, body_fingerprint, tags_json, scope, repo_path,
      source_kind, source_id, created_at, updated_at, last_used_at, use_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
  `).run(
    id,
    title,
    body,
    fingerprint,
    JSON.stringify(tags),
    scope,
    repoPath,
    sourceKind,
    sourceId,
    now,
    now,
  );
  if (insert.changes === 0) {
    const concurrentDuplicate = findDuplicate(scope, repoPath, fingerprint)
      ?? (sourceId ? findSource(sourceKind, sourceId) : null);
    if (concurrentDuplicate) return { entry: concurrentDuplicate, created: false };
    throw new Error('Prompt library insert was refused without a matching entry.');
  }
  const entry = getPromptLibraryEntry(id);
  if (!entry) throw new Error('Prompt library insert did not persist.');
  return { entry, created: true };
}

export function getPromptLibraryEntry(id: string): PromptLibraryEntry | null {
  const row = getSqlite().prepare('SELECT * FROM prompt_library WHERE id = ?').get(id) as PromptLibraryRow | undefined;
  return row ? rowToEntry(row) : null;
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function listPromptLibraryEntries(
  input: ListPromptLibraryEntriesInput = {},
): PromptLibraryEntry[] {
  const sqlite = getSqlite();
  const scope = input.scope ?? 'available';
  const repoPath = input.repoPath?.trim() || null;
  const query = input.query?.trim() ?? '';
  if (query.length > PROMPT_LIBRARY_QUERY_MAX) {
    throw new PromptLibraryValidationError(
      'query_too_long',
      `Prompt search must be ${PROMPT_LIBRARY_QUERY_MAX} characters or fewer.`,
    );
  }
  const limit = Math.max(1, Math.min(
    Number.isFinite(input.limit) ? Math.trunc(input.limit ?? 50) : 50,
    PROMPT_LIBRARY_LIST_LIMIT_MAX,
  ));
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (scope === 'available') {
    if (repoPath) {
      clauses.push("(scope = 'global' OR (scope = 'repo' AND repo_path = ?))");
      values.push(repoPath);
    } else {
      clauses.push("scope = 'global'");
    }
  } else if (scope === 'global') {
    clauses.push("scope = 'global'");
  } else if (scope === 'repo') {
    if (!repoPath) {
      throw new PromptLibraryValidationError('repo_path_required', 'Repo search requires repoPath.');
    }
    clauses.push("scope = 'repo' AND repo_path = ?");
    values.push(repoPath);
  } else if (scope !== 'all') {
    throw new PromptLibraryValidationError('invalid_scope_filter', 'Prompt scope filter is invalid.');
  }

  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const term of terms) {
    clauses.push(`(
      lower(title) LIKE ? ESCAPE '\\'
      OR lower(body) LIKE ? ESCAPE '\\'
      OR lower(tags_json) LIKE ? ESCAPE '\\'
    )`);
    const pattern = `%${escapeLikeTerm(term)}%`;
    values.push(pattern, pattern, pattern);
  }

  values.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = sqlite.prepare(`
    SELECT * FROM prompt_library
    ${where}
    ORDER BY COALESCE(last_used_at, updated_at) DESC, updated_at DESC, created_at DESC, rowid DESC
    LIMIT ?
  `).all(...values) as PromptLibraryRow[];
  return rows.map(rowToEntry);
}

export class PromptLibraryRevisionError extends Error {
  constructor() {
    super('This saved prompt changed. Reload it before saving or deleting.');
    this.name = 'PromptLibraryRevisionError';
  }
}

export function updatePromptLibraryEntry(
  id: string,
  input: UpdatePromptLibraryEntryInput,
): PromptLibraryEntry | null {
  const existing = getPromptLibraryEntry(id);
  if (!existing) return null;
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== existing.updatedAt) {
    throw new PromptLibraryRevisionError();
  }

  const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
  const body = input.body === undefined ? existing.body : normalizeBody(input.body);
  const tags = input.tags === undefined ? existing.tags : normalizeTags(input.tags);
  const { scope, repoPath } = normalizeScope(
    input.scope ?? existing.scope,
    input.repoPath === undefined ? existing.repoPath : input.repoPath,
  );
  const fingerprint = bodyFingerprint(body);
  const duplicate = findDuplicate(scope, repoPath, fingerprint, id);
  if (duplicate) throw new PromptLibraryDuplicateError(duplicate);

  try {
    const result = getSqlite().prepare(`
      UPDATE prompt_library
      SET title = ?, body = ?, body_fingerprint = ?, tags_json = ?,
          scope = ?, repo_path = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).run(title, body, fingerprint, JSON.stringify(tags), scope, repoPath,
      Math.max(Date.now(), existing.updatedAt + 1), id, existing.updatedAt);
    if (result.changes === 0) throw new PromptLibraryRevisionError();
  } catch (error) {
    const concurrentDuplicate = findDuplicate(scope, repoPath, fingerprint, id);
    if (concurrentDuplicate) throw new PromptLibraryDuplicateError(concurrentDuplicate);
    throw error;
  }
  return getPromptLibraryEntry(id);
}

export function recordPromptLibraryUse(id: string, usedAt: number = Date.now()): PromptLibraryEntry | null {
  const result = getSqlite().prepare(`
    UPDATE prompt_library
    SET last_used_at = ?, use_count = use_count + 1
    WHERE id = ?
  `).run(usedAt, id);
  return result.changes > 0 ? getPromptLibraryEntry(id) : null;
}

export function deletePromptLibraryEntry(id: string, expectedUpdatedAt?: number): boolean {
  if (expectedUpdatedAt !== undefined) {
    const result = getSqlite().prepare('DELETE FROM prompt_library WHERE id = ? AND updated_at = ?').run(id, expectedUpdatedAt);
    if (result.changes === 0 && getPromptLibraryEntry(id)) throw new PromptLibraryRevisionError();
    return result.changes > 0;
  }
  return getSqlite().prepare('DELETE FROM prompt_library WHERE id = ?').run(id).changes > 0;
}
