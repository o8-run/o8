import { NextResponse } from 'next/server';
import { homedir } from 'node:os';
import { isAbsolute, normalize } from 'node:path';
import { viewerJson } from '@/lib/viewers/response';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { isPathInRegisteredRepo } from '@/lib/llm/repo-scope';

/**
 * A dispatched worker (local-worker token) may only touch files inside a
 * registered repo — never an arbitrary absolute path — so it cannot escape its
 * worktree to overwrite ~/.zshrc / a launchd plist etc. (§HIGH-6). The operator
 * keeps full arbitrary-path access (this card is a terminal-grade operator tool).
 */
export async function authorizeFileAccess(request: Request, absPath: string): Promise<NextResponse | null> {
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'worker') {
    return viewerJson({ error: 'File access requires an operator or dispatched-worker credential.' }, { status: 403 });
  }
  if (principal === 'operator') return null;
  if (await isPathInRegisteredRepo(absPath)) return null;
  return viewerJson(
    { error: 'Workers may only access files inside a registered repository.' },
    { status: 403 },
  );
}

export function resolveAbsolute(raw: string): string | null {
  if (!raw.trim()) return null;
  const expanded = raw === '~' || raw.startsWith('~/')
    ? raw.replace('~', homedir())
    : raw;
  if (!isAbsolute(expanded)) return null;
  return normalize(expanded);
}
