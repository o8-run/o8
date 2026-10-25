import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { execFileSync } from '@/lib/providers/child-process';
import os from 'os';

/**
 * Working-tree diff for a repo — "what have I changed" as one payload,
 * shaped like the lane diff route so the canvas diff card renders either
 * source unchanged: { ok, branch, stat, diff, truncated }.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace') ?? searchParams.get('repoPath');
  const maxBytes = Math.min(512 * 1024, Math.max(16 * 1024, Number(searchParams.get('maxBytes')) || 131_072));
  if (!workspaceParam) {
    return viewerJson({ ok: false, error: 'workspace param required' }, { status: 400 });
  }
  const root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', os.homedir()) : workspaceParam;
  try {
    const stat = execFileSync('git', ['diff', '--no-color', '--stat', 'HEAD'], {
      windowsHide: true,
      cwd: root, encoding: 'utf-8', timeout: 8000, maxBuffer: 1024 * 1024,
    });
    let diff = execFileSync('git', ['diff', '--no-color', 'HEAD'], {
      windowsHide: true,
      cwd: root, encoding: 'utf-8', timeout: 8000, maxBuffer: 4 * 1024 * 1024,
    });
    // `git diff HEAD` omits untracked (new) files — append them as new-file
    // diffs so the canvas card shows new files too, matching the default
    // review snapshot's completeness. Read-only (`--no-index`, `--exclude-standard`
    // respects .gitignore); never stages or touches the index.
    try {
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        windowsHide: true,
        cwd: root, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024,
      }).split('\n').map((line) => line.trim()).filter(Boolean);
      for (const file of untracked) {
        if (Buffer.byteLength(diff, 'utf-8') > maxBytes) break;
        try {
          execFileSync('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', file], {
            windowsHide: true,
            cwd: root, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024,
          });
        } catch (untrackedError) {
          // --no-index always "differs" vs /dev/null → exits 1, so the diff
          // text comes back on the thrown error's stdout.
          const out = (untrackedError as { stdout?: string }).stdout ?? '';
          if (out) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + out;
        }
      }
    } catch {
      // no untracked files, or git error — the tracked diff still stands
    }
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, cwd: root, encoding: 'utf-8', timeout: 3000 }).trim();
    } catch {
      // detached/fresh repo — branch stays blank
    }
    const truncated = Buffer.byteLength(diff, 'utf-8') > maxBytes;
    if (truncated) diff = diff.slice(0, maxBytes);
    return viewerJson({ ok: true, branch, stat: stat.trim(), diff, truncated });
  } catch (error) {
    return viewerJson({ ok: false, error: error instanceof Error ? error.message : 'git diff failed' });
  }
}
