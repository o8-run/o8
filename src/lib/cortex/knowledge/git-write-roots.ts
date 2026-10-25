import { lstatSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';

/** Git resolves its own linked-worktree/separate-dir formats; no metadata parser or negative cache. */
export function gitWriteRoots(candidate: string): string[] {
  let directory = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    let found = false;
    try {
      if (lstatSync(directory).isDirectory()) {
        try {
          lstatSync(path.join(directory, '.git'));
          found = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    // Once a marker exists, a missing Git binary or failed probe is unknown
    // authority, never evidence that this directory has no Git storage.
    if (found) return ['--absolute-git-dir', '--git-common-dir'].map(flag => {
      const output = execFileSync('git', ['-C', directory, 'rev-parse', '--path-format=absolute', flag], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024,
        env: childEnvironment({ env: { GIT_OPTIONAL_LOCKS: '0' } }),
      });
      const value = output.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
      if (!value || value.includes('\0')) throw new Error('Unverifiable Git storage path.');
      return path.resolve(directory, value);
    });
    const parent = path.dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
  throw new Error('Git storage ancestry exceeds the bounded source guard.');
}
