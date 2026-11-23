import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { listIdeSurfaceRepoPaths } from '@/lib/runtime/ide-surface-state';
import { getDataDir } from '@/lib/data-dir-migration';

export type PersistedChatRuntime = 'codex' | 'claude-code';

export type PersistedTab = {
  id?: string;
  label?: string;
  kind?: 'terminal' | 'chat' | 'llm-chat' | 'canvas';
  chatRuntime?: PersistedChatRuntime;
  chatSessionKey?: string;
  chatModel?: string;
  repoName?: string;
  repoPath?: string;
  supervisorStatus?: string | null;
};

export type PersistedTabState = {
  activeTabId?: string;
  tabs?: PersistedTab[];
  savedAt?: string;
};

export type IdeTerminalStateFile = {
  scope: string;
  filePath: string;
  savedAt?: string;
  savedAtMs: number;
  activeTabId?: string;
  tabs: PersistedTab[];
};

const TERMINAL_STATE_DIR = path.join(getDataDir(), 'terminal-states');

function toMillis(isoLike?: string) {
  if (!isoLike) return 0;
  const parsed = Date.parse(isoLike);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasSurfaceRepo(tab: PersistedTab) {
  if (!tab.repoPath?.trim()) return false;
  return tab.kind === 'chat' || tab.kind === 'llm-chat' || tab.kind === 'canvas';
}

function normalizeRepoPath(repoPath?: string) {
  const trimmed = repoPath?.trim();
  return trimmed ? path.normalize(trimmed).toLowerCase() : null;
}

function collectRepoPaths(tabs: PersistedTab[]) {
  const repoPaths = new Set<string>();
  for (const tab of tabs) {
    const normalized = normalizeRepoPath(tab.repoPath);
    if (!normalized || !hasSurfaceRepo(tab)) continue;
    repoPaths.add(normalized);
  }
  return repoPaths;
}

// Parsed files keyed by path, kept while the file's identity, size and times
// match: every inbox build and chat listing reads these, and they rarely change.
const parsedStateFiles = new Map<string, { stamp: string; file: IdeTerminalStateFile | null }>();

export function readIdeTerminalStateFiles(): IdeTerminalStateFile[] {
  let names: string[];
  try {
    names = readdirSync(TERMINAL_STATE_DIR);
  } catch {
    parsedStateFiles.clear();
    return [];
  }

  const files: IdeTerminalStateFile[] = [];
  const present = new Set<string>();
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(TERMINAL_STATE_DIR, file);
    present.add(filePath);
    let stamp: string;
    try {
      const info = statSync(filePath, { bigint: true });
      stamp = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch {
      continue;
    }
    let entry = parsedStateFiles.get(filePath);
    if (entry?.stamp !== stamp) {
      entry = { stamp, file: parseStateFile(file, filePath) };
      parsedStateFiles.set(filePath, entry);
    }
    if (entry.file) files.push(entry.file);
  }
  for (const filePath of parsedStateFiles.keys()) if (!present.has(filePath)) parsedStateFiles.delete(filePath);
  return files.sort((left, right) => right.savedAtMs - left.savedAtMs);
}

function parseStateFile(file: string, filePath: string): IdeTerminalStateFile | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PersistedTabState;
    // Frozen: callers share the cached parse.
    return Object.freeze({
      scope: file.replace(/\.json$/, ''),
      filePath,
      savedAt: parsed.savedAt,
      savedAtMs: toMillis(parsed.savedAt),
      activeTabId: parsed.activeTabId,
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
    });
  } catch {
    // Ignore malformed persisted state files and continue scanning.
    return null;
  }
}

export function listCurrentIdeRepoPaths() {
  const surfaceRepoPaths = listIdeSurfaceRepoPaths();
  if (surfaceRepoPaths.length > 0) {
    return surfaceRepoPaths;
  }

  const files = readIdeTerminalStateFiles();
  if (files.length === 0) return [];

  const tileRoot = files.find((file) => file.scope === 'tile-root');
  const rootRepoPaths = tileRoot ? collectRepoPaths(tileRoot.tabs) : new Set<string>();
  if (rootRepoPaths.size > 0) {
    return [...rootRepoPaths];
  }

  for (const file of files) {
    const activeTab = file.tabs.find((tab) => tab.id === file.activeTabId);
    const normalized = normalizeRepoPath(activeTab?.repoPath);
    if (!normalized || !activeTab || !hasSurfaceRepo(activeTab)) continue;
    return [normalized];
  }

  for (const file of files) {
    const repoPaths = collectRepoPaths(file.tabs);
    if (repoPaths.size > 0) return [...repoPaths];
  }

  return [];
}
