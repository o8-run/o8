import { NextResponse } from 'next/server';
import { spawnSync } from '@/lib/providers/child-process';
import { guardViewerRevision } from '@/lib/files/viewer-revision';
import { homedir } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

function resolveRoot(workspace?: string | null) {
  if (!workspace) return REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

function runGit(root: string, args: string[]) {
  const result = spawnSync('git', args, {
    windowsHide: true,
    cwd: root,
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Git command failed').trim());
  }
  return (result.stdout || '').trim();
}

export async function POST(request: Request) {
  let body: { workspace?: string } & Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const root = resolveRoot(body.workspace);

  try {
    const refusal = await guardViewerRevision(root, body);
    if (refusal) return refusal;
    const branch = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
      return NextResponse.json({ error: 'Cannot push from detached HEAD' }, { status: 400 });
    }

    let upstream = '';
    try {
      upstream = runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
      upstream = '';
    }

    if (upstream) {
      runGit(root, ['push']);
      return NextResponse.json({
        ok: true,
        branch,
        upstream,
        message: `Pushed ${branch} to ${upstream}`,
      });
    }

    const remotes = runGit(root, ['remote']).split('\n').map((value) => value.trim()).filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) {
      return NextResponse.json({ error: 'No git remote configured for this workspace' }, { status: 400 });
    }

    runGit(root, ['push', '-u', remote, branch]);
    return NextResponse.json({
      ok: true,
      branch,
      upstream: `${remote}/${branch}`,
      message: `Pushed ${branch} to ${remote}/${branch}`,
    });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Push failed',
    }, { status: 500 });
  }
}
