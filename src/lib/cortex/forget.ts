import { randomUUID } from 'node:crypto';
import { advanceMemoryRevision } from '@/lib/cortex/memory-revision';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { parseDirectiveFile } from '@/lib/cortex/directives/parse';
import { invalidateAnswerCache } from '@/lib/cortex/qa/ask';
import { getActiveProjectScopeForRepo } from '@/lib/repos/projects';
import { publishCortexChange } from '@/lib/realtime/publisher';
import { excludeOutcomeFromMemory } from '@/lib/cortex/outcome-exclusion';

type Kind = 'directive' | 'outcome';
class ForgetError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,240}$/.test(value) && value !== '.' && value !== '..';
}
function deleteDerived(kind: Kind, id: string) {
  const db = getSqlite();
  db.prepare('DELETE FROM facts WHERE source_kind = ? AND source_id IN (?, ?)').run(kind, `${kind}:${id}`, id);
  db.prepare('DELETE FROM facts_queue WHERE source_kind = ? AND source_id IN (?, ?)').run(kind, `${kind}:${id}`, id);
}
function forgetDirective(id: string) {
  const dir = join(getDataDir(), 'directives');
  if (!existsSync(dir)) throw new ForgetError('Instruction not found.', 404);
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ForgetError('Instruction storage must be a local directory.', 409);
  const matches: Array<{ file: string; dev: bigint; ino: bigint }> = [];
  for (const name of readdirSync(dir).filter(name => name.endsWith('.md'))) {
    const file = join(dir, name);
    const status = lstatSync(file, { bigint: true });
    if (status.isSymbolicLink()) {
      // GET reads linked documents too. Inspect their ID read-only so a
      // differently named alias cannot leave this same instruction retained.
      let linkedFd: number | undefined;
      try {
        linkedFd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
        if (!fstatSync(linkedFd).isFile()) continue;
        if (parseDirectiveFile(readFileSync(linkedFd, 'utf8'), basename(name, '.md'))?.id === id) {
          throw new ForgetError('Linked instructions cannot be deleted here.', 409);
        }
      } catch (error) {
        if (error instanceof ForgetError) throw error;
        if (basename(name, '.md') === id || basename(name, '.md') === id.replaceAll(':', '__')) {
          throw new ForgetError('Linked instructions cannot be deleted here.', 409);
        }
      } finally { if (linkedFd !== undefined) closeSync(linkedFd); }
      continue;
    }
    if (!status.isFile()) continue;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev !== status.dev || opened.ino !== status.ino) throw new ForgetError('Instruction changed. Refresh before deleting.', 409);
      if (parseDirectiveFile(readFileSync(fd, 'utf8'), basename(name, '.md'))?.id === id) {
        matches.push({ file, dev: opened.dev, ino: opened.ino });
      }
    } finally { closeSync(fd); }
  }
  if (matches.length !== 1) throw new ForgetError(matches.length ? 'Instruction identity is ambiguous. Resolve duplicate IDs first.' : 'Instruction not found.', matches.length ? 409 : 404);
  const selected = matches[0];
  const staged = join(dir, `.forget-${randomUUID()}`);
  renameSync(selected.file, staged);
  try {
    const moved = lstatSync(staged, { bigint: true });
    if (!moved.isFile() || moved.dev !== selected.dev || moved.ino !== selected.ino) {
      throw new ForgetError('Instruction changed. Refresh before deleting.', 409);
    }
    const db = getSqlite();
    db.transaction(() => {
      // The source stays recoverable until every index change commits.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'directives_fts'").get()) {
        db.prepare('DELETE FROM directives_fts WHERE directive_id = ?').run(id);
      }
      deleteDerived('directive', id);
      advanceMemoryRevision(db);
    })();
  } catch (error) {
    // Never overwrite an instruction recreated by another writer.
    if (!existsSync(selected.file)) renameSync(staged, selected.file);
    throw error;
  }
  try { unlinkSync(staged); } catch { console.warn('[cortex-forget] Deleted instruction has retained staging data.'); }
}
function forgetOutcome(id: string, repoPath: string, projectId: string | null) {
  const db = getSqlite();
  db.transaction(() => {
    const found = db.prepare('SELECT id FROM session_outcomes WHERE id = ? AND repo_path = ? AND project_id IS ?').get(id, repoPath, projectId);
    if (!found) throw new ForgetError('Outcome not found in this repository and project.', 404);
    for (const alias of excludeOutcomeFromMemory(db, id)) {
      db.prepare('DELETE FROM session_outcomes WHERE id = ? AND repo_path = ? AND project_id IS ?').run(alias, repoPath, projectId);
      deleteDerived('outcome', alias);
    }
    advanceMemoryRevision(db);
  })();
}

/** Invoked only behind the same default-deny middleware as directive creation. */
export async function deleteRetainedMemory(request: NextRequest, kind: Kind) {
  try {
    const body = await request.json().catch(() => null) as { id?: unknown; repoPath?: unknown; projectId?: unknown } | null;
    if (!body || !validId(body.id)) return NextResponse.json({ ok: false, error: 'A valid item ID is required.' }, { status: 400 });
    let repoPath: string | undefined;
    if (kind === 'directive') forgetDirective(body.id);
    else {
      if (typeof body.repoPath !== 'string' || (!body.repoPath.trim() && !Object.hasOwn(body, 'projectId'))) return NextResponse.json({ ok: false, error: 'repoPath is required.' }, { status: 400 });
      repoPath = body.repoPath.trim();
      const projectId = body.projectId === null ? null : typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim() : (await getActiveProjectScopeForRepo(repoPath)).projectId;
      const requestedProject = request.nextUrl.searchParams.get('projectId');
      if (requestedProject !== null && (requestedProject.trim() || null) !== projectId) {
        throw new ForgetError('Outcome not found in this project.', 404);
      }
      forgetOutcome(body.id, repoPath, projectId);
    }
    invalidateAnswerCache();
    await publishCortexChange({ scope: kind, repoPath, reason: 'selective-forget' });
    return NextResponse.json({ ok: true, id: body.id }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof ForgetError ? error.message : 'Could not delete retained memory. Try again.' }, { status: error instanceof ForgetError ? error.status : 500 });
  }
}
