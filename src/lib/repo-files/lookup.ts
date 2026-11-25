/**
 * Fresh, bounded repository facts for the files a task names.
 *
 * Runs only when a task is dispatched or a lane reaches the merge gate: there
 * is no index, no database and no timer. The tracked-path list comes from
 * `git ls-files` and is cached per repository until HEAD or the Git index
 * changes. Line counts and exports are read from the files themselves, and
 * importers come from one `git grep`. Every lookup is async and time-bounded;
 * a lookup that cannot finish returns empty facts instead of blocking dispatch.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';

export const REPO_LOOKUP_TIMEOUT_MS = 2_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LIST_BYTES = 64 * 1024 * 1024;
const MAX_FACT_FILES = 64;
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const CANDIDATE_SUFFIXES = ['', ...SOURCE_SUFFIXES, ...SOURCE_SUFFIXES.map((suffix) => `/index${suffix}`)];
const ALIASES: Array<[prefix: string, replacement: string]> = [['@/', 'src/']];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
const EXPORT_LINE = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+[A-Za-z0-9_$]+/;

export interface TrackedFiles {
  files: string[];
  set: ReadonlySet<string>;
}

export interface FileFacts {
  lineCount: number;
  contentHash: string;
  exports: string[];
  imports: string[];
}

interface CachedList extends TrackedFiles {
  key: string;
}

const trackedCache = new Map<string, CachedList>();
const gitDirCache = new Map<string, string>();

/** Git reads must not follow a caller's GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return env;
}

function git(repoPath: string, args: string[], timeoutMs: number, okCodes: number[] = [0]): Promise<string | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, ...args], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_LIST_BYTES, env: gitEnv(), windowsHide: true,
    }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
      resolve(code !== null && okCodes.includes(code) ? stdout : null);
    });
  });
}

function remaining(deadline: number): number {
  return deadline - Date.now();
}

async function gitDir(repoPath: string, deadline: number): Promise<string | null> {
  const cached = gitDirCache.get(repoPath);
  if (cached) return cached;
  const out = await git(repoPath, ['rev-parse', '--absolute-git-dir'], remaining(deadline));
  const dir = out?.trim();
  if (!dir) return null;
  gitDirCache.set(repoPath, dir);
  return dir;
}

async function listKey(dir: string): Promise<string | null> {
  try {
    const [head, index] = await Promise.all([
      readFile(join(dir, 'HEAD'), 'utf8'),
      stat(join(dir, 'index')).catch(() => null),
    ]);
    return `${head.trim()}\0${index ? `${index.ino}:${index.size}:${index.mtimeMs}` : 'none'}`;
  } catch {
    return null;
  }
}

/** Every tracked path, cached until HEAD or the Git index changes. Null when Git cannot answer in time. */
export async function trackedFiles(repoPath: string, deadline = Date.now() + REPO_LOOKUP_TIMEOUT_MS): Promise<TrackedFiles | null> {
  if (!repoPath || !isAbsolute(repoPath)) return null;
  const dir = await gitDir(repoPath, deadline);
  if (!dir) return null;
  const key = await listKey(dir);
  const cached = trackedCache.get(repoPath);
  if (key && cached?.key === key) return cached;
  const out = await git(repoPath, ['ls-files', '-z', '--full-name'], remaining(deadline));
  if (out === null) return null;
  const files = out.split('\0').filter(Boolean);
  const entry: CachedList = { key: key ?? '', files, set: new Set(files) };
  if (key) trackedCache.set(repoPath, entry);
  return entry;
}

