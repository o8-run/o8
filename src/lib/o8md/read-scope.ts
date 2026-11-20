import type { NextRequest } from 'next/server';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { viewerJson } from '@/lib/viewers/response';
import { specCallerScope, WORKER_SPEC_SCOPE_REFUSAL } from './worker-scope';

/**
 * The repoPath this request acts on: a worker's is its lane directory's real path (null when it
 * asked for another directory), anyone else's is the one it sent.
 */
export function scopedRepoPath(request: NextRequest): { repoPath: string; worker: boolean } | Response {
  const requested = request.nextUrl.searchParams.get('repoPath') ?? '';
  const caller = specCallerScope(request, requested);
  if (!caller.worker) return { repoPath: requested, worker: false };
  if (!caller.repoPath) return viewerJson({ ok: false, error: WORKER_SPEC_SCOPE_REFUSAL }, { status: 403 });
  return { repoPath: caller.repoPath, worker: true };
}

export function resolveSpecPath(repoPath: string): string | null {
  if (!repoPath || typeof repoPath !== 'string') return null;
  if (!existsSync(repoPath)) return null;
  try {
    const s = statSync(repoPath);
    if (!s.isDirectory()) return null;
  } catch { return null; }
  return join(repoPath, 'o8.md');
}

/** Fresh per-request target only; a refusal stays with the original TypeScript handler. */
export function nativeSpecReadTarget(request: NextRequest) {
  const scope = scopedRepoPath(request);
  if (scope instanceof Response) return null;
  const path = resolveSpecPath(scope.repoPath);
  return path ? { root: resolve(dirname(path)), relativePath: basename(path), path } : null;
}
