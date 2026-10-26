import { execFile } from '@/lib/providers/child-process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ReviewChangedFile,
  ReviewIssueSummary,
  ReviewPullRequestSummary,
  WorkflowReviewSnapshot,
} from '@/lib/fleet/types';
import { parseRecentCommits } from '@/lib/git/recent-commits';
import { parseWorktrees } from './worktrees';
import { createWorkspaceReviewCommands } from './workspace-commands';
import { assertReviewWorkspace, requireReviewGit } from './workspace-status';
import type { MobileReviewFileDetail } from '@/lib/mobile/types';

const execFileAsync = promisify(execFile);
const REVIEW_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
const REVIEW_REPO_SLUG = process.env.CORTEX_IDE_REVIEW_REPO || '';
// Avoid scanning the packaged server directory when no workspace is selected.
let _defaultRootIsRepoCache: boolean | null = null;
function defaultReviewRootIsRepo(): boolean {
  if (_defaultRootIsRepoCache === null) {
    _defaultRootIsRepoCache = existsSync(path.join(REVIEW_REPO_ROOT, '.git'));
    if (!_defaultRootIsRepoCache) {
      console.log(
        `[workspace-perf] default review root is not a git repo — snapshots disabled for ${REVIEW_REPO_ROOT} (pass workspacePath explicitly to scan a repo)`,
      );
    }
  }
  return _defaultRootIsRepoCache;
}
const MAX_LINKED_ISSUE_LOOKUPS = 3;
const REVIEW_NOISE_PATHS = new Set(['next-env.d.ts']);
// o8's own machinery living inside the repo — never part of "your changes".
const REVIEW_NOISE_PREFIXES = ['.cortex-worktrees/'];

function shortenPath(path: string) {
  return path.replace(os.homedir() + '/', '~/');
}

// Cache changed files list for 30 seconds to avoid re-running git commands per file click
let _cachedChangedFiles: ReviewChangedFile[] | null = null;
let _cachedChangedFilesAt = 0;
const CHANGED_FILES_CACHE_TTL_MS = 30_000;

// Full snapshot cache — prevents repeated git/gh spawns from mobile inbox and API routes
const REVIEW_SNAPSHOT_TTL_MS = 20_000;
const _reviewSnapshotCache = new Map<string, { snapshot: WorkflowReviewSnapshot; cachedAt: number }>();
const _reviewSnapshotInflight = new Map<string, Promise<WorkflowReviewSnapshot>>();

export interface WorkspaceReviewSnapshotOptions {
  /** Refresh local Git state; remote metadata keeps its independent quota-safe TTL. */
  fresh?: boolean;
  workspacePath?: string | null;
  repoSlug?: string | null;
  allowFallbackPullRequests?: boolean;
  /**
   * Skip every network `gh` call (PR list, PR files, linked-issue lookups) and
   * return only the local git working-tree data (changedFiles + branch +
   * repoSlug). The Workspace changes view consumes only those fields, so this
   * turns a multi-second cold-network snapshot into a sub-second local-git read
   * on freshly-added repos. See #1340.
   */
  changesOnly?: boolean;
}

export function invalidateReviewSnapshotCache() {
  _reviewSnapshotCache.clear();
  _reviewSnapshotInflight.clear();
}

async function getCachedChangedFiles(): Promise<ReviewChangedFile[]> {
  const now = Date.now();
  if (_cachedChangedFiles && now - _cachedChangedFilesAt < CHANGED_FILES_CACHE_TTL_MS) {
    return _cachedChangedFiles;
  }
  const files = await loadReviewChangedFiles();
  const sorted = await sortChangedFilesByTouchedAt(files);
  _cachedChangedFiles = sorted;
  _cachedChangedFilesAt = now;
  return sorted;
}

