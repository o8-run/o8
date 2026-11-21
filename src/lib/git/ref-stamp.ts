import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A checkout's git directory and shared ref directory, read from disk without spawning git. */
export function gitDirectories(repoPath: string): { gitDir: string; commonDir: string } | null {
  const dotGit = join(repoPath, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return { gitDir: dotGit, commonDir: realpathSync(dotGit) };
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!pointer) return null;
    const gitDir = resolve(repoPath, pointer[1]);
    let commonDir = gitDir;
    try {
      commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      // A linked worktree always has one; without it the git dir holds the refs.
    }
    return { gitDir, commonDir: realpathSync(commonDir) };
  } catch {
    return null;
  }
}

/** A file's identity, size and modification time; `-` when it is missing. */
export function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '-';
  }
}
