import 'server-only';

import { execFileSync } from '@/lib/providers/child-process';
import { homedir } from 'node:os';
import { assertReviewWorkspace, WorkspaceReviewError } from '@/lib/review/workspace-status';

const DEFAULT_REPO_ROOT = process.env.CORTEX_IDE_REPO || process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
const COMMIT_RECORD_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';
const STAT_SEPARATOR = '\u001d';
const MAX_GIT_BUFFER = 4 * 1024 * 1024;
const MAX_FILE_DIFF_LENGTH = 40_000;

export type PanelCommitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

export interface PanelCommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  additions: number;
  deletions: number;
}

export interface PanelCommitDiffFile {
  path: string;
  previousPath: string | null;
  status: PanelCommitFileStatus;
  additions: number;
  deletions: number;
  diff: string;
}

export function isValidCommitHash(value: string) {
  return /^[a-f0-9]{7,40}$/i.test(value.trim());
}

export function resolvePanelWorkspaceRoot(workspace?: string | null) {
  if (!workspace) return DEFAULT_REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

export function resolveWorkspaceRoot(workspace?: string | null) {
  return resolvePanelWorkspaceRoot(workspace);
}

function runGit(root: string, args: string[], maxBuffer = MAX_GIT_BUFFER) {
  return execFileSync('git', args, {
    windowsHide: true,
    cwd: root,
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer,
  });
}

function isGitRepo(root: string) {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      windowsHide: true,
      cwd: root,
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    }).trim() === 'true';
  } catch {
    return false;
  }
}

function parseCount(value: string | undefined) {
  if (value === '-') return 0;
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapStatus(code: string | undefined): PanelCommitFileStatus {
  const prefix = code?.charAt(0) ?? '';
  switch (prefix) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'M':
      return 'modified';
    default:
      return 'unknown';
  }
}

function truncateDiff(diff: string) {
  if (diff.length <= MAX_FILE_DIFF_LENGTH) return diff;
  return `${diff.slice(0, MAX_FILE_DIFF_LENGTH)}\n\n... (truncated at 40KB)`;
}

function normalizePatchLines(lines: string[]) {
  const visibleLines = lines.filter((line) => (
    !line.startsWith('diff --git ')
    && !line.startsWith('index ')
    && !line.startsWith('old mode ')
    && !line.startsWith('new mode ')
    && !line.startsWith('new file mode ')
    && !line.startsWith('deleted file mode ')
    && !line.startsWith('similarity index ')
    && !line.startsWith('rename from ')
    && !line.startsWith('rename to ')
  ));

  const patch = visibleLines.join('\n').trim();
  if (patch) return truncateDiff(patch);
  return 'No diff available';
}

function parsePatchSections(rawPatch: string) {
  const sections: Array<{ path: string; previousPath: string | null; diff: string }> = [];
  const normalized = rawPatch.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) {
        sections.push(buildPatchSection(current));
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    sections.push(buildPatchSection(current));
  }

  return sections.filter((section) => section.path);
}

function buildPatchSection(lines: string[]) {
  const header = lines[0] ?? '';
  const headerMatch = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  let previousPath = headerMatch?.[1] ?? null;
  let nextPath = headerMatch?.[2] ?? previousPath;

  for (const line of lines.slice(1)) {
    if (line.startsWith('rename from ')) {
      previousPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      nextPath = line.slice('rename to '.length);
      continue;
    }
    if (line === '--- /dev/null') {
      previousPath = null;
      continue;
    }
    if (line.startsWith('--- a/')) {
      previousPath = line.slice(6);
      continue;
    }
    if (line === '+++ /dev/null') {
      nextPath = null;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      nextPath = line.slice(6);
    }
  }

  return {
    path: nextPath ?? previousPath ?? '',
    previousPath,
    diff: normalizePatchLines(lines.slice(1)),
  };
}

export async function getRecentWorkspaceCommits(root: string, limit = 20) {
  const resolvedRoot = resolvePanelWorkspaceRoot(root);
  await assertReviewWorkspace(resolvedRoot, async (_command, args) => runGit(resolvedRoot, args).trim());

  const safeLimit = Math.max(1, Math.min(limit, 30));
  let output: string;
  try {
    output = runGit(
      resolvedRoot,
      [
        'log',
        `--max-count=${safeLimit}`,
        '--date=iso-strict',
        `--format=${COMMIT_RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%B${STAT_SEPARATOR}`,
        '--numstat',
      ],
    );
  } catch (error) {
    // An unborn branch is a valid repository with no history. Other failures
    // must stay visible instead of becoming an empty successful activity feed.
    if (/does not have any commits yet/i.test(String((error as { stderr?: string }).stderr ?? ''))) return [];
    throw new WorkspaceReviewError('REVIEW_GIT_UNAVAILABLE', 'Git could not read local commit activity. Check Git and repository access, then retry.', 503);
  }

  return output
    .split(COMMIT_RECORD_SEPARATOR)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk): PanelCommitSummary => {
      const [rawHeader, rawStats = ''] = chunk.split(STAT_SEPARATOR);
      const [sha = '', author = '', date = '', ...messageParts] = rawHeader.split(FIELD_SEPARATOR);
      const message = messageParts.join(FIELD_SEPARATOR).trim();
      const messageLines = message.split('\n');
      const subject = messageLines.find((line) => line.trim().length > 0) ?? '';
      const body = messageLines.slice(1).join('\n').trim();

      let additions = 0;
      let deletions = 0;
      for (const line of rawStats.split('\n')) {
        const [additionsRaw, deletionsRaw] = line.trim().split('\t');
        if (typeof additionsRaw !== 'string' || typeof deletionsRaw !== 'string') continue;
        additions += parseCount(additionsRaw);
        deletions += parseCount(deletionsRaw);
      }

      return {
        sha,
        shortSha: sha.slice(0, 7),
        message,
        subject,
        body,
        author: author.trim(),
        date: date.trim(),
        additions,
        deletions,
      };
    });
}