function parseJson<T>(raw: string, fallback: T) {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

function normalizeReviewDecision(value?: string | null) {
  if (!value) return null;
  return value.toLowerCase();
}

function parseLinkedIssueNumbers(body: string | undefined, repoSlug: string) {
  if (!body) return [] as number[];

  const seen = new Set<number>();
  const closingReference = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#(\d+)|([\w.-]+\/[\w.-]+)#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))\b/gi;
  for (const match of body.matchAll(closingReference)) {
    const referencedRepo = match[2] ?? match[4];
    if (referencedRepo && referencedRepo.toLowerCase() !== repoSlug.toLowerCase()) continue;
    const nextNumber = Number(match[1] ?? match[3] ?? match[5]);
    if (Number.isSafeInteger(nextNumber) && nextNumber > 0) {
      seen.add(nextNumber);
    }
  }

  return Array.from(seen).sort((left, right) => right - left);
}

interface PullRequestFileSummary {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
  patch?: string;
}

function normalizePullRequestFileStatus(status?: string): ReviewChangedFile['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'added';
    case 'modified':
    default:
      return 'modified';
  }
}

function formatPullRequestFilePath(file: PullRequestFileSummary) {
  return file.status === 'renamed' && file.previous_filename
    ? `${file.previous_filename} → ${file.filename}`
    : file.filename;
}

function parsePullRequestChangedFiles(raw: string) {
  const files = parseJson<PullRequestFileSummary[]>(raw, []);

  return files
    .filter((file) => file.filename && !isReviewNoisePath(file.filename) && !isReviewNoisePath(formatPullRequestFilePath(file)))
    .map((file) => ({
      path: formatPullRequestFilePath(file),
      status: normalizePullRequestFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
    } satisfies ReviewChangedFile))
    .sort((a, b) => ((b.additions ?? 0) + (b.deletions ?? 0)) - ((a.additions ?? 0) + (a.deletions ?? 0)));
}

function summarizePullRequestDiff(files: ReviewChangedFile[]) {
  if (!files.length) {
    return 'No PR file summary is visible yet.';
  }

  return files
    .slice(0, 8)
    .map((file) => `${file.path}  +${file.additions ?? 0}  -${file.deletions ?? 0}`)
    .join('\n');
}

async function loadPullRequestFiles(pullRequestNumber: number) {
  const raw = await tryRunFile('gh', [
    'api',
    `repos/${REVIEW_REPO_SLUG}/pulls/${pullRequestNumber}/files?per_page=100`,
  ]);

  return parseJson<PullRequestFileSummary[]>(raw, []);
}

async function runFile(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, { windowsHide: true,
    cwd: REVIEW_REPO_ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });

  return stdout.trim();
}

async function tryRunFile(command: string, args: string[]) {
  try {
    return await runFile(command, args);
  } catch {
    return '';
  }
}

function parseBranchStatus(raw: string) {
  let branch = 'unknown';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.replace('# branch.head ', '').trim();
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.replace('# branch.upstream ', '').trim();
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+\-(\d+)/);
      if (match) {
        ahead = Number.parseInt(match[1] ?? '0', 10);
        behind = Number.parseInt(match[2] ?? '0', 10);
      }
    }
  }

  return { branch, upstream, ahead, behind };
}

