import 'server-only';

import { execFile } from '@/lib/providers/child-process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadTypeScriptCompiler } from '@/lib/typescript-compiler';

import { parseNameStatus, type LaneFileChange } from '@/lib/lane/lane-diff-facts';
import type {
  ArchitectureDeltaEdge,
  ArchitectureDeltaNode,
  ArchitectureDeltaResult,
  ArchitectureModuleState,
} from '@/lib/review/architecture-delta-types';
import {
  architectureSnapshotCacheKey,
  createExpiringLruCache,
  mapWithConcurrency,
  sourceImportSpecifiers,
  type ParsedSourceImports,
} from '@/lib/review/architecture-delta-work';

const execFileAsync = promisify(execFile);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const MAX_SOURCE_FILES = 6_000;
const MAX_CHANGED_SOURCE_FILES = 6_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_IMPORTS_PER_FILE = 2_000;
const MAX_IMPORT_SPECIFIERS = 250_000;
const MAX_SNAPSHOT_EDGES = 20_000;
const MAX_REPORTED_PATHS = 200;
const MAX_RESULT_NODES = 80;
const MAX_RESULT_EDGES = 160;
const CURRENT_READ_CONCURRENCY = 32;
const SNAPSHOT_CACHE_TTL_MS = 60_000;
const MAX_SNAPSHOT_CACHE_ENTRIES = 24;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

interface AliasRule {
  pattern: string;
  targets: string[];
}

interface ResolverConfig {
  aliases: AliasRule[];
  baseRoots: string[];
  warnings: string[];
}

interface SnapshotGraph {
  edges: Set<string>;
  parsedSources: Set<string>;
  sourcePaths: Set<string>;
  truncated: boolean;
}

const snapshotCache = createExpiringLruCache<ArchitectureDeltaResult>(
  MAX_SNAPSHOT_CACHE_ENTRIES,
  SNAPSHOT_CACHE_TTL_MS,
);

export interface BuildArchitectureDeltaOptions {
  repoPath: string;
  baseRef?: string;
  afterCacheKeyForTesting?: () => void | Promise<void>;
  afterSnapshotForTesting?: () => void | Promise<void>;
}

export class ArchitectureDeltaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchitectureDeltaInputError';
  }
}

function emptySummary() {
  return { changedModules: 0, addedEdges: 0, removedEdges: 0, contextEdges: 0 };
}

export function architectureAnalysisId(result: ArchitectureDeltaResult): string {
  return createHash('sha256').update(JSON.stringify({
    status: result.status,
    reason: result.reason,
    nodes: result.nodes,
    edges: result.edges,
    summary: result.summary,
    unsupportedPaths: result.unsupportedPaths,
    omittedPaths: result.omittedPaths,
    resolutionWarnings: result.resolutionWarnings,
    truncated: result.truncated,
  })).digest('hex').slice(0, 24);
}

function withAnalysisId(result: ArchitectureDeltaResult): ArchitectureDeltaResult {
  return { ...result, analysisId: architectureAnalysisId(result) };
}

export function unavailableArchitectureDelta(reason: string): ArchitectureDeltaResult {
  return withAnalysisId({
    ok: true,
    status: 'unavailable',
    reason,
    nodes: [],
    edges: [],
    summary: emptySummary(),
    unsupportedPaths: [],
    omittedPaths: [],
    resolutionWarnings: [],
    truncated: false,
    generatedAt: new Date().toISOString(),
  });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return String(stdout);
}

async function gitValue(cwd: string, args: string[]) {
  return (await gitOutput(cwd, args)).trim();
}

function splitNulls(value: string) {
  return value.split('\0').filter(Boolean);
}

