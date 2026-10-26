import { viewerGitJson } from '@/lib/viewers/git-response';
import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { execFileSync } from '@/lib/providers/child-process';
import { lstat } from 'node:fs/promises';
import { expandHome, safeJoin } from '@/lib/fs/safe-path';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';
import { isBinaryPatch, isDirectoryPatch, reviewFileKind, type ReviewFilePresentation } from '@/lib/review/file-presentation';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
const DIFF_LIMIT = 50_000;

async function presentation(root: string, path: string): Promise<ReviewFilePresentation> {
  const joined = safeJoin(root, path);
  if (!joined) return {};
  const stat = await lstat(joined).catch(() => null);
  if (!stat) return { kind: reviewFileKind(path) };
  if (stat.isSymbolicLink()) return { kind: 'symlink' };
  if (stat.isDirectory()) return { kind: 'directory', diffStatus: 'directory' };
  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
  try {
    opened = await openWorkspaceFile(root, path, 'read');
    const kind = reviewFileKind(path);
    const size = Number(opened.stat.size);
    if (kind !== 'text' && !path.toLowerCase().endsWith('.svg')) return { kind, size, diffStatus: 'binary' };
    const sample = Buffer.alloc(Math.min(8192, size));
    await opened.handle.read(sample, 0, sample.length, 0);
    const binary = sample.includes(0);
    return { kind: binary ? 'binary' : kind, size, ...(binary ? { diffStatus: 'binary' as const } : {}) };
  } catch { return { kind: reviewFileKind(path) }; }
  finally { await opened?.handle.close().catch(() => {}); }
}

function readDiff(root: string, args: string[], noIndex = false): { diff: string; tooLarge?: boolean; failed?: boolean } {
  try {
    return { diff: execFileSync('git', ['diff', '--no-color', ...args], { windowsHide: true, cwd: root, encoding: 'utf-8', timeout: 5000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    const result = error as { code?: string; status?: number; stdout?: string; message?: string };
    if (result.code === 'ENOBUFS' || result.message?.includes('maxBuffer')) return { diff: '', tooLarge: true };
    if (noIndex && result.status === 1 && typeof result.stdout === 'string') return { diff: result.stdout };
    return { diff: '', failed: true };
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path') ?? searchParams.get('file');
  const root = expandHome(searchParams.get('workspace') ?? searchParams.get('repoPath') ?? DEFAULT_ROOT);
  const wsArgs = searchParams.get('ignoreWhitespace') === '1' ? ['-w'] : [];
  const baseRef = (searchParams.get('base') || '').trim();
  if (!filePath) return viewerJson({ error: 'path param required' }, { status: 400 });
  if (baseRef.startsWith('-') || [...baseRef].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return viewerJson({ error: 'Invalid comparison revision.' }, { status: 400 });
  if (!safeJoin(root, filePath)) return viewerJson({ error: 'File path must stay inside the workspace.' }, { status: 403 });
  const metadata = await presentation(root, filePath);
  // Media and nested repositories have no useful line diff. Keep the inventory
  // row, with its current-copy metadata, without dumping Git's binary headers.
  if (metadata.diffStatus === 'binary' || metadata.diffStatus === 'directory') {
    return viewerJson({ path: filePath, diff: '', hasDiff: false, ...metadata });
  }
  let result = readDiff(root, [...wsArgs, baseRef ? `${baseRef}...HEAD` : 'HEAD', '--', filePath]);
  if (baseRef && result.failed) return viewerJson({ path: filePath, diff: '', ...metadata, error: 'The committed diff could not be loaded.' });
  if (!baseRef && !result.diff && !result.tooLarge) result = readDiff(root, [...wsArgs, '--cached', '--', filePath]);
  let isUntracked = false;
  if (!baseRef && !result.diff && !result.tooLarge) {
    try {
      isUntracked = execFileSync('git', ['status', '--porcelain', '--', filePath], { cwd: root, windowsHide: true, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().startsWith('??');
    } catch { /* The metadata and empty diff remain readable without Git. */ }
    if (isUntracked) result = readDiff(root, [...wsArgs, '--no-index', '--', '/dev/null', filePath], true);
  }
  const binary = isBinaryPatch(result.diff);
  const directory = isDirectoryPatch(result.diff);
  const truncated = result.diff.length > DIFF_LIMIT;
  return viewerGitJson({
    path: filePath, isUntracked, hasDiff: Boolean(result.diff), ...metadata,
    diff: binary || directory ? '' : result.diff.slice(0, DIFF_LIMIT),
    diffStatus: result.tooLarge ? 'too_large' : directory ? 'directory' : binary ? 'binary' : truncated ? 'truncated' : result.diff ? 'ready' : 'empty',
    ...(binary ? { kind: 'binary' } : directory ? { kind: 'directory' } : {}),
  }, root);
}