export function clearTrackedFiles(repoPath?: string): void {
  if (repoPath) {
    trackedCache.delete(repoPath);
    gitDirCache.delete(repoPath);
  } else {
    trackedCache.clear();
    gitDirCache.clear();
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function exportSignatures(text: string): string[] {
  const exports: string[] = [];
  for (const line of text.split('\n')) {
    const match = EXPORT_LINE.exec(line);
    if (match) exports.push(line.trim().replace(/\s*[{=]\s*$/, '').replace(/\s+/g, ' '));
  }
  return exports;
}

function importSpecifiers(text: string): string[] {
  const specifiers = new Set<string>();
  for (const match of text.matchAll(SPECIFIER)) specifiers.add(match[1]);
  return [...specifiers];
}

/**
 * Read line counts, exports and import specifiers for at most 64 named files.
 * Missing, oversized or unreadable files are left out.
 */
export async function readFileFacts(
  repoPath: string,
  files: readonly string[],
  deadline = Date.now() + REPO_LOOKUP_TIMEOUT_MS,
): Promise<Map<string, FileFacts>> {
  const facts = new Map<string, FileFacts>();
  const unique = [...new Set(files.filter(Boolean))].slice(0, MAX_FACT_FILES);
  await Promise.all(unique.map(async (file) => {
    if (remaining(deadline) <= 0 || isAbsolute(file) || file.split('/').includes('..')) return;
    try {
      const path = join(repoPath, file);
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
      const text = await readFile(path, 'utf8');
      facts.set(file, {
        lineCount: countLines(text),
        contentHash: createHash('sha1').update(text).digest('hex'),
        exports: exportSignatures(text),
        imports: importSpecifiers(text),
      });
    } catch {
      // A file deleted or replaced while reading has no facts.
    }
  }));
  return facts;
}

/** Repository-relative base path for an `@/` alias or relative specifier; null for packages. */
function specifierBase(fromFile: string, specifier: string): string | null {
  const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
  if (alias) return posix.normalize(alias[1] + specifier.slice(alias[0].length));
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    return resolved.startsWith('../') ? null : resolved;
  }
  return null;
}

/** Resolve an import specifier written in `fromFile` to a tracked path. */
export function resolveSpecifier(fromFile: string, specifier: string, tracked: ReadonlySet<string>): string | null {
  const base = specifierBase(fromFile, specifier);
  if (!base) return null;
  const stripped = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  for (const candidate of [base, ...CANDIDATE_SUFFIXES.map((suffix) => `${stripped}${suffix}`)]) {
    if (tracked.has(candidate)) return candidate;
  }
  return null;
}

/** Tracked files that `file` imports, in source order. */
export function outboundImports(file: string, facts: FileFacts | undefined, tracked: ReadonlySet<string>): string[] {
  if (!facts) return [];
  const resolved = new Set<string>();
  for (const specifier of facts.imports) {
    const target = resolveSpecifier(file, specifier, tracked);
    if (target && target !== file) resolved.add(target);
  }
  return [...resolved];
}

function moduleName(file: string): string {
  const withoutExtension = file.replace(/\.[cm]?[jt]sx?$/, '');
  return posix.basename(withoutExtension) === 'index'
    ? posix.basename(posix.dirname(withoutExtension))
    : posix.basename(withoutExtension);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Files that import each target, found with one `git grep` over tracked files.
 * Each match is resolved back to a path, so a shared basename is not a false hit.
 */
export async function findImporters(
  repoPath: string,
  targets: readonly string[],
  tracked: ReadonlySet<string>,
  deadline = Date.now() + REPO_LOOKUP_TIMEOUT_MS,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(targets.map((target) => [target, []]));
  const names = [...new Set(targets.map(moduleName).filter(Boolean))];
  if (names.length === 0) return result;
  const pattern = `['"][^'"]*(${names.map(escapeRegex).join('|')})(\\.[cm]?[jt]sx?)?(/index)?['"]`;
  const search = (syntax: '-P' | '-E') => git(repoPath, ['grep', '-I', '-o', syntax, '--full-name', '-e', pattern, '--', ...SOURCE_SUFFIXES.map((suffix) => `*${suffix}`)], remaining(deadline), [0, 1]);
  // PCRE is several times faster on large trees; Git builds without it fall back to ERE.
  const out = await search('-P') ?? (remaining(deadline) > 0 ? await search('-E') : null);
  if (!out) return result;
  const wanted = new Set(targets);
  for (const line of out.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const file = line.slice(0, separator);
    const specifier = line.slice(separator + 2, -1);
    const target = resolveSpecifier(file, specifier, tracked);
    if (!target || target === file || !wanted.has(target)) continue;
    const importers = result.get(target)!;
    if (!importers.includes(file)) importers.push(file);
  }
  return result;
}

/**
 * Line counts of files as they are at `ref`, read with one `git cat-file --batch`.
 * Files missing at `ref` (new files) are left out.
 */
export function lineCountsAt(
  repoPath: string,
  ref: string,
  files: readonly string[],
  deadline = Date.now() + REPO_LOOKUP_TIMEOUT_MS,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const unique = [...new Set(files.filter((file) => file && !file.includes('\n')))];
  // A lookup whose deadline has passed does not start: no count, so the gate applies no budget.
  if (unique.length === 0 || !ref || ref.startsWith('-') || remaining(deadline) <= 0) return Promise.resolve(counts);
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoPath, 'cat-file', '--batch'], { env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(counts);
    };
    const timer = setTimeout(finish, remaining(deadline));
    child.on('error', finish);
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_LIST_BYTES) return finish();
      chunks.push(chunk);
    });
    child.on('close', () => {
      if (settled) return;
      const output = Buffer.concat(chunks);
      let offset = 0;
      for (const file of unique) {
        const headerEnd = output.indexOf(10, offset);
        if (headerEnd === -1) break;
        const header = output.subarray(offset, headerEnd).toString('utf8').split(' ');
        offset = headerEnd + 1;
        if (header.length !== 3) continue; // "<name> missing" or ambiguous
        const length = Number(header[2]);
        const content = output.subarray(offset, offset + length);
        offset += length + 1;
        if (header[1] === 'blob') counts.set(file, countLines(content.toString('utf8')));
      }
      finish();
    });
    child.stdin.end(unique.map((file) => `${ref}:${file}\n`).join(''));
  });
}