function isSupportedSource(filePath: string) {
  const lower = filePath.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function toPosix(filePath: string) {
  return filePath.split(path.sep).join('/');
}

async function resolveRepoRoot(repoPath: string) {
  if (!path.isAbsolute(repoPath)) {
    throw new ArchitectureDeltaInputError('Architecture analysis requires an absolute repository path.');
  }
  let canonical: string;
  try {
    canonical = await realpath(repoPath);
  } catch {
    throw new ArchitectureDeltaInputError('The selected review workspace is unavailable.');
  }
  let gitRoot: string;
  try {
    gitRoot = await realpath(await gitValue(canonical, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new ArchitectureDeltaInputError('The selected review workspace is not a Git repository.');
  }
  if (gitRoot !== canonical) {
    throw new ArchitectureDeltaInputError('Architecture analysis requires the repository root.');
  }
  return canonical;
}

async function resolveBaseCommit(repoRoot: string, baseRef: string) {
  try {
    return await gitValue(repoRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  } catch {
    throw new ArchitectureDeltaInputError('The review baseline is unavailable.');
  }
}

async function workspaceFingerprint(repoRoot: string) {
  const [head, status] = await Promise.all([
    gitValue(repoRoot, ['rev-parse', 'HEAD']),
    gitOutput(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  return `${head}\0${status}`;
}

async function readChanges(repoRoot: string, baseCommit: string) {
  const [tracked, untracked] = await Promise.all([
    gitOutput(repoRoot, ['diff', '--name-status', '-z', '--find-renames', baseCommit, '--']),
    gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const allChanges = parseNameStatus(tracked);
  const knownPaths = new Set(allChanges.map((change) => change.path));
  for (const filePath of splitNulls(untracked)) {
    if (!knownPaths.has(filePath)) allChanges.push({ path: filePath, status: 'untracked' });
  }
  const sourceChanges = allChanges.filter((change) => (
    isSupportedSource(change.path) || Boolean(change.previousPath && isSupportedSource(change.previousPath))
  ));
  return {
    changes: sourceChanges.slice(0, MAX_CHANGED_SOURCE_FILES),
    omittedChangedPaths: sourceChanges.slice(MAX_CHANGED_SOURCE_FILES, MAX_CHANGED_SOURCE_FILES + MAX_REPORTED_PATHS)
      .map((change) => toPosix(change.path)),
    unsupportedPaths: allChanges.filter((change) => (
      !isSupportedSource(change.path) && !(change.previousPath && isSupportedSource(change.previousPath))
    )).slice(0, MAX_REPORTED_PATHS).map((change) => toPosix(change.path)).sort(),
    truncated: sourceChanges.length > MAX_CHANGED_SOURCE_FILES,
  };
}

async function listAfterPaths(repoRoot: string) {
  const output = await gitOutput(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return splitNulls(output).map(toPosix);
}

async function listBeforePaths(repoRoot: string, baseCommit: string) {
  const output = await gitOutput(repoRoot, ['ls-tree', '-r', '--name-only', '-z', baseCommit, '--']);
  return splitNulls(output).map(toPosix);
}

async function readCurrentSources(
  repoRoot: string,
  paths: string[],
  priorityPaths: Set<string>,
) {
  const supported = paths.filter(isSupportedSource);
  const ordered = [...supported].sort((left, right) => {
    const priority = Number(priorityPaths.has(right)) - Number(priorityPaths.has(left));
    return priority || left.localeCompare(right);
  });
  const limited = ordered.slice(0, MAX_SOURCE_FILES);
  const omittedPaths = ordered.slice(MAX_SOURCE_FILES);

  let totalBytes = 0;
  const contents = new Map<string, string>();
  let truncated = ordered.length > limited.length;
  for (let offset = 0; offset < limited.length; offset += CURRENT_READ_CONCURRENCY) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      truncated = true;
      omittedPaths.push(...limited.slice(offset));
      break;
    }
    const batch = limited.slice(offset, offset + CURRENT_READ_CONCURRENCY);
    const maxBytes = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes);
    const loaded = await mapWithConcurrency(
      batch,
      CURRENT_READ_CONCURRENCY,
      (filePath) => readCurrentFile(repoRoot, filePath, maxBytes),
    );
    for (const [index, filePath] of batch.entries()) {
      const content = loaded[index] ?? null;
      const size = content === null ? 0 : Buffer.byteLength(content, 'utf8');
      if (content === null || totalBytes + size > MAX_TOTAL_BYTES) {
        truncated = true;
        omittedPaths.push(filePath);
        continue;
      }
      totalBytes += size;
      contents.set(filePath, content);
    }
  }
  return { contents, truncated, omittedPaths };
}

async function readCurrentFile(repoRoot: string, filePath: string, maxBytes: number) {
  const fullPath = path.join(repoRoot, filePath);
  try {
    const canonical = await realpath(fullPath);
    if (canonical !== repoRoot && !canonical.startsWith(`${repoRoot}${path.sep}`)) return null;
    const handle = await open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > maxBytes) return null;
      const buffer = Buffer.alloc(metadata.size);
      let bytesRead = 0;
      while (bytesRead < metadata.size) {
        const chunk = await handle.read(buffer, bytesRead, metadata.size - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readBaseFile(
  repoRoot: string,
  baseCommit: string,
  filePath: string,
  maxBytes = MAX_FILE_BYTES,
) {
  try {
    const object = `${baseCommit}:${filePath}`;
    const size = Number(await gitValue(repoRoot, ['cat-file', '-s', object]));
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return null;
    return await gitOutput(repoRoot, ['show', object]);
  } catch {
    return null;
  }
}

function changeBeforePath(change: LaneFileChange) {
  if (change.status === 'added' || change.status === 'untracked') return null;
  return change.status === 'renamed' ? change.previousPath ?? null : change.path;
}

function changedPathSet(changes: LaneFileChange[]) {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(toPosix(change.path));
    if (change.previousPath) paths.add(toPosix(change.previousPath));
  }
  return paths;
}

function afterAbsentPathSet(changes: LaneFileChange[]) {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.status === 'deleted') paths.add(toPosix(change.path));
    if (change.status === 'renamed' && change.previousPath) paths.add(toPosix(change.previousPath));
  }
  return paths;
}

function currentSnapshotPaths(changes: LaneFileChange[]) {
  return [...new Set(changes
    .map((change) => toPosix(change.path))
    .filter(isSupportedSource))].sort((left, right) => left.localeCompare(right));
}

async function exactSnapshotCacheKey(
  repoRoot: string,
  baseCommit: string,
  workspaceState: string,
  changes: LaneFileChange[],
) {
  const currentChangedPaths = currentSnapshotPaths(changes);
  const contents = new Map<string, string>();
  let totalBytes = 0;
  for (let offset = 0; offset < currentChangedPaths.length; offset += CURRENT_READ_CONCURRENCY) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const batch = currentChangedPaths.slice(offset, offset + CURRENT_READ_CONCURRENCY);
    const maxBytes = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes);
    const loaded = await mapWithConcurrency(
      batch,
      CURRENT_READ_CONCURRENCY,
      (filePath) => readCurrentFile(repoRoot, filePath, maxBytes),
    );
    for (const [index, filePath] of batch.entries()) {
      const content = loaded[index] ?? null;
      const size = content === null ? 0 : Buffer.byteLength(content, 'utf8');
      if (content === null || totalBytes + size > MAX_TOTAL_BYTES) continue;
      contents.set(filePath, content);
      totalBytes += size;
    }
  }
  const resolver = await loadCurrentResolverConfig(repoRoot);
  return architectureSnapshotCacheKey({
    repoRoot,
    baseCommit,
    workspaceState,
    changes,
    currentChangedPaths,
    contents,
    resolver,
    maxTotalBytes: MAX_TOTAL_BYTES,
  });
}

async function buildBeforeContents(
  repoRoot: string,
  baseCommit: string,
  beforePaths: Set<string>,
  afterContents: Map<string, string>,
  changes: LaneFileChange[],
) {
  const changed = changedPathSet(changes);
  const contents = new Map<string, string>();
  const omittedPaths: string[] = [];
  let totalBytes = 0;
  for (const change of changes) {
    const beforePath = changeBeforePath(change);
    if (!beforePath || !isSupportedSource(beforePath)) continue;
    const normalized = toPosix(beforePath);
    const remainingBytes = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes);
    const content = remainingBytes > 0
      ? await readBaseFile(repoRoot, baseCommit, normalized, remainingBytes)
      : null;
    if (content !== null) {
      contents.set(normalized, content);
      totalBytes += Buffer.byteLength(content, 'utf8');
    } else {
      omittedPaths.push(normalized);
    }
  }
  for (const [filePath, content] of afterContents) {
    if (!beforePaths.has(filePath) || changed.has(filePath)) continue;
    const size = Buffer.byteLength(content, 'utf8');
    if (totalBytes + size > MAX_TOTAL_BYTES) {
      omittedPaths.push(filePath);
      continue;
    }
    contents.set(filePath, content);
    totalBytes += size;
  }
  return { contents, omittedPaths };
}

async function parseResolverConfig(configPath: string, content: string): Promise<ResolverConfig> {
  const parsed = (await loadTypeScriptCompiler()).parseConfigFileTextToJson(configPath, content);
  if (parsed.error || !parsed.config || typeof parsed.config !== 'object') {
    return { aliases: [], baseRoots: [], warnings: [`Could not parse ${configPath}; configured aliases were omitted.`] };
  }
  const config = parsed.config as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  const compilerOptions = config.compilerOptions ?? {};
  const baseUrlValue = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : null;
  const configDirectory = path.posix.dirname(configPath);
  const baseRoot = baseUrlValue
    ? path.posix.normalize(path.posix.join(configDirectory, baseUrlValue))
    : configDirectory;
  const rules: AliasRule[] = [];
  const configuredPaths = compilerOptions.paths && typeof compilerOptions.paths === 'object'
    ? compilerOptions.paths as Record<string, unknown>
    : {};
  for (const [pattern, rawTargets] of Object.entries(configuredPaths)) {
    if (!Array.isArray(rawTargets)) continue;
    const normalizedTargets = rawTargets.flatMap((target) => {
      if (typeof target !== 'string') return [];
      const relative = path.posix.normalize(path.posix.join(baseRoot, target));
      return relative.startsWith('../') || relative === '..' ? [] : [relative];
    });
    if (normalizedTargets.length) rules.push({ pattern, targets: normalizedTargets });
  }
  const warnings = config.extends
    ? [`${configPath} extends another config; inherited aliases are not included.`]
    : [];
  return { aliases: rules, baseRoots: baseUrlValue ? [baseRoot] : [], warnings };
}

async function loadCurrentResolverConfig(repoRoot: string): Promise<ResolverConfig> {
  for (const configPath of ['tsconfig.json', 'jsconfig.json']) {
    const content = await readCurrentFile(repoRoot, configPath, MAX_FILE_BYTES);
    if (content !== null) return parseResolverConfig(configPath, content);
  }
  return { aliases: [], baseRoots: [], warnings: [] };
}

async function loadBaseResolverConfig(repoRoot: string, baseCommit: string): Promise<ResolverConfig> {
  for (const configPath of ['tsconfig.json', 'jsconfig.json']) {
    const content = await readBaseFile(repoRoot, baseCommit, configPath);
    if (content !== null) return parseResolverConfig(configPath, content);
  }
  return { aliases: [], baseRoots: [], warnings: [] };
}

function analysisContentFingerprint(contents: Map<string, string>, config: ResolverConfig) {
  const hash = createHash('sha256');
  for (const [filePath, content] of [...contents.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(String(Buffer.byteLength(filePath, 'utf8')));
    hash.update(':');
    hash.update(filePath);
    hash.update(String(Buffer.byteLength(content, 'utf8')));
    hash.update(':');
    hash.update(content);
  }
  hash.update(JSON.stringify(config));
  return hash.digest('hex');
}

async function rereadAnalysisContentFingerprint(
  repoRoot: string,
  analyzedContents: Map<string, string>,
) {
  const filePaths = [...analyzedContents.keys()];
  const loaded = await mapWithConcurrency(
    filePaths,
    CURRENT_READ_CONCURRENCY,
    (filePath) => readCurrentFile(repoRoot, filePath, MAX_FILE_BYTES),
  );
  const contents = new Map<string, string>();
  for (const [index, filePath] of filePaths.entries()) {
    const content = loaded[index] ?? null;
    if (content === null) return null;
    contents.set(filePath, content);
  }
  const config = await loadCurrentResolverConfig(repoRoot);
  return analysisContentFingerprint(contents, config);
}

function applyPattern(pattern: string, target: string, value: string) {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === value ? target : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const end = suffix.length ? value.length - suffix.length : value.length;
  const match = value.slice(prefix.length, end);
  return target.replace('*', match);
}

function candidateRoots(specifier: string, fromPath: string, config: ResolverConfig) {
  if (specifier.startsWith('.')) {
    return [path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier))];
  }
  const candidates: string[] = [];
  for (const rule of config.aliases) {
    for (const target of rule.targets) {
      const candidate = applyPattern(rule.pattern, target, specifier);
      if (candidate) candidates.push(path.posix.normalize(candidate));
    }
  }
  for (const baseRoot of config.baseRoots) candidates.push(path.posix.normalize(path.posix.join(baseRoot, specifier)));
  return candidates;
}

function resolveCandidate(root: string, sourcePaths: Set<string>) {
  const exactCandidates = [root];
  const knownExtension = SOURCE_EXTENSIONS.find((extension) => root.toLowerCase().endsWith(extension));
  if (knownExtension) exactCandidates.push(root.slice(0, -knownExtension.length));
  for (const candidate of exactCandidates) {
    if (sourcePaths.has(candidate)) return candidate;
    for (const extension of SOURCE_EXTENSIONS) {
      const withExtension = `${candidate}${extension}`;
      if (sourcePaths.has(withExtension)) return withExtension;
    }
    for (const extension of SOURCE_EXTENSIONS) {
      const indexPath = `${candidate}/index${extension}`;
      if (sourcePaths.has(indexPath)) return indexPath;
    }
  }
  return null;
}

function edgeKey(from: string, to: string) {
  return `${from}\0${to}`;
}

function splitEdgeKey(key: string) {
  const separator = key.indexOf('\0');
  return { from: key.slice(0, separator), to: key.slice(separator + 1) };
}

async function buildGraph(
  contents: Map<string, string>,
  sourcePaths: Set<string>,
  config: ResolverConfig,
  changedPaths: Set<string>,
  parsedImports: Map<string, ParsedSourceImports>,
): Promise<SnapshotGraph> {
  const edges = new Set<string>();
  const parsedSources = new Set<string>();
  let importsProcessed = 0;
  let truncated = false;
  for (const [from, content] of contents) {
    const imported = await sourceImportSpecifiers(from, content, parsedImports);
    if (
      imported.length > MAX_IMPORTS_PER_FILE
      || importsProcessed + imported.length > MAX_IMPORT_SPECIFIERS
    ) {
      truncated = true;
      continue;
    }
    const fileEdges = new Set<string>();
    for (const specifier of imported) {
      const roots = candidateRoots(specifier, from, config);
      const to = roots.map((root) => resolveCandidate(root, sourcePaths)).find(Boolean) ?? null;
      if (to && to !== from && (changedPaths.has(from) || changedPaths.has(to))) {
        fileEdges.add(edgeKey(from, to));
      }
    }
    importsProcessed += imported.length;
    if (edges.size + fileEdges.size > MAX_SNAPSHOT_EDGES) {
      truncated = true;
      continue;
    }
    fileEdges.forEach((edge) => edges.add(edge));
    parsedSources.add(from);
  }
  return { edges, parsedSources, sourcePaths, truncated };
}

function moduleStates(changes: LaneFileChange[]) {
  const states = new Map<string, { state: ArchitectureModuleState; focusPath: string | null }>();
  for (const change of changes) {
    const currentPath = toPosix(change.path);
    if (change.status === 'renamed') {
      if (change.previousPath && isSupportedSource(change.previousPath)) {
        states.set(toPosix(change.previousPath), { state: 'removed', focusPath: currentPath });
      }
      if (isSupportedSource(currentPath)) states.set(currentPath, { state: 'added', focusPath: currentPath });
    } else if (isSupportedSource(currentPath)) {
      const state: ArchitectureModuleState = change.status === 'added' || change.status === 'untracked'
        ? 'added'
        : change.status === 'deleted'
          ? 'removed'
          : 'changed';
      states.set(currentPath, { state, focusPath: currentPath });
    }
  }
  return states;
}

function buildResult(
  beforeGraph: SnapshotGraph,
  afterGraph: SnapshotGraph,
  changes: LaneFileChange[],
  unsupportedPaths: string[],
  omittedPaths: string[],
  resolutionWarnings: string[],
  sourceTruncated: boolean,
): ArchitectureDeltaResult {
  const states = moduleStates(changes);
  if (states.size === 0) {
    return withAnalysisId({
      ok: true,
      status: 'unsupported',
      reason: 'No supported source modules changed.',
      nodes: [],
      edges: [],
      summary: emptySummary(),
      unsupportedPaths,
      omittedPaths,
      resolutionWarnings,
      truncated: sourceTruncated,
      generatedAt: new Date().toISOString(),
    });
  }

  const changedPaths = new Set(states.keys());
  const allEdgeKeys = new Set([...beforeGraph.edges, ...afterGraph.edges]);
  const edgeCandidates: ArchitectureDeltaEdge[] = [];
  for (const key of allEdgeKeys) {
    const { from, to } = splitEdgeKey(key);
    if (!changedPaths.has(from) && !changedPaths.has(to)) continue;
    const beforeKnown = !beforeGraph.sourcePaths.has(from) || beforeGraph.parsedSources.has(from);
    const afterKnown = !afterGraph.sourcePaths.has(from) || afterGraph.parsedSources.has(from);
    if (!beforeKnown || !afterKnown) continue;
    const before = beforeGraph.edges.has(key);
    const after = afterGraph.edges.has(key);
    const state = before && after ? 'context' : after ? 'added' : 'removed';
    const focusPath = states.get(from)?.focusPath ?? states.get(to)?.focusPath ?? null;
    edgeCandidates.push({ from, to, state, focusPath });
  }
  edgeCandidates.sort((left, right) => {
    const rank = { added: 0, removed: 1, context: 2 } as const;
    return rank[left.state] - rank[right.state]
      || left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to);
  });

  let truncated = sourceTruncated || edgeCandidates.length > MAX_RESULT_EDGES;
  let edges = edgeCandidates.slice(0, MAX_RESULT_EDGES);
  const nodePaths = new Set(changedPaths);
  for (const edge of edges) {
    nodePaths.add(edge.from);
    nodePaths.add(edge.to);
  }
  const orderedNodes = [...nodePaths].sort((left, right) => {
    const leftChanged = states.has(left) ? 0 : 1;
    const rightChanged = states.has(right) ? 0 : 1;
    return leftChanged - rightChanged || left.localeCompare(right);
  });
  if (orderedNodes.length > MAX_RESULT_NODES) truncated = true;
  const selectedPaths = new Set(orderedNodes.slice(0, MAX_RESULT_NODES));
  edges = edges.filter((edge) => selectedPaths.has(edge.from) && selectedPaths.has(edge.to));
  const nodes: ArchitectureDeltaNode[] = [...selectedPaths].map((filePath) => {
    const change = states.get(filePath);
    return {
      path: filePath,
      state: change?.state ?? 'context',
      focusPath: change?.focusPath ?? null,
    };
  });

  return withAnalysisId({
    ok: true,
    status: 'ready',
    reason: null,
    nodes,
    edges,
    summary: {
      changedModules: nodes.filter((node) => node.state !== 'context').length,
      addedEdges: edges.filter((edge) => edge.state === 'added').length,
      removedEdges: edges.filter((edge) => edge.state === 'removed').length,
      contextEdges: edges.filter((edge) => edge.state === 'context').length,
    },
    unsupportedPaths,
    omittedPaths,
    resolutionWarnings,
    truncated,
    generatedAt: new Date().toISOString(),
  });
}

export async function buildArchitectureDelta({
  repoPath,
  baseRef = 'HEAD',
  afterCacheKeyForTesting,
  afterSnapshotForTesting,
}: BuildArchitectureDeltaOptions): Promise<ArchitectureDeltaResult> {
  const repoRoot = await resolveRepoRoot(repoPath);
  const baseCommit = await resolveBaseCommit(repoRoot, baseRef);
  const firstFingerprint = await workspaceFingerprint(repoRoot);
  const changeSet = await readChanges(repoRoot, baseCommit);
  const { changes, unsupportedPaths } = changeSet;
  const snapshotCacheKey = afterSnapshotForTesting
    ? null
    : await exactSnapshotCacheKey(repoRoot, baseCommit, firstFingerprint, changes);
  await afterCacheKeyForTesting?.();
  const cachedResult = snapshotCacheKey ? snapshotCache.read(snapshotCacheKey) : null;
  if (cachedResult && snapshotCacheKey) {
    const [confirmedFingerprint, confirmedCacheKey] = await Promise.all([
      workspaceFingerprint(repoRoot),
      exactSnapshotCacheKey(repoRoot, baseCommit, firstFingerprint, changes),
    ]);
    if (confirmedFingerprint === firstFingerprint && confirmedCacheKey === snapshotCacheKey) {
      return cachedResult;
    }
  }
  const changedPaths = changedPathSet(changes);
  const [listedAfterPaths, beforePathList] = await Promise.all([
    listAfterPaths(repoRoot),
    listBeforePaths(repoRoot, baseCommit),
  ]);
  const afterAbsentPaths = afterAbsentPathSet(changes);
  const afterPaths = listedAfterPaths.filter((filePath) => !afterAbsentPaths.has(filePath));
  const afterSourcePaths = new Set(afterPaths.filter(isSupportedSource));
  const beforeSourcePaths = new Set(beforePathList.filter(isSupportedSource));
  const { contents: afterContents, truncated: sourceTruncated, omittedPaths: afterOmittedPaths } = await readCurrentSources(
    repoRoot,
    afterPaths,
    changedPaths,
  );
  const { contents: beforeContents, omittedPaths: beforeOmittedPaths } = await buildBeforeContents(
    repoRoot,
    baseCommit,
    beforeSourcePaths,
    afterContents,
    changes,
  );
  const [beforeResolver, afterResolver] = await Promise.all([
    loadBaseResolverConfig(repoRoot, baseCommit),
    loadCurrentResolverConfig(repoRoot),
  ]);
  const firstAnalysisContentFingerprint = analysisContentFingerprint(afterContents, afterResolver);
  await afterSnapshotForTesting?.();
  const omittedPaths = [...new Set([
    ...changeSet.omittedChangedPaths,
    ...afterOmittedPaths,
    ...beforeOmittedPaths,
  ])].sort().slice(0, MAX_REPORTED_PATHS);
  const resolutionWarnings = [...new Set([...beforeResolver.warnings, ...afterResolver.warnings])].sort();
  const parsedImports = new Map<string, ParsedSourceImports>();
  const beforeGraph = await buildGraph(beforeContents, beforeSourcePaths, beforeResolver, changedPaths, parsedImports);
  const afterGraph = await buildGraph(afterContents, afterSourcePaths, afterResolver, changedPaths, parsedImports);
  const result = buildResult(
    beforeGraph,
    afterGraph,
    changes,
    unsupportedPaths,
    omittedPaths,
    resolutionWarnings,
    sourceTruncated
      || changeSet.truncated
      || beforeOmittedPaths.length > 0
      || beforeGraph.truncated
      || afterGraph.truncated,
  );
  const lastAnalysisContentFingerprint = await rereadAnalysisContentFingerprint(repoRoot, afterContents);
  const lastFingerprint = await workspaceFingerprint(repoRoot);
  if (
    lastFingerprint !== firstFingerprint
    || lastAnalysisContentFingerprint !== firstAnalysisContentFingerprint
  ) {
    return unavailableArchitectureDelta('The workspace changed during architecture analysis. Refresh Review to retry.');
  }
  if (snapshotCacheKey) {
    const analyzedCacheKey = architectureSnapshotCacheKey({
      repoRoot,
      baseCommit,
      workspaceState: firstFingerprint,
      changes,
      currentChangedPaths: currentSnapshotPaths(changes),
      contents: afterContents,
      resolver: afterResolver,
      maxTotalBytes: MAX_TOTAL_BYTES,
    });
    snapshotCache.write(analyzedCacheKey, result);
  }
  return result;
}