function isReviewNoisePath(path: string) {
  const trimmed = path.trim();
  if (REVIEW_NOISE_PATHS.has(trimmed)) return true;
  return REVIEW_NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function parseChangedFiles(nameStatusRaw: string, numStatRaw: string, untrackedRaw: string, stagedPaths?: Set<string>, unstagedPaths?: Set<string>) {
  const changed = new Map<string, ReviewChangedFile>();

  for (const line of nameStatusRaw.split('\n').filter(Boolean)) {
    const [statusToken, firstPath, secondPath] = line.split('\t');
    if (!statusToken || !firstPath) continue;

    const status = statusToken[0];
    const path = status === 'R' && secondPath ? `${firstPath} → ${secondPath}` : secondPath ?? firstPath;
    if (isReviewNoisePath(firstPath) || (secondPath && isReviewNoisePath(secondPath)) || isReviewNoisePath(path)) {
      continue;
    }

    changed.set(path, {
      path,
      status:
        status === 'A'
          ? 'added'
          : status === 'D'
            ? 'deleted'
            : status === 'R'
              ? 'renamed'
              : 'modified',
      additions: null,
      deletions: null,
    });
  }

  for (const line of numStatRaw.split('\n').filter(Boolean)) {
    const [additionsRaw, deletionsRaw, path] = line.split('\t');
    if (!path || isReviewNoisePath(path)) continue;

    const entry = changed.get(path) ?? {
      path,
      status: 'modified' as const,
      additions: null,
      deletions: null,
    };

    entry.additions = additionsRaw === '-' ? null : Number.parseInt(additionsRaw ?? '0', 10);
    entry.deletions = deletionsRaw === '-' ? null : Number.parseInt(deletionsRaw ?? '0', 10);
    changed.set(path, entry);
  }

  for (const path of untrackedRaw.split('\n').map((value) => value.trim()).filter(Boolean)) {
    if (isReviewNoisePath(path)) continue;

    changed.set(path, {
      path,
      status: 'untracked',
      additions: null,
      deletions: null,
    });
  }

  if (stagedPaths || unstagedPaths) {
    for (const entry of changed.values()) {
      if (entry.status === 'untracked') {
        entry.staged = false;
        entry.unstaged = true;
      } else {
        entry.staged = stagedPaths?.has(entry.path) ?? false;
        entry.unstaged = unstagedPaths?.has(entry.path) ?? false;
      }
    }
  }

  return Array.from(changed.values());
}

/** Path set from a `git diff --name-status` blob, keyed identically to parseChangedFiles. */
function changedPathSet(nameStatusRaw: string): Set<string> {
  const paths = new Set<string>();
  for (const line of nameStatusRaw.split('\n').filter(Boolean)) {
    const [statusToken, firstPath, secondPath] = line.split('\t');
    if (!statusToken || !firstPath) continue;
    const status = statusToken[0];
    paths.add(status === 'R' && secondPath ? `${firstPath} → ${secondPath}` : secondPath ?? firstPath);
  }
  return paths;
}

function parseReviewPath(reviewPath: string) {
  const [originalPath, currentPath] = reviewPath.includes(' → ')
    ? reviewPath.split(' → ')
    : [undefined, reviewPath];

  return {
    originalPath,
    currentPath,
  };
}

function resolveRepoFile(relativePath: string, repoRoot = REVIEW_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const nextPath = path.resolve(resolvedRoot, relativePath);

  if (nextPath !== resolvedRoot && !nextPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Requested review file path escapes the repo root.');
  }

  return nextPath;
}

async function fileTouchedAt(reviewPath: string, repoRoot = REVIEW_REPO_ROOT) {
  try {
    const { currentPath } = parseReviewPath(reviewPath);
    if (!currentPath) {
      return 0;
    }
    const target = resolveRepoFile(currentPath, repoRoot);
    const details = await stat(target);
    return details.mtimeMs;
  } catch {
    return 0;
  }
}

async function sortChangedFilesByTouchedAt(changedFiles: ReviewChangedFile[], repoRoot = REVIEW_REPO_ROOT) {
  const withTouchedAt = await Promise.all(
    changedFiles.map(async (file) => ({
      file,
      touchedAt: await fileTouchedAt(file.path, repoRoot),
    })),
  );

  return withTouchedAt
    .sort((left, right) => {
      if (left.touchedAt !== right.touchedAt) {
        return right.touchedAt - left.touchedAt;
      }
      return left.file.path.localeCompare(right.file.path);
    })
    .map((entry) => entry.file);
}

function summarizeLocalDiff(changedFiles: ReviewChangedFile[], diffStatRaw: string) {
  const untrackedFiles = changedFiles.filter((file) => file.status === 'untracked');
  const trackedSummary = diffStatRaw.trim();

  if (!untrackedFiles.length) {
    return trackedSummary || 'Working tree changed, but git diff --stat returned no visible summary.';
  }

  const lines = trackedSummary ? trackedSummary.split('\n') : [];
  lines.push(`untracked: ${untrackedFiles.length} file${untrackedFiles.length === 1 ? '' : 's'}`);
  lines.push(`total review files: ${changedFiles.length}`);
  return lines.join('\n');
}

function trimPreview(text: string, maxLines = 600, maxChars = 40000) {
  const lines = text.split('\n').slice(0, maxLines).join('\n').trim();
  if (!lines) return '';
  return lines.length > maxChars ? `${lines.slice(0, maxChars - 1)}…` : lines;
}

function buildReviewFileNote(
  file: ReviewChangedFile,
  originalPath?: string,
  currentPath?: string,
  source: 'local' | 'pull_request' = 'local',
) {
  const previewLabel = source === 'pull_request' ? 'the committed PR patch' : 'the current local diff';

  switch (file.status) {
    case 'added':
      return source === 'pull_request'
        ? 'Added file • preview shows the committed PR patch already attached to this branch.'
        : 'Added file • preview shows the current local patch against HEAD.';
    case 'deleted':
      return source === 'pull_request'
        ? 'Deleted file • preview shows the committed PR removal patch from GitHub.'
        : 'Deleted file • preview shows the removal diff still waiting in the working tree.';
    case 'renamed':
      return originalPath && currentPath
        ? `Renamed ${originalPath} → ${currentPath} • preview keeps the rename visible on phone via ${previewLabel}.`
        : `Renamed file • preview keeps the rename visible on phone via ${previewLabel}.`;
    case 'untracked':
      return 'Untracked file • git has no HEAD baseline yet, so the phone shows the current file contents instead of a patch.';
    case 'modified':
    default:
      return source === 'pull_request'
        ? 'Modified file • preview shows the committed PR patch so you can triage after push without dropping to desktop first.'
        : 'Modified file • preview shows the current local diff so you can triage without dropping to desktop first.';
  }
}

async function loadReviewChangedFiles() {
  const [nameStatusRaw, numStatRaw, untrackedRaw] = await Promise.all([
    tryRunFile('git', ['diff', '--name-status', '--relative', '-M', 'HEAD']),
    tryRunFile('git', ['diff', '--numstat', '--relative', '-M', 'HEAD']),
    tryRunFile('git', ['ls-files', '--others', '--exclude-standard']),
  ]);

  return parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw);
}

