import 'server-only';

import { readdir, realpath, stat } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import { spawn } from '@/lib/providers/child-process';
import { resolveGitBinary } from '@/lib/git/binary';
import { safeJoinReal } from '@/lib/fs/safe-path';
import { openWorkspaceFile, isWorkspaceFileError } from '@/lib/fs/workspace-file';
import { validateRepoRelativePath } from '@/lib/worktree/diff-transport';
import { findLaneBySession } from '@/lib/lane/registry';
import { readProjectedThread } from '@/lib/mobile/orchestrator-thread-history';

export const MOBILE_FILE_MAX_ENTRIES = 500;
export const MOBILE_FILE_MAX_BYTES = 256 * 1024;

export class MobileFilesError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

/** Match each component so secret directories and aliases remain hidden. */
export function isSecretFilePath(path: string): boolean {
  return path.split(/[\\/]/).some(name => /^(?:\.env(?:\..*)?|.*\.(?:pem|key)|id_rsa.*|id_ed25519.*)$/i.test(name));
}

function checkedPath(path: string, rootAllowed = false): string {
  if (rootAllowed && path === '') return '';
  try {
    validateRepoRelativePath(path);
    if (path.split('/').includes('.git')) throw new Error();
    return path;
  } catch {
    throw new MobileFilesError('invalid_path', 400);
  }
}

export async function resolveMobileFilesCheckout(params: URLSearchParams): Promise<string> {
  const threadId = params.get('threadId');
  const sessionKey = params.get('sessionKey');
  if (Boolean(threadId) === Boolean(sessionKey)) throw new MobileFilesError('provide_threadId_or_sessionKey', 400);
  let root: string | null = null;
  if (threadId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new MobileFilesError('invalid_threadId', 400);
    root = readProjectedThread(threadId)?.repoPath ?? null;
  } else if (sessionKey) {
    const lane = findLaneBySession(sessionKey);
    root = lane?.worktreePath ?? lane?.repoPath ?? null;
  }
  try {
    if (root && (await stat(root)).isDirectory()) return await realpath(root);
  } catch { /* Missing checkouts have the same response as unknown threads. */ }
  throw new MobileFilesError('checkout_not_found', 404);
}

function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const child = spawn(resolveGitBinary(), ['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 4_000_000) child.kill();
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new MobileFilesError('ignore_check_failed', 500)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1) reject(new MobileFilesError('ignore_check_failed', 500));
      else resolve(new Set(output.split('\0').filter(Boolean)));
    });
    child.stdin.end(`${paths.join('\0')}\0`);
  });
}

export async function listMobileFiles(root: string, path = '') {
  checkedPath(path, true);
  const target = safeJoinReal(root, path);
  if (!target) throw new MobileFilesError('directory_not_found_or_outside_checkout', 404);
  checkedPath(relative(await realpath(root), await realpath(target)).split('\\').join('/'), true);
  if (!(await stat(target)).isDirectory()) throw new MobileFilesError('not_a_directory', 400);
  const candidates = (await readdir(target, { withFileTypes: true }))
    .filter(entry => entry.name !== '.git' && (entry.isDirectory() || entry.isFile()))
    .map(entry => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? 'dir' as const : 'file' as const }));
  const ignored = await ignoredPaths(root, candidates.map(entry => entry.path));
  const visible = candidates.filter(entry => !ignored.has(entry.path) && safeJoinReal(root, entry.path))
    .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1);
  const entries = await Promise.all(visible.slice(0, MOBILE_FILE_MAX_ENTRIES).map(async entry => ({
    ...entry, ...(entry.kind === 'file' ? { size: (await stat(safeJoinReal(root, entry.path)!)).size } : {}),
  })));
  return { path, entries, truncated: visible.length > MOBILE_FILE_MAX_ENTRIES, maxEntries: MOBILE_FILE_MAX_ENTRIES };
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown', py: 'python', rs: 'rust', css: 'css',
  html: 'html', yml: 'yaml', yaml: 'yaml', sh: 'shell', toml: 'toml', sql: 'sql', swift: 'swift',
};

export function parseMobileFileLineRange(params: URLSearchParams) {
  const parse = (name: string) => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new MobileFilesError('invalid_line_range', 400);
    return value;
  };
  const startLine = parse('startLine');
  const endLine = parse('endLine');
  if (endLine !== undefined && endLine < (startLine ?? 1)) throw new MobileFilesError('invalid_line_range', 400);
  return { startLine, endLine };
}

export async function readMobileFile(root: string, path: string, range: { startLine?: number; endLine?: number } = {}) {
  checkedPath(path);
  const opened = await openWorkspaceFile(root, path, 'read');
  try {
    checkedPath(relative(await realpath(root), opened.realPath).split('\\').join('/'));
    const extension = extname(path).slice(1).toLowerCase();
    const metadata = { path, size: opened.stat.size, extension, language: LANGUAGES[extension] ?? 'plaintext', maxBytes: MOBILE_FILE_MAX_BYTES };
    const canonical = relative(await realpath(root), opened.realPath).split('\\').join('/');
    // An ignored file is left out of every listing; asking for it by path must not read it
    // either. The check uses the real location: git refuses a path that crosses a symlink.
    if (isSecretFilePath(path) || isSecretFilePath(canonical) || (await ignoredPaths(root, [canonical])).size > 0) {
      return { ...metadata, status: 'hidden' as const, content: null };
    }
    if (opened.stat.size > MOBILE_FILE_MAX_BYTES) return { ...metadata, status: 'too_large' as const, content: null };
    // One extra byte detects growth after stat without an unbounded read.
    const bytes = Buffer.alloc(MOBILE_FILE_MAX_BYTES + 1);
    const { bytesRead } = await opened.handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MOBILE_FILE_MAX_BYTES) return { ...metadata, size: bytesRead, status: 'too_large' as const, content: null };
    const buffer = bytes.subarray(0, bytesRead);
    let text: string;
    try {
      if (buffer.includes(0) || buffer.some(byte => byte < 9 || (byte > 13 && byte < 32))) throw new Error();
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return { ...metadata, status: 'binary' as const, binary: true, content: null };
    }
    const lines = text.split(/\r?\n/);
    const startLine = range.startLine ?? 1;
    const endLine = Math.min(range.endLine ?? lines.length, lines.length);
    const content = range.startLine === undefined && range.endLine === undefined ? text : lines.slice(startLine - 1, endLine).join('\n');
    return { ...metadata, status: 'text' as const, binary: false, content, startLine, endLine, totalLines: lines.length };
  } finally {
    await opened.handle.close();
  }
}

export function mobileFilesErrorResponse(error: unknown): Response {
  if (error instanceof MobileFilesError || isWorkspaceFileError(error)) {
    return Response.json({ error: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  }
  const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  return Response.json({ error: missing ? 'file_not_found' : 'file_operation_failed' }, { status: missing ? 404 : 500, headers: { 'Cache-Control': 'no-store' } });
}