export function getWorkspaceCommitDiffFiles(root: string, sha: string) {
  const resolvedRoot = resolvePanelWorkspaceRoot(root);
  if (!isGitRepo(resolvedRoot)) return [];

  const numstatOutput = runGit(resolvedRoot, ['diff-tree', '--no-commit-id', '--numstat', '-r', '-M', sha]);
  const statusOutput = runGit(resolvedRoot, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', sha]);
  const rawPatch = runGit(
    resolvedRoot,
    ['show', '--format=', '--patch', '--find-renames', '--unified=3', sha],
    MAX_GIT_BUFFER,
  );

  const statusByPath = new Map<string, { status: PanelCommitFileStatus; previousPath: string | null }>();
  for (const line of statusOutput.split('\n').filter(Boolean)) {
    const [statusCode = '', firstPath = '', secondPath = ''] = line.split('\t');
    const currentPath = secondPath || firstPath;
    if (!currentPath) continue;
    statusByPath.set(currentPath, {
      status: mapStatus(statusCode),
      previousPath: secondPath ? firstPath : null,
    });
  }

  const patchByPath = new Map<string, { diff: string; previousPath: string | null }>();
  for (const section of parsePatchSections(rawPatch)) {
    patchByPath.set(section.path, { diff: section.diff, previousPath: section.previousPath });
    if (section.previousPath && section.previousPath !== section.path) {
      patchByPath.set(section.previousPath, { diff: section.diff, previousPath: section.previousPath });
    }
  }

  return numstatOutput
    .split('\n')
    .filter(Boolean)
    .map((line): PanelCommitDiffFile | null => {
      const [additionsRaw = '0', deletionsRaw = '0', firstPath = '', secondPath = ''] = line.split('\t');
      const path = secondPath || firstPath;
      const previousPath = secondPath ? firstPath : null;
      if (!path) return null;

      const statusEntry = statusByPath.get(path) ?? (previousPath ? statusByPath.get(previousPath) : undefined);
      const patchEntry = patchByPath.get(path) ?? (previousPath ? patchByPath.get(previousPath) : undefined);

      return {
        path,
        previousPath: previousPath ?? statusEntry?.previousPath ?? patchEntry?.previousPath ?? null,
        status: statusEntry?.status ?? 'unknown',
        additions: parseCount(additionsRaw),
        deletions: parseCount(deletionsRaw),
        diff: patchEntry?.diff ?? 'No diff available',
      };
    })
    .filter((file): file is PanelCommitDiffFile => file !== null);
}

export function getLocalCommitDetail(sha: string, workspace?: string | null) {
  const root = resolvePanelWorkspaceRoot(workspace);
  const meta = runGit(root, ['log', '-1', '--format=%H%n%s%n%an%n%ae%n%aI%n%b', sha]).trim();
  const [fullHash = sha, subject = '', authorName = '', authorEmail = '', dateISO = '', ...bodyLines] = meta.split('\n');
  const body = bodyLines.join('\n').trim();
  const commitDiffFiles = getWorkspaceCommitDiffFiles(root, sha);
  const files = commitDiffFiles.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    status: file.status,
    previousPath: file.previousPath,
  }));
  const stat = runGit(root, ['diff-tree', '--no-commit-id', '--stat', sha]).trim();
  const totalAdditions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  let diff = '(diff too large or unavailable)';

  try {
    const rawDiff = runGit(root, ['diff-tree', '-p', '--no-commit-id', sha]);
    diff = rawDiff.length > 50_000
      ? `${rawDiff.slice(0, 50_000)}\n\n... (truncated at 50KB)`
      : rawDiff;
  } catch {
    diff = '(diff too large or unavailable)';
  }

  return {
    hash: fullHash,
    shortHash: fullHash.slice(0, 7),
    subject,
    body,
    author: authorName,
    email: authorEmail,
    date: dateISO,
    files,
    totalAdditions,
    totalDeletions,
    stat,
    diff,
  };
}
