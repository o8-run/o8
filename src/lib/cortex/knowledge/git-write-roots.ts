import { lstatSync, opendirSync, readlinkSync, realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { execFileSync } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';

/** Resolve missing destinations too: a dangling Git symlink can become a write target. */
function physicalDestination(input: string, depth = 0): string {
  if (depth >= 64) throw new Error('Unverifiable Git storage symlink.');
  // Do not collapse '..' before following links: hop/../file uses the
  // physical parent of hop's target, not the lexical parent of hop.
  const absolute = path.isAbsolute(input) ? input : `${process.cwd()}${path.sep}${input}`;
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : '/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segment === '.') continue;
    if (segment === '..') { current = path.dirname(current); continue; }
    const child = path.join(current, segment);
    try {
      if (lstatSync(child).isSymbolicLink()) {
        const link = readlinkSync(child);
        const target = path.isAbsolute(link) ? link : `${current}${path.sep}${link}`;
        return physicalDestination(`${target}${path.sep}${segments.slice(index + 1).join(path.sep)}`, depth + 1);
      }
      current = realpathSync.native(child);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      current = child;
    }
  }
  return current;
}

/** Resolve administration storage and the effective worktree before permitting Git writes. */
export function gitWriteRoots(candidate: string, inspect: (root: string) => void = () => {}): string[] {
  // Reject before even rev-parse: tracing and config environment can write during Git startup.
  if (Object.keys(process.env).some(name => /^GIT_/i.test(name) && process.env[name] !== undefined)) {
    throw new Error('Caller Git environment overrides are not permitted for guarded writes.');
  }
  const env = childEnvironment({ inherit: false, env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
    GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0', GIT_TERMINAL_PROMPT: '0',
  } });
  let directory = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    let found = false;
    try {
      if (lstatSync(directory).isDirectory()) {
        try { lstatSync(path.join(directory, '.git')); found = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (found) {
      const probe = (...args: string[]) => {
        const output = execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', directory, 'rev-parse', '--path-format=absolute', ...args], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024, env,
        });
        const value = output.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
        if (!value || value.includes('\0')) throw new Error('Unverifiable Git write root.');
        return path.resolve(directory, value);
      };
      const roots = new Set<string>();
      const record = (input: string) => {
        const physical = physicalDestination(input);
        inspect(physical); // Refuse protected targets before traversing redirected storage.
        roots.add(physical);
        return physical;
      };
      const storage = ['--absolute-git-dir', '--git-common-dir'].map(flag => record(probe(flag)));
      const bare = execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', directory, 'rev-parse', '--is-bare-repository'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024, env,
      }).trim();
      if (bare !== 'true') record(probe('--show-toplevel'));
      storage.push(...['index', 'objects', 'refs', 'logs', 'packed-refs', 'worktrees'].map(name => record(probe('--git-path', name))));
      const visited = new Set<string>();
      let entries = 0;
      const pending = [...storage];
      while (pending.length) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        let stat;
        try { stat = lstatSync(current); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (!stat.isDirectory()) continue;
        const dir = opendirSync(current);
        try {
          for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
            if (++entries > 1_000_000) throw new Error('Git storage exceeds the bounded source guard.');
            const child = path.join(current, entry.name);
            if (entry.isSymbolicLink()) pending.push(record(child));
            else if (entry.isDirectory()) pending.push(child);
          }
        } finally { dir.closeSync(); }
      }
      return [...roots];
    }
    const parent = path.dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
  throw new Error('Git storage ancestry exceeds the bounded source guard.');
}
