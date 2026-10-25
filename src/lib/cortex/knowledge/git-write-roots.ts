import { lstatSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';

/** Resolve both administration storage and the effective worktree, using Git's own rules. */
export function gitWriteRoots(candidate: string): string[] {
  const env = childEnvironment({ env: { GIT_OPTIONAL_LOCKS: '0' } });
  const explicitRoot = Boolean(env.GIT_DIR || env.GIT_WORK_TREE || env.GIT_COMMON_DIR || env.GIT_INDEX_FILE || env.GIT_OBJECT_DIRECTORY);
  let directory = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    let found = false;
    let isDirectory = false;
    try {
      if (lstatSync(directory).isDirectory()) {
        isDirectory = true;
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
    // Environment roots apply even without a .git marker. Probe at the actual
    // candidate directory: relative roots must not move with Git discovery.
    // File and not-yet-created targets first climb to an existing directory.
    // Failed probes are unknown authority, never permission to write.
    if (found || explicitRoot && isDirectory) {
      const probe = (...args: string[]) => {
        const output = execFileSync('git', ['-C', directory, 'rev-parse', '--path-format=absolute', ...args], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024, env,
        });
        const value = output.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
        if (!value || value.includes('\0')) throw new Error('Unverifiable Git write root.');
        return value;
      };
      const roots = ['--absolute-git-dir', '--git-common-dir'].map(flag => path.resolve(directory, probe(flag)));
      // A bare repository has administration writes but no checkout root.
      // Explicit worktree overrides still take effect even when core.bare=true.
      if (env.GIT_WORK_TREE || probe('--is-bare-repository') !== 'true') roots.push(path.resolve(directory, probe('--show-toplevel')));
      roots.push(...['index', 'objects'].map(name => path.resolve(directory, probe('--git-path', name))));
      return [...new Set(roots)];
    }
    const parent = path.dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
  throw new Error('Git storage ancestry exceeds the bounded source guard.');
}
