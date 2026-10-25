import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { getDataDir } from '@/lib/data-dir-migration';
import { loadOperatorDefaultsFilesSync } from '@/lib/settings/operator-defaults-store';
import { parseKnowledgeSources, type KnowledgeSource } from '@/lib/operator/knowledge-source-defaults';
import { gitWriteRoots } from './git-write-roots';

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
  const requested = path.resolve(source.path);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(requested) !== requested || requested === path.parse(requested).root) throw new Error('Choose a real folder, without linked path components.');
  const root = realpathSync.native(requested);
  if (overlapsSource(root, normalizeKnowledgeWritePath(getDataDir()))) throw new Error('Knowledge folders must be separate from o8 storage.');
  // Knowledge sources have their own identity and never become repository targets.
  let repos: Array<{ localPath?: string; path?: string }> = [];
  try { const value = JSON.parse(readFileSync(path.join(getDataDir(), 'repos.json'), 'utf8')).repos; repos = Array.isArray(value) ? value : []; } catch { /* No registered repositories. */ }
  for (const repo of repos) {
    const rawPath = repo.localPath ?? repo.path;
    let repoPath = rawPath;
    if (rawPath) repoPath = normalizeKnowledgeWritePath(rawPath);
    if (repoPath && [repoPath, ...gitWriteRoots(repoPath).map(normalizeKnowledgeWritePath)].some(target => overlapsSource(root, target))) throw new Error('Choose a notes folder separate from registered repositories.');
  }
  return { ...source, path: root };
}
export function validateKnowledgeSourceRoots(value: unknown) {
  const previous = configuredKnowledgeSources();
  const sources = parseKnowledgeSources(value).map(source => previous.some(old => JSON.stringify(old) === JSON.stringify(source)) ? source : canonicalSource(source));
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    if (overlapsSource(normalizeKnowledgeWritePath(sources[i].path), normalizeKnowledgeWritePath(sources[j].path))) throw new Error('Knowledge folders must not overlap.');
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
  const expanded = candidate.replace(/^~(?=\/|$)/, homedir());
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

/** Read-only probe on an existing parent; never create a case-detection file. */
function parentIsCaseSensitive(candidate: string): boolean | null {
  let directory = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const current = lstatSync(directory);
      if (current.isDirectory()) {
        const parent = path.dirname(directory);
        if (parent === directory || lstatSync(parent).dev !== current.dev) return null;
        const name = path.basename(directory);
        const alternate = name.replace(/[a-zA-Z]/, letter => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase());
        if (alternate !== name) {
          try {
            const alias = lstatSync(path.join(parent, alternate));
            return alias.dev !== current.dev || alias.ino !== current.ino;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            return null;
          }
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

function overlapsSource(root: string, target: string): boolean {
  if (containsPath(root, target) || containsPath(target, root)) return true;
  const foldedRoot = root.normalize('NFC').toLowerCase();
  const foldedTarget = target.normalize('NFC').toLowerCase();
  if (!containsPath(foldedRoot, foldedTarget) && !containsPath(foldedTarget, foldedRoot)) return false;
  // Missing descendants cannot be canonicalized by realpath. Keep their
  // reservation on insensitive (or unverified) volumes, while allowing
  // genuinely distinct siblings on a proven case-sensitive volume.
  return parentIsCaseSensitive(root) !== true || parentIsCaseSensitive(target) !== true;
}

export function assertNotKnowledgeSource(candidate: string | null | undefined): void {
  if (!candidate) return;
  const sources = configuredKnowledgeSources();
  if (!sources.length) return;
  const lexical = path.resolve(expandWritePath(candidate));
  const physical = normalizeKnowledgeWritePath(candidate);
  // Guard a padded picker spelling too, but never use its trimmed alias as
  // the execution target. Significant literal whitespace must survive.
  const trimmed = normalizeKnowledgeWritePath(candidate.trim());
  const roots = sources.map(source => physicalWritePath(source.path));
  if (roots.some(root => {
    // Persisted source roots are literal absolute paths, never shell input.
    return [lexical, physical, trimmed].some(target => overlapsSource(root, target));
  })) throw new KnowledgeSourceWriteError();
  try {
    if (gitWriteRoots(physical).some(metadata => roots.some(root => overlapsSource(root, normalizeKnowledgeWritePath(metadata))))) throw new KnowledgeSourceWriteError();
  } catch {
    // Unknown Git administration paths cannot authorize a writable alias.
    throw new KnowledgeSourceWriteError();
  }
}

/** Shared refusal for raw API paths, before normalization or any writable effect. */
export function knowledgeSourceWriteRefusal(...paths: Array<string | null | undefined>): Response | null {
  try { for (const candidate of paths) assertNotKnowledgeSource(candidate); }
  catch (error) {
    if (!(error instanceof KnowledgeSourceWriteError)) throw error;
    return Response.json({ error: error.message, code: 'knowledge_source_read_only' }, { status: 403 });
  }
  return null;
}
