import { viewerJson } from '@/lib/viewers/response';
import { execFile } from '@/lib/providers/child-process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const exec = promisify(execFile);
const MAX_BYTES = 131072;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * GET /api/review/diff — the active review's unified diff, for the canvas to
 * render as a PR review card. The Alerts "Review ready · PR #N" row resolves
 * to THIS, not the unrelated working-tree diff of whatever repo the canvas
 * happens to point at (that mismatch was the bug this fixes).
 *
 * The alert is titled by its pull request, so the diff follows the PR: pull
 * the committed patch straight from GitHub (`gh api …/pulls/N/files`). Only
 * when no PR is attached do we fall back to the review repo's working tree
 * (`git diff HEAD`, the same baseline workspace.ts uses). Gated loopback-only
 * via the `/api/review/` middleware prefix.
 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

interface PrFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

/** PR #N's committed diff straight from GitHub — the alert names a PR, so the
 *  card shows that PR, not the local tree. Assembles a combined unified diff
 *  from the per-file patches plus a path-level stat. */
async function loadPrDiff(repoSlug: string, prNumber: number): Promise<{ diff: string; stat: string } | null> {
  try {
    const { stdout } = await exec('gh', ['api', `repos/${repoSlug}/pulls/${prNumber}/files?per_page=100`], { windowsHide: true, maxBuffer: MAX_BUFFER });
    const files = JSON.parse(stdout) as PrFile[];
    if (!Array.isArray(files) || !files.length) return null;
    const diff = files
      .filter((file) => file.patch)
      .map((file) => `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}\n${file.patch}`)
      .join('\n\n');
    const stat = files
      .map((file) => `${file.filename}  +${file.additions ?? 0}  -${file.deletions ?? 0}`)
      .join('\n');
    return { diff, stat };
  } catch {
    return null;
  }
}

/** The review repo's working tree vs HEAD — the fallback when no PR is attached.
 *  repoPath is ~-shortened by the snapshot, so expand before `git -C`. */
async function loadLocalDiff(repoPath: string): Promise<{ diff: string; stat: string }> {
  const run = async (args: string[]) => {
    try {
      const { stdout } = await exec('git', ['-C', repoPath, ...args], { windowsHide: true, maxBuffer: MAX_BUFFER });
      return stdout;
    } catch {
      return '';
    }
  };
  const [diff, stat] = await Promise.all([
    run(['diff', '--no-ext-diff', '-M', 'HEAD']),
    run(['diff', '--stat=120', 'HEAD']),
  ]);
  return { diff, stat: stat.trim() };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspacePath = searchParams.get('workspace') || undefined;
    const repoSlug = searchParams.get('repo') || undefined;

    const snapshot = await getWorkspaceReviewSnapshot({ workspacePath, repoSlug });
    const lead = snapshot.pullRequests[0];

    let source: 'pull_request' | 'local' | 'none' = 'none';
    let diff = '';
    let stat = snapshot.diffStat || '';

    if (lead && snapshot.repoSlug) {
      const pr = await loadPrDiff(snapshot.repoSlug, lead.number);
      if (pr && pr.diff.trim()) {
        diff = pr.diff;
        stat = pr.stat || stat;
        source = 'pull_request';
      }
    }
    if (!diff.trim() && snapshot.repoPath) {
      const local = await loadLocalDiff(expandHome(snapshot.repoPath));
      if (local.diff.trim()) {
        diff = local.diff;
        stat = local.stat || stat;
        source = 'local';
      }
    }

    const truncated = diff.length > MAX_BYTES;
    return viewerJson({
      ok: true,
      source,
      branch: snapshot.branch,
      stat,
      diff: truncated ? diff.slice(0, MAX_BYTES) : diff,
      truncated,
      changedFiles: snapshot.changedFiles?.length ?? 0,
      prNumber: lead?.number ?? null,
      prTitle: lead?.title ?? null,
      prUrl: lead?.url ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to load review diff';
    console.error('[review/diff]', message);
    return viewerJson({ ok: false, reason: message }, { status: 500 });
  }
}