async function loadFileCommitSummary(filePath: string): Promise<{ commitSummary?: string; commitAuthor?: string; commitAge?: string }> {
  try {
    const raw = await tryRunFile('git', [
      'log', '-1', '--format=%s%n%an%n%ar', '--follow', '--', filePath,
    ]);
    const [subject, author, age] = raw.trim().split('\n');
    if (!subject) return {};
    return {
      commitSummary: subject,
      commitAuthor: author,
      commitAge: age,
    };
  } catch {
    return {};
  }
}

async function loadReviewFilePreview(file: ReviewChangedFile, originalPath?: string, currentPath?: string) {
  if (file.status === 'untracked' && currentPath) {
    const raw = await readFile(resolveRepoFile(currentPath), 'utf8').catch(() => '');
    return { text: trimPreview(raw) || 'No readable file preview is available for this untracked path yet.', kind: 'file' as const };
  }

  const diffTargets = [originalPath, currentPath].filter((value): value is string => Boolean(value));
  const diffPreview = trimPreview(
    await tryRunFile('git', ['diff', '--no-ext-diff', '--unified=16', '--relative', '-M', 'HEAD', '--', ...diffTargets]),
  );

  if (diffPreview) {
    return { text: diffPreview, kind: 'diff' as const };
  }

  if (currentPath && file.status !== 'deleted') {
    const raw = await readFile(resolveRepoFile(currentPath), 'utf8').catch(() => '');
    const filePreview = trimPreview(raw);
    if (filePreview) {
      return { text: filePreview, kind: 'file' as const };
    }
  }

  return { text: 'No inline diff preview is available for this file yet.', kind: 'file' as const };
}

