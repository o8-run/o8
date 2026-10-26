import { ensureKnowledgeSourceWatcher, stopKnowledgeSourceWatcher } from '@/lib/cortex/knowledge';
import { chunkMarkdown } from './markdown-chunks';
/**
 * Doc-watcher — incremental re-distillation on file change (#964).
 *
 * Watches whitelisted markdown files across all registered repos. When a file
 * is saved, it re-chunks the file, computes a sha256 over each chunk's text,
 * and re-distills only the chunks whose content hash changed since the last run.
 *
 * Boots from ws-server via `startDocWatcher()`. Disable with:
 *   O8_DISABLE_DOC_WATCH=1
 *
 * Node fs.watch is used (no chokidar dep). Per-file debounce of 2s so rapid
 * successive saves don't fire multiple LLM calls for the same edit session.
 *
 * Chunk-level GC: when a chunk disappears (file shortened / heading removed),
 * its doc_distill_state row is left for the next compactor run (which already
 * does an orphan check on chunk fingerprint). This watcher only adds / updates.
 *
 * DB side effects:
 *   - Writes new/updated facts via distillDocChunkBatch (fingerprint upsert).
 *   - Deletes the doc_distill_state row for each changed chunk so the nightly
 *     distill-docs run doesn't skip it on its mtime gate.
 *   - Writes a fresh doc_distill_state 'done' row after successful distill.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { distillDocChunkBatch } from '@/lib/cortex/indexer/doc-distill';
import { isWhitelistedDocPath } from '@/lib/cortex/indexer/doc-whitelist';
import { getDb, getSqlite } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 2_000;
const MIN_FILE_LEN = 200;
const MAX_FILE_BYTES = 100 * 1024;
const CONFIDENCE_FLOOR = 0.6;
const DOC_SOURCE_AUTHORITY = 0.85;
const BATCH_TIMEOUT_MS = 240_000;

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
]);

// ── Repo registry ─────────────────────────────────────────────────────────────

interface RegisteredRepo {
  name: string;
  localPath: string;
}


function loadRegisteredRepos(): RegisteredRepo[] {
  const registryPath = join(getDataDir(), 'repos.json');
  if (!existsSync(registryPath)) return [];
  try {
    const raw = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      repos?: Array<{ name?: string; localPath?: string; path?: string }>;
    };
    const out: RegisteredRepo[] = [];
    for (const entry of parsed.repos ?? []) {
      const localPath = entry?.localPath ?? entry?.path;
      if (!localPath) continue;
      const name = entry?.name ?? localPath.split('/').pop() ?? localPath;
      out.push({ name, localPath: resolve(localPath) });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Whitelist ─────────────────────────────────────────────────────────────────

export const isWhitelisted = isWhitelistedDocPath;

function pathHasWorktreeSegment(p: string): boolean {
  const segs = p.split(sep);
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (
      (segs[i] === '.claude' || segs[i] === '.cursor' || segs[i] === '.o8') &&
      segs[i + 1] === 'worktrees'
    ) {
      return true;
    }
  }
  return false;
}

// ── Chunking (mirrors distill-docs.ts) ───────────────────────────────────────

// ── Identity + hashing ────────────────────────────────────────────────────────

function sourceIdOf(repoPath: string, relPath: string, chunkIdx: number): string {
  return `doc:${repoPath}:${relPath}:${chunkIdx}`;
}

function factFingerprintOf(content: string, sourceId: string): string {
  return createHash('sha256').update(`${sourceId}\n${content}`).digest('hex');
}

/** sha256 over the chunk's raw text — used for change detection only. */
function chunkTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function deleteDistillStateRow(sourceId: string): void {
  try {
    const sqlite = getSqlite();
    sqlite.prepare('DELETE FROM doc_distill_state WHERE source_id = ?').run(sourceId);
  } catch {
    // Non-fatal — distill pipeline can recover
  }
}

function upsertDistillStateDone(sourceId: string, fileMtime: string): void {
  try {
    const sqlite = getSqlite();
    sqlite
      .prepare(
        `INSERT INTO doc_distill_state
           (source_id, status, attempts, last_attempted_at, error, file_mtime, updated_at)
         VALUES (?, 'done', 1, datetime('now'), NULL, ?, datetime('now'))
         ON CONFLICT(source_id) DO UPDATE SET
           status = 'done',
           attempts = attempts + 1,
           last_attempted_at = excluded.last_attempted_at,
           error = NULL,
           file_mtime = excluded.file_mtime,
           updated_at = excluded.updated_at`,
      )
      .run(sourceId, fileMtime);
  } catch {
    // Non-fatal
  }
}

