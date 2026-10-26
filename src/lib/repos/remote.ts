import 'server-only';
import { execFile } from '@/lib/providers/child-process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
interface Origin { config: string; stamp: string; remote: string | null; checkedAt: number }
const origins = new Map<string, Origin>();
const pending = new Map<string, Promise<string | null | undefined>>();
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
