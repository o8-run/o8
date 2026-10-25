import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { getDataDir } from '@/lib/data-dir-migration';
import { loadOperatorDefaultsFilesSync } from '@/lib/settings/operator-defaults-store';
import { parseKnowledgeSources, type KnowledgeSource } from '@/lib/operator/knowledge-source-defaults';

export function configuredKnowledgeSources(): KnowledgeSource[] {
  const values = loadOperatorDefaultsFilesSync(raw => JSON.parse(raw));
  try { return parseKnowledgeSources(values.knowledgeSources ?? []); } catch { return []; }
}
export function containsPath(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function canonicalSource(source: KnowledgeSource): KnowledgeSource {
  if (!path.isAbsolute(source.path)) throw new Error('Choose an absolute notes-folder path.');
  const root = path.resolve(source.path);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(root) !== root || root === path.parse(root).root) throw new Error('Choose a real folder, without linked path components.');
  if (containsPath(root, path.resolve(getDataDir())) || containsPath(path.resolve(getDataDir()), root)) throw new Error('Knowledge folders must be separate from o8 storage.');
  // Knowledge sources have their own identity and never become repository targets.
  let repos: Array<{ localPath?: string; path?: string }> = [];
  try { const value = JSON.parse(readFileSync(path.join(getDataDir(), 'repos.json'), 'utf8')).repos; repos = Array.isArray(value) ? value : []; } catch { /* No registered repositories. */ }
  for (const repo of repos) {
    const rawPath = repo.localPath ?? repo.path;
    let repoPath = rawPath;
    try { if (rawPath) repoPath = realpathSync(rawPath); } catch { /* Offline repository: lexical path still applies. */ }
    if (repoPath && (containsPath(root, path.resolve(repoPath)) || containsPath(path.resolve(repoPath), root))) throw new Error('Choose a notes folder separate from registered repositories.');
  }
  return { ...source, path: root };
}
export function validateKnowledgeSourceRoots(value: unknown) {
  const previous = configuredKnowledgeSources();
  const sources = parseKnowledgeSources(value).map(source => previous.some(old => JSON.stringify(old) === JSON.stringify(source)) ? source : canonicalSource(source));
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    if (containsPath(sources[i].path, sources[j].path) || containsPath(sources[j].path, sources[i].path)) throw new Error('Knowledge folders must not overlap.');
  }
  return sources;
}
/** Defense at writable entry points, including direct-path callers that bypass repository pickers. */
export class KnowledgeSourceWriteError extends Error {
  constructor() {
    super('Knowledge sources are read-only and cannot be used as workspaces.');
    this.name = 'KnowledgeSourceWriteError';
  }
}

function expandWritePath(candidate: string): string {
  const expanded = candidate.trim().replace(/^~(?=\/|$)/, homedir());
  // Preserve symlink/.. traversal until native realpath has resolved it.
  return path.isAbsolute(expanded) ? expanded : `${process.cwd()}${path.sep}${expanded}`;
}

/** Canonicalize existing parents too, so new files and clone targets get the same protection. */
function physicalWritePath(lexical: string): string {
  let ancestor = lexical;
  while (true) {
    // native realpath returns the stored case on case-insensitive volumes. The
    // JS implementation can retain caller casing on macOS; lowercasing would
    // incorrectly conflate distinct directories on case-sensitive volumes.
    try { return path.resolve(realpathSync.native(ancestor), path.relative(ancestor, lexical)); }
    catch { const parent = path.dirname(ancestor); if (parent === ancestor) return path.resolve(lexical); ancestor = parent; }
  }
}

export function normalizeKnowledgeWritePath(candidate: string): string {
  return physicalWritePath(expandWritePath(candidate));
}

export function assertNotKnowledgeSource(candidate: string | null | undefined): void {
  if (!candidate) return;
  const lexical = path.resolve(expandWritePath(candidate));
  const physical = normalizeKnowledgeWritePath(candidate);
  // Some internal callers already hold literal filesystem paths. Preserve
  // significant whitespace there as well as accepting trimmed picker input.
  const literal = physicalWritePath(path.isAbsolute(candidate) ? candidate : `${process.cwd()}${path.sep}${candidate}`);
  if (configuredKnowledgeSources().some(source => {
    // Persisted source roots are literal absolute paths, never shell input.
    const root = physicalWritePath(source.path);
    return [lexical, physical, literal].some(target => containsPath(root, target) || containsPath(target, root));
  })) throw new KnowledgeSourceWriteError();
}