async function loadPullRequestFileDetail(pullRequestNumber: number, reviewPath: string) {
  const files = await loadPullRequestFiles(pullRequestNumber);
  const matched = files.find((file) => formatPullRequestFilePath(file) === reviewPath);

  if (!matched) {
    return null;
  }

  const file: ReviewChangedFile = {
    path: formatPullRequestFilePath(matched),
    status: normalizePullRequestFileStatus(matched.status),
    additions: matched.additions,
    deletions: matched.deletions,
  };
  const { originalPath, currentPath } = parseReviewPath(file.path);

  // Prefer local git diff (full, un-truncated) over GitHub API patch
  const localDiff = trimPreview(
    await tryRunFile('git', ['diff', '--no-ext-diff', '--unified=4', 'origin/main...HEAD', '--', ...[originalPath, currentPath].filter((v): v is string => Boolean(v))]),
  );
  const preview = localDiff || trimPreview(matched.patch ?? '') || 'GitHub did not return an inline patch for this file.';
  const commitInfo = await loadFileCommitSummary(currentPath ?? originalPath ?? file.path);

  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    originalPath,
    currentPath,
    note: buildReviewFileNote(file, originalPath, currentPath, 'pull_request'),
    preview,
    previewKind: 'diff',
    ...commitInfo,
  } satisfies MobileReviewFileDetail;
}


export async function getReviewFileDetail(reviewPath: string): Promise<MobileReviewFileDetail> {
  const changedFiles = await getCachedChangedFiles();
  const file = changedFiles.find((entry) => entry.path === reviewPath);

  if (file) {
    const { originalPath, currentPath } = parseReviewPath(file.path);
    const [preview, commitInfo] = await Promise.all([
      loadReviewFilePreview(file, originalPath, currentPath),
      loadFileCommitSummary(currentPath ?? originalPath ?? file.path),
    ]);

    return {
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      originalPath,
      currentPath,
      note: buildReviewFileNote(file, originalPath, currentPath),
      preview: preview.text,
      previewKind: preview.kind,
      ...commitInfo,
    };
  }

  const snapshot = await getWorkspaceReviewSnapshot();
  const leadPullRequest = snapshot.pullRequests[0];

  if (leadPullRequest) {
    const committedFile = await loadPullRequestFileDetail(leadPullRequest.number, reviewPath);
    if (committedFile) {
      return committedFile;
    }
  }

  throw new Error('Requested file is no longer part of the live review surface.');
}

function reviewSnapshotCacheKey(options: WorkspaceReviewSnapshotOptions) {
  return [
    path.resolve(options.workspacePath || REVIEW_REPO_ROOT),
    options.repoSlug || REVIEW_REPO_SLUG || '',
    options.allowFallbackPullRequests === false ? 'strict' : 'fallback',
    options.changesOnly ? 'changes-only' : 'full',
  ].join('::');
}

export async function getWorkspaceReviewSnapshot(options: WorkspaceReviewSnapshotOptions = {}): Promise<WorkflowReviewSnapshot> {
  const fresh = options.fresh ?? false;
  const cacheKey = reviewSnapshotCacheKey(options);
  const now = Date.now();
  const cached = _reviewSnapshotCache.get(cacheKey);
  if (!fresh && cached && now - cached.cachedAt < REVIEW_SNAPSHOT_TTL_MS) {
    return cached.snapshot;
  }
  if (!fresh) {
    const inflight = _reviewSnapshotInflight.get(cacheKey);
    if (inflight) return inflight;
  }

  const request = _fetchWorkspaceReviewSnapshot(options).then((snapshot) => {
    _reviewSnapshotCache.set(cacheKey, { snapshot, cachedAt: Date.now() });
    return snapshot;
  }).finally(() => {
    _reviewSnapshotInflight.delete(cacheKey);
  });

  _reviewSnapshotInflight.set(cacheKey, request);
  return request;
}

