import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';

export interface DiffStats { additions: number; deletions: number; changedFiles: number }

const DIFF_CACHE_TTL = 30_000;
const GIT_TIMEOUT_MS = 5_000;
const diffCache = new Map<string, { data: DiffStats | null; ts: number }>();
const inflight = new Map<string, Promise<DiffStats | null>>();

type Git = (args: string[], cwd: string) => Promise<string>;

const execFileAsync = promisify(execFile);
const defaultGit: Git = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    return String(stdout);
  } catch {
    // Same as the old `2>/dev/null`: a failing diff contributes nothing.
    return '';
  }
};

export function parseShortstat(text: string): DiffStats | null {
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    const filesMatch = line.match(/(\d+) files? changed/);
    const addMatch = line.match(/(\d+) insertions?\(\+\)/);
    const delMatch = line.match(/(\d+) deletions?\(-\)/);
    if (filesMatch) changedFiles += parseInt(filesMatch[1], 10);
    if (addMatch) additions += parseInt(addMatch[1], 10);
    if (delMatch) deletions += parseInt(delMatch[1], 10);
  }
  return additions === 0 && deletions === 0 ? null : { additions, deletions, changedFiles };
}

/**
 * Local diff stats without blocking the event loop: async git, a 30 s TTL
 * cache, and one in-flight read per cwd so concurrent route calls share it.
 */
export function readLocalDiffStats(cwd: string, isDefault: boolean, git: Git = defaultGit, now = Date.now): Promise<DiffStats | null> {
  const cached = diffCache.get(cwd);
  if (cached && now() - cached.ts < DIFF_CACHE_TTL) return Promise.resolve(cached.data);
  const pending = inflight.get(cwd);
  if (pending) return pending;
  const read = (async () => {
    const outputs = isDefault
      ? [await git(['diff', '--shortstat'], cwd)]
      : await Promise.all([git(['diff', '--shortstat', 'origin/main..HEAD'], cwd), git(['diff', '--shortstat'], cwd)]);
    const data = parseShortstat(outputs.join('\n'));
    diffCache.set(cwd, { data, ts: now() });
    return data;
  })().catch(() => null).finally(() => inflight.delete(cwd));
  inflight.set(cwd, read);
  return read;
}

export function resetDiffStatsForTest(): void {
  diffCache.clear();
  inflight.clear();
}
