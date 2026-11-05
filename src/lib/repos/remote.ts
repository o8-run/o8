import 'server-only';
import { execFile } from '@/lib/providers/child-process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
interface Origin { config: string; stamp: string; remote: string | null; checkedAt: number }
const origins = new Map<string, Origin>();
const pending = new Map<string, Promise<string | null | undefined>>();

/** File-only origin projection. Ambiguous config keeps the last explicit repair. */
export async function readCurrentOriginReadOnly(root: string): Promise<string | null | undefined> {
  try {
    let gitDir = join(root, '.git');
    const marker = await stat(gitDir);
    if (marker.isFile()) {
      const pointer = (await readFile(gitDir, 'utf8')).trim().match(/^gitdir: (.+)$/)?.[1];
      if (!pointer) return undefined;
      gitDir = resolve(root, pointer);
    } else if (!marker.isDirectory()) return undefined;
    const common = await readFile(join(gitDir, 'commondir'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const config = await readFile(join(common === null ? gitDir : resolve(gitDir, common.trim()), 'config'), 'utf8');
    // Git resolves includes, URL rewrites and per-worktree overrides on the write
    // path. Never mistake an unsupported configuration for a removed origin.
    if (/^\s*\[(?:include|includeIf|url|extensions)(?:\s|\])/im.test(config)) return undefined;
    let origin = false;
    for (const line of config.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        origin = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*(?:[#;].*)?$/i)?.[1] === 'origin';
        continue;
      }
      if (!origin) continue;
      const raw = line.match(/^\s*url\s*=\s*(.*?)\s*$/i)?.[1];
      if (raw === undefined) continue;
      // Quoting, escaping and comments need Git's full config parser. Preserve
      // the saved value until write maintenance can resolve those forms.
      if (/["\\#;]/.test(raw)) return undefined;
      return raw || null;
    }
    return null;
  } catch { return undefined; }
}
async function git(root: string, args: string[]) {
  return (await run('git', ['-C', root, ...args], { windowsHide: true, timeout: 2500, maxBuffer: 128 * 1024 })).stdout.trim();
}
async function readOrigin(root: string): Promise<string | null | undefined> {
  try {
    const cached = origins.get(root);
    // --git-path resolves the shared config for linked worktrees as well.
    const config = cached?.config ?? await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'config']);
    const info = await stat(config);
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (cached?.stamp === stamp && Date.now() - cached.checkedAt < 5000) return cached.remote;
    const remote = await git(root, ['remote', 'get-url', 'origin']).catch(() => null);
    if (origins.size >= 128) origins.delete(origins.keys().next().value!);
    origins.set(root, { config, stamp, remote, checkedAt: Date.now() });
    return remote || null;
  } catch { return undefined; } // An offline local folder does not erase its saved remote.
}
export async function readCurrentOrigin(root: string) {
  const existing = pending.get(root);
  if (existing) return existing;
  const work = readOrigin(root).finally(() => pending.delete(root));
  pending.set(root, work);
  return work;
}
