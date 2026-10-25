import { viewerJson } from '@/lib/viewers/response';
/**
 * #796 — Compact git log endpoint for the in-app Loop Status widget.
 *
 * Returns the last N commits as `{ commits: [{ hash, title, ageMs }], total }`.
 * Loop Status renders the "recent merges" disclosure from this; we keep the
 * shape minimal on purpose so the section stays readable in Issues-style
 * rows. The richer `/api/panel/git-log` endpoint stays as the canonical
 * source for the Changes panel and history viewers.
 *
 * Repo discovery:
 *   1. `?repoPath=<absolute|~ relative>` — explicit override
 *   2. `~/.o8/repos.json` — first registered repo
 *   3. `process.cwd()` — last resort for dev
 *
 * The middleware in `src/middleware.ts` gates this prefix on loopback +
 * ws-token, so we don't re-implement auth here.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from '@/lib/providers/child-process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { listRepos } from '@/lib/repos/registry';

const execFileAsync = promisify(execFile);

interface CompactCommit {
  hash: string;
  title: string;
  ageMs: number;
}

interface CompactGitLogResponse {
  commits: CompactCommit[];
  total: number;
  repoPath: string | null;
  error?: string;
}

function expandHome(input: string) {
  if (!input) return input;
  if (input.startsWith('~')) {
    return path.resolve(input.replace(/^~/, os.homedir()));
  }
  return path.resolve(input);
}

async function resolveRepoPath(explicit: string | null): Promise<string | null> {
  if (explicit && explicit.trim()) {
    return expandHome(explicit.trim());
  }
  try {
    const repos = await listRepos();
    if (repos.length > 0 && repos[0]?.localPath) {
      return expandHome(repos[0].localPath);
    }
  } catch {
    /* registry unreadable — fall through */
  }
  return process.cwd() || null;
}

export async function GET(request: Request): Promise<NextResponse<CompactGitLogResponse>> {
  const url = new URL(request.url);
  const explicit = url.searchParams.get('repoPath');
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam ?? '5', 10) || 5, 1), 50);

  const repoPath = await resolveRepoPath(explicit);
  if (!repoPath) {
    return viewerJson({
      commits: [],
      total: 0,
      repoPath: null,
      error: 'No repo path could be resolved.',
    });
  }

  const sep = '\x1f';
  const recordSep = '\x1e';
  const format = `%H${sep}%s${sep}%ct${recordSep}`;

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'log', `--format=${format}`, '-n', String(limit)],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 8000 },
    );

    const now = Date.now();
    const commits: CompactCommit[] = stdout
      .split(recordSep)
      .map((chunk) => chunk.replace(/^\n/, '').trim())
      .filter(Boolean)
      .map((chunk) => {
        const [hash, title, ctSec] = chunk.split(sep);
        if (!hash || !title || !ctSec) return null;
        const seconds = parseInt(ctSec, 10);
        if (!Number.isFinite(seconds)) return null;
        return {
          hash,
          title,
          ageMs: Math.max(0, now - seconds * 1000),
        };
      })
      .filter((entry): entry is CompactCommit => entry !== null);

    return viewerJson({
      commits,
      total: commits.length,
      repoPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'git log failed';
    return viewerJson({
      commits: [],
      total: 0,
      repoPath,
      error: message,
    });
  }
}
