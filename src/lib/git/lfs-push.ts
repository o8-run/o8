/** Runs one Git command for {@link pushLfsObjects}, the way the push it precedes runs. */
export type LfsGitRunner = (args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

function failureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : (error as Error)?.message ?? String(error);
  return text.trim().split('\n').slice(-3).join(' ');
}

async function resolveCommit(run: LfsGitRunner, revision: string): Promise<string | null> {
  try {
    const commit = (await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], { timeout: 10_000 })).stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Git LFS uploads the large files a push needs from its pre-push hook, and
 * o8 runs its pushes without repository hooks. When git-lfs is installed and
 * the lane's base commit routes files to Git LFS, upload `revision`'s files
 * first, as that hook would. A failed upload throws, so the push is not made.
 *
 * Whether the repository uses LFS comes from `base`, the commit the lane
 * started from, never from the lane's own tree: a lane that adds LFS routing,
 * or has no recorded base, pushes without an upload.
 */
export async function pushLfsObjects(run: LfsGitRunner, remote: string, revision: string, base: string | null): Promise<void> {
  if (!base) return;
  const baseCommit = await resolveCommit(run, base);
  if (!baseCommit) return;
  try {
    await run(['grep', '-q', '-F', 'filter=lfs', baseCommit, '--', '.gitattributes', '*/.gitattributes'], { timeout: 30_000 });
  } catch {
    return; // The base routes no files to Git LFS.
  }
  const commit = await resolveCommit(run, revision);
  if (!commit) return; // Not a commit here; the push reports that itself.
  try {
    await run(['lfs', 'version'], { timeout: 10_000 });
  } catch {
    return; // git-lfs is not installed.
  }
  try {
    await run(['lfs', 'push', remote, commit], { timeout: 600_000 });
  } catch (error) {
    throw new Error(`Git LFS upload to ${remote} failed, so the push was not made: ${failureDetail(error)}`);
  }
}
