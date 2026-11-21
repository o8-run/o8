import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type IdeSurfaceState = {
  updatedAt: string;
  terminalRepoPaths: string[];
  activeRepoPath?: string | null;
};

const STATE_DIR = getDataDir();
const SURFACE_STATE_FILE = path.join(STATE_DIR, 'ide-surface-state.json');

function normalizeRepoPath(repoPath?: string | null) {
  const trimmed = repoPath?.trim();
  return trimmed ? path.normalize(trimmed) : null;
}

export function readIdeSurfaceState(): IdeSurfaceState | null {
  if (!existsSync(SURFACE_STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SURFACE_STATE_FILE, 'utf8')) as Partial<IdeSurfaceState>;
    const terminalRepoPaths = Array.isArray(parsed.terminalRepoPaths)
      ? parsed.terminalRepoPaths
        .map((repoPath) => normalizeRepoPath(repoPath))
        .filter((repoPath): repoPath is string => Boolean(repoPath))
      : [];
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      terminalRepoPaths,
      activeRepoPath: normalizeRepoPath(parsed.activeRepoPath),
    };
  } catch {
    return null;
  }
}

export function listIdeSurfaceRepoPaths() {
  const state = readIdeSurfaceState();
  if (!state) return [];
  const repoPaths = new Set<string>(state.terminalRepoPaths.map((repoPath) => repoPath.toLowerCase()));
  if (state.activeRepoPath) {
    repoPaths.add(state.activeRepoPath.toLowerCase());
  }
  return [...repoPaths];
}