async function _fetchWorkspaceReviewSnapshot(options: WorkspaceReviewSnapshotOptions = {}): Promise<WorkflowReviewSnapshot> {
  const repoRoot = path.resolve(options.workspacePath || REVIEW_REPO_ROOT);
  // No explicit workspace + the default root isn't a repo (packaged-app cwd) →
  // return an empty snapshot instantly instead of git-walking the app bundle.
  if (!options.workspacePath && !defaultReviewRootIsRepo()) {
    return {
      generatedAt: new Date().toISOString(),
      repoSlug: REVIEW_REPO_SLUG,
      repoPath: shortenPath(repoRoot),
      branch: '',
      headSha: undefined,
      upstream: undefined,
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: [],
      diffStat: '',
      recentCommits: [],
      worktrees: [],
      pullRequests: [],
      activeIssue: undefined,
      activeIssues: [],
      warnings: [],
    };
  }
  const allowFallbackPullRequests = options.allowFallbackPullRequests !== false;
  const changesOnly = options.changesOnly === true;
  const startedAt = Date.now();
  const warnings: string[] = [];

  const { runInContext, tryRunInContext } = createWorkspaceReviewCommands(repoRoot, warnings);

  await assertReviewWorkspace(repoRoot, runInContext);
  const requiredGit = (args: string[]) => requireReviewGit(runInContext, args);
  const remoteUrl = options.repoSlug ? null : await tryRunInContext('git', ['remote', 'get-url', 'origin']);
  const repoSlug = options.repoSlug || normalizeRepoSlug(remoteUrl) || REVIEW_REPO_SLUG;

  const branchStatusRaw = await requiredGit(['status', '--branch', '--porcelain=v2']);
  const { branch, upstream, ahead, behind } = parseBranchStatus(branchStatusRaw);
  const initial = branchStatusRaw.includes('# branch.oid (initial)');
  const diffBase = [initial ? await requiredGit(['hash-object', '-t', 'tree', os.devNull]) : 'HEAD'];

  const [
    nameStatusRaw,
    numStatRaw,
    untrackedRaw,
    diffStatRaw,
    recentCommitsRaw,
    headShaRaw,
    worktreesRaw,
    branchPrsRaw,
    fallbackPrsRaw,
    stagedNameStatusRaw,
    unstagedNameStatusRaw,
  ] = await Promise.all([
    requiredGit(['diff', '--name-status', '--relative', '-M', ...diffBase]),
    requiredGit(['diff', '--numstat', '--relative', '-M', ...diffBase]),
    requiredGit(['ls-files', '--others', '--exclude-standard']),
    requiredGit(['diff', '--stat=120', '--relative', ...diffBase]),
    tryRunInContext('git', ['log', '--format=%H%x09%h%x09%s', '-8']),
    tryRunInContext('git', ['rev-parse', 'HEAD']),
    tryRunInContext('git', ['worktree', 'list', '--porcelain']),
    repoSlug && !changesOnly
      ? tryRunInContext('gh', [
          'pr',
          'list',
          '--repo',
          repoSlug,
          '--state',
          'open',
          '--head',
          branch,
          '--json',
          'number,title,url,headRefName,baseRefName,isDraft,reviewDecision,state,body',
        ])
      : Promise.resolve(''),
    repoSlug && allowFallbackPullRequests && !changesOnly
      ? tryRunInContext('gh', [
          'pr',
          'list',
          '--repo',
          repoSlug,
          '--state',
          'open',
          '--limit',
          '6',
          '--json',
          'number,title,url,headRefName,baseRefName,isDraft,reviewDecision,state,body',
        ])
      : Promise.resolve(''),
    requiredGit(['diff', '--name-status', '--cached', '--relative', '-M', ...(initial ? [] : ['HEAD'])]),
    requiredGit(['diff', '--name-status', '--relative', '-M']),
  ]);

  const stagedPaths = changedPathSet(stagedNameStatusRaw);
  const unstagedPaths = changedPathSet(unstagedNameStatusRaw);
  const parsedFiles = parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw, stagedPaths, unstagedPaths);
  const localChangedFiles = await sortChangedFilesByTouchedAt(parsedFiles, repoRoot);
  _cachedChangedFiles = localChangedFiles;
  _cachedChangedFilesAt = Date.now();
  const recentCommits = recentCommitsRaw ? parseRecentCommits(recentCommitsRaw) : [];
  const worktrees = parseWorktrees(worktreesRaw, repoRoot);

  const branchPullRequests = parseJson<ReviewPullRequestSummary[]>(branchPrsRaw, []);
  const fallbackPullRequests = parseJson<ReviewPullRequestSummary[]>(fallbackPrsRaw, []);
  const selectedPullRequests = branchPullRequests.length
    ? branchPullRequests
    : allowFallbackPullRequests
      ? fallbackPullRequests
      : [];

  const pullRequests = selectedPullRequests.map((pullRequest) => ({
    ...pullRequest,
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
    // Fallback PRs are display context, never the current branch's issue scope.
    linkedIssueNumbers: branchPullRequests.length ? parseLinkedIssueNumbers(pullRequest.body, repoSlug) : [],
  }));

  const pullRequestFiles = pullRequests[0] && repoSlug && !changesOnly
    ? parseJson<PullRequestFileSummary[]>(
        await tryRunInContext('gh', [
          'api',
          `repos/${repoSlug}/pulls/${pullRequests[0].number}/files?per_page=100`,
        ]),
        [],
      )
    : [];
  const pullRequestChangedFiles = pullRequestFiles.length
    ? parsePullRequestChangedFiles(JSON.stringify(pullRequestFiles))
    : [];
  const changedFiles = localChangedFiles.length ? localChangedFiles : pullRequestChangedFiles;
  const diffStat = localChangedFiles.length
    ? summarizeLocalDiff(localChangedFiles, diffStatRaw)
    : pullRequestChangedFiles.length
      ? summarizePullRequestDiff(pullRequestChangedFiles)
      : 'Working tree clean.';

  const linkedIssueNumbers = [...new Set(pullRequests.flatMap((pullRequest) => pullRequest.linkedIssueNumbers ?? []))]
    .slice(0, MAX_LINKED_ISSUE_LOOKUPS);
  const activeIssues = repoSlug && !changesOnly
    ? (await Promise.all(
        linkedIssueNumbers.map(async (issueNumber) => {
          const raw = await tryRunInContext('gh', [
            'issue',
            'view',
            String(issueNumber),
            '--repo',
            repoSlug,
            '--json',
            'number,title,url,state',
          ]);
          return parseJson<ReviewIssueSummary | undefined>(raw, undefined);
        }),
      )).filter((issue): issue is ReviewIssueSummary => Boolean(issue))
    : [];
  const activeIssue = activeIssues[0];

  if (!changesOnly && repoSlug && !activeIssues.length) {
    if (linkedIssueNumbers.length) {
      warnings.push('Unable to load the linked GitHub issues for the current review lane.');
    }
  }

  if (!changesOnly && !pullRequests.length) {
    warnings.push('No open GitHub pull request is attached to the current branch yet.');
  }

  if (!worktrees.length) {
    warnings.push('No git worktree data was found.');
  }

  console.log(
    `[workspace-perf] snapshot ${changesOnly ? 'changes-only' : 'full'} repo=${repoSlug || repoRoot} files=${changedFiles.length} in ${Date.now() - startedAt}ms`,
  );

  return {
    generatedAt: new Date().toISOString(),
    repoSlug,
    repoPath: shortenPath(repoRoot),
    branch,
    headSha: headShaRaw || undefined,
    upstream,
    ahead,
    behind,
    dirty: localChangedFiles.length > 0,
    changedFiles,
    diffStat,
    recentCommits,
    worktrees,
    pullRequests,
    activeIssue,
    activeIssues,
    warnings,
  };
}
