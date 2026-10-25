export const dynamic = 'force-dynamic';

/**
 * /api/panel/file-io — the canvas file card's backend (#1232).
 *
 * Open ANY file on the machine: pick (native macOS choose-file via
 * osascript, same pattern as browse-folder), read, and save back.
 * Loopback + token gated under /api/panel/. Absolute paths only — the
 * card is an operator tool with terminal-grade trust, not a repo-scoped
 * agent surface (agents keep using /api/v2/files).
 *
 * Editing safety: reads refuse to truncate (a truncated read + save would
 * corrupt the file — hard-cap instead), and writes carry the mtime the
 * editor loaded so a file that changed on disk underneath returns 409
 * until the caller forces.
 */

import { NextResponse } from 'next/server';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize, basename, dirname } from 'node:path';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';
import { isWorkspaceFileError, writeWorkspaceFile } from '@/lib/fs/workspace-file';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { isPathInRegisteredRepo } from '@/lib/llm/repo-scope';

/**
 * A dispatched worker (local-worker token) may only touch files inside a
 * registered repo — never an arbitrary absolute path — so it cannot escape its
 * worktree to overwrite ~/.zshrc / a launchd plist etc. (§HIGH-6). The operator
 * keeps full arbitrary-path access (this card is a terminal-grade operator tool).
 */
async function authorizeFileAccess(request: Request, absPath: string): Promise<NextResponse | null> {
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'worker') {
    return NextResponse.json({ error: 'File access requires an operator or dispatched-worker credential.' }, { status: 403 });
  }
  if (principal === 'operator') return null;
  if (await isPathInRegisteredRepo(absPath)) return null;
  return NextResponse.json(
    { error: 'Workers may only access files inside a registered repository.' },
    { status: 403 },
  );
}

const execFileAsync = promisify(execFile);

const MAX_EDIT_BYTES = 2 * 1024 * 1024;

function resolveAbsolute(raw: string): string | null {
  if (!raw.trim()) return null;
  const expanded = raw === '~' || raw.startsWith('~/')
    ? raw.replace('~', homedir())
    : raw;
  if (!isAbsolute(expanded)) return null;
  return normalize(expanded);
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawPath = searchParams.get('path');
  if (!rawPath) {
    return NextResponse.json({ error: 'path param required' }, { status: 400 });
  }
  const path = resolveAbsolute(rawPath);
  if (!path) {
    return NextResponse.json({ error: 'Absolute path required' }, { status: 400 });
  }
  const workerDenied = await authorizeFileAccess(request, path);
  if (workerDenied) return workerDenied;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }
    if (info.size > MAX_EDIT_BYTES) {
      return NextResponse.json({ error: `Too large to edit (${Math.round(info.size / 1024)} KB — cap ${Math.round(MAX_EDIT_BYTES / 1024)} KB)` }, { status: 413 });
    }
    const buffer = await readFile(path);
    if (looksBinary(buffer)) {
      return NextResponse.json({ error: 'Binary file — nothing readable to show' }, { status: 415 });
    }
    return NextResponse.json({ content: buffer.toString('utf-8'), mtimeMs: info.mtimeMs, size: info.size, path });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return NextResponse.json({ error: 'File not found' }, { status: 404 });
    if (code === 'EACCES') return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    return NextResponse.json({ error: 'Could not read file' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  let body: { path?: string; content?: string; expectedMtimeMs?: number; force?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'path and content required' }, { status: 400 });
  }
  const path = resolveAbsolute(body.path);
  if (!path) {
    return NextResponse.json({ error: 'Absolute path required' }, { status: 400 });
  }
  const workerDenied = await authorizeFileAccess(request, path);
  if (workerDenied) return workerDenied;
  const sourceRefusal = knowledgeSourceWriteRefusal(body.path, path);
  if (sourceRefusal) return sourceRefusal;
  try {
    // Edit-existing-files only — the card opens what's already on disk.
    const before = await stat(path);
    if (!before.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }
    if (
      typeof body.expectedMtimeMs === 'number'
      && !body.force
      && Math.abs(before.mtimeMs - body.expectedMtimeMs) > 0.5
    ) {
      return NextResponse.json({ error: 'changed-on-disk', mtimeMs: before.mtimeMs }, { status: 409 });
    }
    await writeWorkspaceFile(dirname(path), basename(path), body.content);
    const after = await stat(path);
    return NextResponse.json({ ok: true, mtimeMs: after.mtimeMs });
  } catch (error) {
    if (isWorkspaceFileError(error)) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return NextResponse.json({ error: 'File not found' }, { status: 404 });
    if (code === 'EACCES') return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    return NextResponse.json({ error: 'Could not write file' }, { status: 500 });
  }
}

/** POST {action:'pick'} — native macOS choose-file dialog (osascript, the
 *  browse-folder pattern). Returns { path } or { path: null } on cancel. */
export async function POST(request: Request) {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ error: 'Choosing arbitrary local files is operator-only.' }, { status: 403 });
  }
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (body.action !== 'pick') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  try {
    const script = [
      'tell application "System Events" to activate',
      'POSIX path of (choose file with prompt "Open a file on the canvas" with invisibles)',
    ].join('\n');
    const { stdout } = await execFileAsync('osascript', ['-e', script], { windowsHide: true, timeout: 120000 });
    const path = stdout.trim();
    return NextResponse.json({ path: path || null });
  } catch {
    // Cancelled (osascript exits non-zero) or dialog unavailable.
    return NextResponse.json({ path: null });
  }
}