function writeFacts(
  sourceId: string,
  repoPath: string,
  chunkText: string,
  facts: Array<{ kind: string; content: string; source_excerpt: string; confidence: number }>,
): number {
  if (facts.length === 0) return 0;
  let written = 0;
  try {
    const sqlite = getSqlite();
    const insert = sqlite.prepare(
      `INSERT INTO facts (
         id, kind, content, source_kind, source_id, source_excerpt,
         repo_path, confidence, fingerprint, extracted_by, source_authority
       )
       VALUES (?, ?, ?, 'doc', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         kind = excluded.kind,
         content = excluded.content,
         source_excerpt = excluded.source_excerpt,
         repo_path = excluded.repo_path,
         confidence = excluded.confidence,
         extracted_by = excluded.extracted_by,
         source_authority = excluded.source_authority`,
    );
    const tx = sqlite.transaction(() => {
      for (const fact of facts) {
        if (fact.confidence < CONFIDENCE_FLOOR) continue;
        if (!chunkText.includes(fact.source_excerpt)) continue;
        const fingerprint = factFingerprintOf(fact.content, sourceId);
        insert.run(
          randomUUID(),
          fact.kind,
          fact.content,
          sourceId,
          fact.source_excerpt,
          repoPath,
          fact.confidence,
          fingerprint,
          'doc-watcher',
          DOC_SOURCE_AUTHORITY,
        );
        written += 1;
      }
    });
    tx();
  } catch (err) {
    console.warn(
      `[doc-watcher] writeFacts error for ${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return written;
}

// ── Per-file distill ──────────────────────────────────────────────────────────

/** In-memory map of sourceId → chunkTextHash for change detection. */
const chunkHashes = new Map<string, string>();

async function distillChangedFile(
  repo: RegisteredRepo,
  absPath: string,
  relPath: string,
): Promise<void> {
  let body: string;
  let mtimeIso: string;
  try {
    const stat = statSync(absPath);
    if (stat.size > MAX_FILE_BYTES || stat.size < MIN_FILE_LEN) return;
    body = readFileSync(absPath, 'utf-8');
    mtimeIso = stat.mtime.toISOString();
  } catch {
    return;
  }

  if (body.length < MIN_FILE_LEN) return;

  const chunks = chunkMarkdown(body);
  if (chunks.length === 0) return;

  // Ensure DB is initialized
  const db = getDb();
  if (!db) {
    console.warn('[doc-watcher] DB not available — skipping distill for', relPath);
    return;
  }

  // Find chunks whose text hash changed (new or modified).
  const changedChunks: typeof chunks = [];
  for (const chunk of chunks) {
    const sourceId = sourceIdOf(repo.localPath, relPath, chunk.chunkIdx);
    const hash = chunkTextHash(chunk.text);
    if (chunkHashes.get(sourceId) !== hash) {
      changedChunks.push(chunk);
    }
  }

  if (changedChunks.length === 0) {
    console.log(`[doc-watcher] ${relPath} — no chunk changes detected`);
    return;
  }

  console.log(
    `[doc-watcher] ${relPath} — ${changedChunks.length}/${chunks.length} chunk(s) changed, re-distilling`,
  );

  // Clear checkpoint rows so nightly script doesn't skip them.
  for (const chunk of changedChunks) {
    deleteDistillStateRow(sourceIdOf(repo.localPath, relPath, chunk.chunkIdx));
  }

  // Distill in one batch.
  const inputs = changedChunks.map((chunk) => ({
    id: sourceIdOf(repo.localPath, relPath, chunk.chunkIdx),
    repoName: repo.name,
    relPath,
    headingPath: chunk.headingPath,
    text: chunk.text,
  }));

  let factsByChunkId: Map<string, Array<{ kind: string; content: string; source_excerpt: string; confidence: number }>>;
  try {
    const result = await distillDocChunkBatch({ chunks: inputs, timeoutMs: BATCH_TIMEOUT_MS });
    factsByChunkId = result.factsByChunkId;
  } catch (err) {
    console.warn(
      `[doc-watcher] distill failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  let totalWritten = 0;
  for (const chunk of changedChunks) {
    const sourceId = sourceIdOf(repo.localPath, relPath, chunk.chunkIdx);
    const facts = factsByChunkId.get(sourceId) ?? [];
    const written = writeFacts(sourceId, repo.localPath, chunk.text, facts);
    totalWritten += written;
    upsertDistillStateDone(sourceId, mtimeIso);
    chunkHashes.set(sourceId, chunkTextHash(chunk.text));
  }

  console.log(`[doc-watcher] ${relPath} — distill done, ${totalWritten} fact(s) written`);
}

// ── File discovery for seeding hashes ────────────────────────────────────────

function collectWatchedFiles(repos: RegisteredRepo[]): Array<{ repo: RegisteredRepo; absPath: string; relPath: string }> {
  const files: Array<{ repo: RegisteredRepo; absPath: string; relPath: string }> = [];
  for (const repo of repos) {
    if (!existsSync(repo.localPath)) continue;
    const stack: string[] = [repo.localPath];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const abs = join(dir, name);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRECTORIES.has(name)) continue;
          if (pathHasWorktreeSegment(abs)) continue;
          stack.push(abs);
          continue;
        }
        if (!stat.isFile()) continue;
        if (!/\.md$/i.test(name)) continue;
        const relPath = relative(repo.localPath, abs);
        if (!isWhitelisted(relPath)) continue;
        if (stat.size > MAX_FILE_BYTES || stat.size < MIN_FILE_LEN) continue;
        files.push({ repo, absPath: abs, relPath });
      }
    }
  }
  return files;
}

