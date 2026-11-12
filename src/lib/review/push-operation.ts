import { spawn, spawnReadOnly } from '@/lib/providers/child-process';

function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Reads need the same credential checks but no provider-store transaction.
    // Push preparation holds that transaction only until spawn returns.
    const launch = args[0] === 'push' ? spawn : spawnReadOnly;
    const child = launch('git', args, {
      windowsHide: true, cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000, killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let overflow = false;
    const collect = (chunk: Buffer, error: boolean) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); return; }
      if (error) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
    child.once('error', reject);
    child.once('close', code => {
      if (overflow) reject(new Error('Git output too large'));
      else if (code !== 0) reject(new Error((stderr || stdout || 'Git command failed').trim()));
      else resolve(stdout.trim());
    });
  });
}

function result(body: Record<string, unknown>, options = { status: 200 }) {
  return { body, status: options.status };
}

export async function pushWorkspace(root: string) {
  try {
    const branch = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
      return result({ error: 'Cannot push from detached HEAD' }, { status: 400 });
    }

    let upstream = '';
    try {
      upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
      upstream = '';
    }

    if (upstream) {
      await runGit(root, ['push']);
      return result({
        ok: true,
        branch,
        upstream,
        message: `Pushed ${branch} to ${upstream}`,
      });
    }

    const remotes = (await runGit(root, ['remote'])).split('\n').map((value) => value.trim()).filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) {
      return result({ error: 'No git remote configured for this workspace' }, { status: 400 });
    }

    await runGit(root, ['push', '-u', remote, branch]);
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
