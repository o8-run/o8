import { spawnSync } from '@/lib/providers/child-process';

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

function result(body: Record<string, unknown>, options = { status: 200 }) {
  return { body, status: options.status };
}

export function pushWorkspace(root: string) {
  try {
    const branch = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
      return result({ error: 'Cannot push from detached HEAD' }, { status: 400 });
    }

    let upstream = '';
    try {
      upstream = runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
      upstream = '';
    }

    if (upstream) {
      runGit(root, ['push']);
      return result({
        ok: true,
        branch,
        upstream,
        message: `Pushed ${branch} to ${upstream}`,
      });
    }

    const remotes = runGit(root, ['remote']).split('\n').map((value) => value.trim()).filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) {
      return result({ error: 'No git remote configured for this workspace' }, { status: 400 });
    }

    runGit(root, ['push', '-u', remote, branch]);
    return result({
      ok: true,
      branch,
      upstream: `${remote}/${branch}`,
      message: `Pushed ${branch} to ${remote}/${branch}`,
    });
  } catch (err) {
    return result({
      error: err instanceof Error ? err.message : 'Push failed',
    }, { status: 500 });
  }
}