// ── Watcher ───────────────────────────────────────────────────────────────────

/** Per-file debounce timers. */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDistill(repo: RegisteredRepo, absPath: string, relPath: string): void {
  const existing = debounceTimers.get(absPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(absPath);
    void distillChangedFile(repo, absPath, relPath).catch((err) => {
      console.warn(
        `[doc-watcher] unhandled error for ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, DEBOUNCE_MS);
  debounceTimers.set(absPath, timer);
}

/**
 * Seed the in-memory hash map from the current content of all watched files
 * so the first change only triggers re-distill for actually-modified chunks.
 */
function seedChunkHashes(files: Array<{ repo: RegisteredRepo; absPath: string; relPath: string }>): void {
  for (const { repo, absPath, relPath } of files) {
    try {
      const body = readFileSync(absPath, 'utf-8');
      if (body.length < MIN_FILE_LEN) continue;
      const chunks = chunkMarkdown(body);
      for (const chunk of chunks) {
        const sourceId = sourceIdOf(repo.localPath, relPath, chunk.chunkIdx);
        chunkHashes.set(sourceId, chunkTextHash(chunk.text));
      }
    } catch {
      // Skip unreadable files
    }
  }
}

/**
 * Start the doc watcher. Returns a stop function.
 * No-op (returns identity stop) when O8_DISABLE_DOC_WATCH=1.
 */
function startRepoDocWatcher(): () => void {
  if (process.env.O8_DISABLE_DOC_WATCH === '1') {
    console.log('[doc-watcher] disabled via O8_DISABLE_DOC_WATCH=1');
    return () => {};
  }

  const repos = loadRegisteredRepos();
  if (repos.length === 0) {
    console.log('[doc-watcher] no repos registered — skipping');
    return () => {};
  }

  const files = collectWatchedFiles(repos);
  if (files.length === 0) {
    console.log('[doc-watcher] no whitelisted docs found — skipping');
    return () => {};
  }

  seedChunkHashes(files);
  console.log(`[doc-watcher] seeded hashes for ${chunkHashes.size} chunk(s) across ${files.length} file(s)`);

  // Build absPath → repo+relPath lookup for the watch callback.
  const fileIndex = new Map<string, { repo: RegisteredRepo; relPath: string }>();
  for (const { repo, absPath, relPath } of files) {
    fileIndex.set(absPath, { repo, relPath });
  }

  // One fs.watch handle per file (not per-directory) — avoids recursive watch
  // issues on macOS and limits scope to exactly the whitelisted files.
  const handles: ReturnType<typeof watch>[] = [];
  for (const { repo, absPath, relPath } of files) {
    if (!existsSync(absPath)) continue;
    try {
      const handle = watch(absPath, () => {
        scheduleDistill(repo, absPath, relPath);
      });
      if (handle.unref) handle.unref();
      handles.push(handle);
    } catch (err) {
      console.warn(
        `[doc-watcher] could not watch ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`[doc-watcher] watching ${handles.length} file(s) for changes`);

  return () => {
    for (const h of handles) {
      try { h.close(); } catch { /* already closed */ }
    }
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    console.log('[doc-watcher] stopped');
  };
}

export function startDocWatcher(): () => void {
  ensureKnowledgeSourceWatcher();
  const stopDocs = startRepoDocWatcher();
  return () => { stopKnowledgeSourceWatcher(); stopDocs(); };
}
