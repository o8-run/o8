export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFileSync } from '@/lib/providers/child-process';
import os from 'node:os';
import path from 'node:path';
import { fetchGitHubPullRequestSummaries, normalizeRepoSlug } from '@/lib/github-broker';
import { listRepos } from '@/lib/repos/registry';
import { getRepoReadiness } from '@/lib/repos/readiness';
import type { RepoReadiness } from '@/lib/repos/types';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import {
  buildWorkspaceLifecycleId,
  mutateWorkspaceLifecycleRecord,
  syncWorkspaceLifecycleRecords,
  type LiveWorkspaceLifecycleInput,
} from '@/lib/workspace/lifecycle';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import { deriveWorkflowStage, type WorkflowStageBadge } from '@/lib/workflows/status';
import { selectWorkspaceReadinessRepos } from './readiness-scope';
import { readLocalDiffStats, type DiffStats } from './diff-stats';

const prCache = new Map<string, { prs: PRData[]; ts: number }>();
const PR_CACHE_TTL_MS = 60_000;
const branchCache = new Map<string, { branch: string; ts: number }>();
const BRANCH_CACHE_TTL = 10_000;
interface PRData {
  number: number;
  title: string;
  state: string;
  author: { login: string } | null;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt?: string | null;
  url: string;
}

interface WorkspaceEntry {
  id: string;
  workspaceId: string;
  agentName: string;
  agentStatus: string;
  sessionKey: string;
  workspace: string;
  workspacePath: string;
  repoPath: string;
  branch: string;
  repo: string;
  runtime?: string;
  currentTask?: string;
  localDiff?: { additions: number; deletions: number; changedFiles: number };
  pr: {
    number: number;
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    state: 'open' | 'merged' | 'closed';
    url: string;
  } | null;
  status: 'in_progress' | 'in_review' | 'done' | 'idle' | 'cancelled';
  stale?: boolean;
  readiness?: RepoReadiness;
  workflowStage?: WorkflowStageBadge | null;
  lifecycle?: WorkspaceLifecycleRecordView;
}

function shortenHomePath(filePath: string) {
  return filePath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function normalizeScopePath(filePath?: string | null) {
  const trimmed = filePath?.trim();
  if (!trimmed) return null;
  return resolveWorkspacePath(trimmed).replace(/\/+$/, '');
}

function pathBelongsToRegisteredRepo(candidatePath: string | null | undefined, repoRoots: Set<string>) {
  const normalizedCandidate = normalizeScopePath(candidatePath);
  if (!normalizedCandidate) return false;
  for (const repoRoot of repoRoots) {
    if (normalizedCandidate === repoRoot || normalizedCandidate.startsWith(`${repoRoot}/`)) {
      return true;
    }
  }
  return false;
}

function buildLifecycleSummary(records: WorkspaceLifecycleRecordView[]): WorkspaceLifecycleSummaryView {
  const active = records.filter((record) => !record.archivedAt);
  const nextAttention = active
    .filter((record) => record.attentionRank > 0)
    .sort((left, right) => right.attentionRank - left.attentionRank)[0];
  return {
    unreadCount: active.reduce((sum, record) => sum + record.unreadCount, 0),
    archivedCount: records.filter((record) => Boolean(record.archivedAt)).length,
    nextAttentionWorkspaceId: nextAttention?.id ?? null,
  };
}

function resolveWorkspacePath(workspace: string) {
  return workspace.replace(/^~/, process.env.HOME || os.homedir());
}

function deriveRepoFromWorkspace(workspace: string) {
  const filePath = workspace.replace(/^~\//, '');
  if (filePath.includes('/.cortex-worktrees/')) {
    const repoRoot = filePath.split('/.cortex-worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || '';
  }
  if (filePath.includes('/.claude/worktrees/')) {
    const repoRoot = filePath.split('/.claude/worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || '';
  }
  if (filePath.includes('repos/')) {
    const parts = filePath.split('repos/');
    return parts[1]?.split('/')[0] || '';
  }
  if (filePath.includes('projects/')) {
    const parts = filePath.split('projects/');
    return parts[1]?.split('/')[0] || '';
  }
  return '';
}

function deriveRepoRootPath(workspace: string) {
  const resolved = resolveWorkspacePath(workspace);
  if (resolved.includes('/.cortex-worktrees/')) {
    return resolved.split('/.cortex-worktrees/')[0] ?? resolved;
  }
  if (resolved.includes('/.claude/worktrees/')) {
    return resolved.split('/.claude/worktrees/')[0] ?? resolved;
  }
  return resolved;
}

function getAgentActiveRepo(sessionKey: string): { repo: string; path: string } | null {
  const workspaceRoot = process.env.CORTEX_IDE_WORKSPACE_ROOT || process.cwd();
  const map: Record<string, { repo: string; path: string }> = {
    'agent:main:main': { repo: path.basename(workspaceRoot), path: workspaceRoot },
  };
  return map[sessionKey] || null;
}

function resolveGitBranch(repoPath: string) {
  const now = Date.now();
  const cached = branchCache.get(repoPath);
  if (cached && now - cached.ts < BRANCH_CACHE_TTL) return cached.branch;

  try {
    const resolved = resolveWorkspacePath(repoPath);
    const branch = execFileSync('git', ['-C', resolved, 'branch', '--show-current'], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'main';
    branchCache.set(repoPath, { branch, ts: now });
    return branch;
  } catch {
    return 'main';
  }
}

// Cache of active git worktree branches per repo, used to filter ghost
// codex sessions whose worktree has been removed. Parses `git worktree list
// --porcelain` and returns the set of branch names currently attached to a
// real worktree directory.
const worktreeBranchCache = new Map<string, { branches: Set<string>; ts: number }>();
const WORKTREE_BRANCH_CACHE_TTL = 10_000;

function getActiveWorktreeBranches(repoPath: string): Set<string> {
  const now = Date.now();
  const cached = worktreeBranchCache.get(repoPath);
  if (cached && now - cached.ts < WORKTREE_BRANCH_CACHE_TTL) return cached.branches;

  const branches = new Set<string>();
  try {
    const resolved = resolveWorkspacePath(repoPath);
    const output = execFileSync('git', ['-C', resolved, 'worktree', 'list', '--porcelain'], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Parser: entries are separated by blank lines. Each entry has `worktree
    // <path>` and optionally `branch refs/heads/<name>`. Detached worktrees
    // have `detached` instead of `branch` — we skip those (no branch to
    // match against an agent's branch field).
    for (const block of output.split(/\n\n+/)) {
      for (const line of block.split('\n')) {
        if (line.startsWith('branch refs/heads/')) {
          branches.add(line.slice('branch refs/heads/'.length).trim());
        }
      }
    }
  } catch {
    // If git fails, fall back to permissive (empty set would drop every
    // non-main session including legitimate ones, so return the repo's
    // current branch to avoid false negatives).
    branches.add(resolveGitBranch(repoPath));
  }

  worktreeBranchCache.set(repoPath, { branches, ts: now });
  return branches;
}

function getLocalDiffStats(workspace: string): Promise<DiffStats | null> {
  const isDefault = workspace === 'unknown';
  try {
    const cwd = isDefault
      ? (process.env.CORTEX_IDE_WORKSPACE_ROOT || process.cwd())
      : resolveWorkspacePath(workspace);
    return readLocalDiffStats(cwd, isDefault);
  } catch {
    return Promise.resolve(null);
  }
}

function isStaleWorkspace(status: string, lastEventAt?: string): boolean {
  if (status !== 'idle') return false;
  if (!lastEventAt) return false;
  const hourMatch = lastEventAt.match(/^(\d+)h/);
  if (hourMatch && parseInt(hourMatch[1], 10) >= 2) return true;
  if (/^\d+d/.test(lastEventAt)) return true;
  return false;
}

function deriveWorkspaceStatus(params: {
  runtimeStatus: string;
  pr: PRData | null;
}): WorkspaceEntry['status'] {
  if (params.pr?.mergedAt) return 'done';
  if (params.pr?.state.toLowerCase() === 'closed') return 'cancelled';
  if (params.pr?.state.toLowerCase() === 'open') return 'in_review';
  if (params.runtimeStatus === 'running' || params.runtimeStatus === 'reviewing' || params.runtimeStatus === 'waiting') {
    return 'in_progress';
  }
  return 'idle';
}

function isVisibleWorkspaceAgent(agent: Awaited<ReturnType<typeof getRuntimeInventorySnapshot>>['agents'][number]) {
  if (agent.runtime !== 'codex' && agent.runtime !== 'claude-code') {
    return false;
  }

  const ownership = agent.runtimeSurface?.ownership ?? null;
  if (ownership === 'owned') {
    return true;
  }

  if (ownership === 'discovered') {
    return agent.status === 'running'
      || Boolean(agent.runtimeSurface?.capabilities.interrupt)
      || /live pid/i.test(agent.runtimeSurface?.sourceLabel ?? '');
  }

  return ['running', 'reviewing', 'waiting'].includes(agent.status);
}

async function collectWorkspaceLifecycle() {
  const [runtimeSnapshot, registeredRepos] = await Promise.all([
    getRuntimeInventorySnapshot(),
    listRepos().catch(() => []),
  ]);

  const repoSlugByName = new Map<string, string>();
  const repoReadinessByName = new Map<string, RepoReadiness>();
  const registeredRepoPaths = new Set(registeredRepos.map((entry) => normalizeScopePath(entry.localPath)).filter((value): value is string => Boolean(value)));
  for (const entry of registeredRepos) {
    const slug = normalizeRepoSlug(entry.remoteUrl);
    if (slug) repoSlugByName.set(entry.name, slug);
  }

  const fallbackSlugMap: Record<string, string> = {
    'cortex': 'hurttlocker/cortex',
    'parasite-network': 'hurttlocker/parasite-network',
    'spear-production': 'LavonTMCQ/spear-production',
    'mybeautifulwife': 'LavonTMCQ/mybeautifulwife',
  };

  const liveAgents = runtimeSnapshot.agents
    .filter((agent) => isVisibleWorkspaceAgent(agent));

  const repoSet = new Set<string>();
  const preparedAgents = liveAgents.map((agent) => {
    const activeRepo = getAgentActiveRepo(agent.sessionKey);
    const workspacePath = activeRepo?.path
      ?? resolveWorkspacePath(agent.runtimeSurface?.cwd ?? agent.workspace);
    const repoPath = activeRepo?.path ?? deriveRepoRootPath(workspacePath);
    const repoSlug = agent.runtimeSurface?.reviewContext?.repoSlug?.trim() || null;
    let repoName = repoSlug?.split('/').pop()?.trim()
      || deriveRepoFromWorkspace(workspacePath)
      || (agent.workspace === 'unknown' ? 'workspace' : '');
    if (activeRepo && (!repoName || repoName === 'workspace')) {
      repoName = activeRepo.repo;
    }
    const branchName = activeRepo
      ? resolveGitBranch(activeRepo.path)
      : agent.runtimeSurface?.branch?.replace(/^surface\//, '') || agent.branch.replace(/^surface\//, '');
    return {
      agent,
      repoName,
      repoPath,
      workspacePath,
      repoSlug,
      branchName,
    };
  }).filter((prepared) => pathBelongsToRegisteredRepo(prepared.repoPath, registeredRepoPaths))
    .filter((prepared) => !prepared.branchName.startsWith('worktree-you-are-the-orchestrator-'))
    .filter((prepared) => {
      // Drop ghost workspace entries whose git worktree no longer exists.
      // Owned codex sessions survive lane archival and worktree removal
      // because codex keeps its own session registry — they'd otherwise
      // linger in the left sidebar forever with status='reviewing', burying
      // real work under stale cards. Check against the live `git worktree
      // list` set: if the agent's branch is `main` or a branch that git
      // still tracks as an active worktree, it's real; otherwise the
      // worktree has been removed and the session is a ghost.
      const branch = prepared.branchName;
      if (!branch || branch === 'main') return true;
      const activeBranches = getActiveWorktreeBranches(prepared.repoPath);
      return activeBranches.has(branch);
    });

  for (const prepared of preparedAgents) repoSet.add(prepared.repoName);

  const readinessTargets = selectWorkspaceReadinessRepos({
    registeredRepos,
    workspaces: preparedAgents.map((prepared) => ({
      repoName: prepared.repoName,
      repoPath: prepared.repoPath,
    })),
  });
  await Promise.all(readinessTargets.map(async ({ repo, repoNames }) => {
    try {
      const readiness = await getRepoReadiness(repo);
      for (const repoName of repoNames) repoReadinessByName.set(repoName, readiness);
    } catch {
      // Keep readiness optional if git/fs checks fail.
    }
  }));

  const prsByBranch = new Map<string, PRData & { ghRepo: string }>();
  for (const repoName of repoSet) {
    const ghRepo = repoSlugByName.get(repoName) ?? fallbackSlugMap[repoName] ?? '';
    if (!ghRepo) continue;

    try {
      const cached = prCache.get(ghRepo);
      let prs: PRData[];
      if (cached && (Date.now() - cached.ts) < PR_CACHE_TTL_MS) {
        prs = cached.prs;
      } else {
        prs = await fetchGitHubPullRequestSummaries(ghRepo, {
          states: ['open', 'closed'],
          limitPerState: 20,
        }) as PRData[];
        prCache.set(ghRepo, { prs, ts: Date.now() });
      }
      for (const pr of prs) {
        prsByBranch.set(`${repoName}:${pr.headRefName}`, { ...pr, ghRepo });
      }
    } catch {
      // Repo may not have PRs.
    }
  }

  // Read every workspace's local diff concurrently, off the event loop.
  const localDiffs = await Promise.all(preparedAgents.map(({ repoName, branchName, workspacePath }) => (
    repoName && repoName !== 'workspace' && !prsByBranch.get(`${repoName}:${branchName}`)
      ? getLocalDiffStats(workspacePath)
      : Promise.resolve(null)
  )));
  const workspaces: WorkspaceEntry[] = [];
  const liveLifecycleInputs: LiveWorkspaceLifecycleInput[] = [];

  for (const [preparedIndex, prepared] of preparedAgents.entries()) {
    const { agent, repoName, repoPath, workspacePath, repoSlug, branchName } = prepared;
    if (!repoName) continue;
    const pr = prsByBranch.get(`${repoName}:${branchName}`) || null;
    const status = deriveWorkspaceStatus({ runtimeStatus: agent.status, pr });
    const localDiff = localDiffs[preparedIndex];
    const ghRepo = repoSlugByName.get(repoName) ?? fallbackSlugMap[repoName] ?? '';
    const workflowStage = deriveWorkflowStage({
      runtimeStatus: agent.status,
      workspaceStatus: status === 'in_review' ? 'in_review' : status === 'done' ? 'done' : null,
      readinessState: repoReadinessByName.get(repoName)?.state ?? null,
      prState: pr?.mergedAt ? 'merged' : pr?.state ?? null,
      hasMessages: Boolean(agent.currentTask?.trim()),
      latestText: agent.currentTask ?? agent.runtimeSurface?.lifecycle?.summary ?? '',
    });
    const workspaceId = buildWorkspaceLifecycleId({
      repoPath,
      workspacePath,
      branch: branchName,
    });

    workspaces.push({
      id: agent.sessionKey || agent.name,
      workspaceId,
      agentName: agent.name,
      agentStatus: agent.status,
      sessionKey: agent.sessionKey,
      workspace: shortenHomePath(workspacePath),
      workspacePath,
      repoPath,
      branch: branchName,
      repo: repoName,
      runtime: agent.runtime,
      currentTask: agent.currentTask,
      localDiff: localDiff ?? undefined,
      pr: pr ? {
        number: pr.number,
        title: pr.title,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        state: pr.mergedAt ? 'merged' : pr.state.toLowerCase() === 'closed' ? 'closed' : 'open',
        url: pr.url || `https://github.com/${ghRepo}/pull/${pr.number}`,
      } : null,
      status,
      stale: isStaleWorkspace(status, agent.lastEventAt),
      readiness: repoReadinessByName.get(repoName),
      workflowStage,
    });

    liveLifecycleInputs.push({
      id: workspaceId,
      repo: repoName,
      repoPath,
      workspacePath,
      branch: branchName,
      repoSlug,
      sessionKey: agent.sessionKey,
      runtime: agent.runtime,
      agentName: agent.name,
      agentStatus: agent.status,
      currentTask: agent.currentTask,
      workspaceStatus: status,
      workflowStage,
    });
  }

  const lifecycle = syncWorkspaceLifecycleRecords(liveLifecycleInputs);
  const filteredLifecycleRecords = lifecycle.records.filter((record) => (
    pathBelongsToRegisteredRepo(record.repoPath, registeredRepoPaths)
    || pathBelongsToRegisteredRepo(record.workspacePath, registeredRepoPaths)
  ));
  const lifecycleById = new Map(filteredLifecycleRecords.map((record) => [record.id, record]));
  const enrichedWorkspaces = workspaces.map((workspace) => ({
    ...workspace,
    lifecycle: lifecycleById.get(workspace.workspaceId),
  }));

  return {
    workspaces: enrichedWorkspaces,
    repos: Array.from(repoSet),
    lifecycle: {
      records: filteredLifecycleRecords,
      summary: buildLifecycleSummary(filteredLifecycleRecords),
    },
  };
}

export async function GET() {
  try {
    const result = await collectWorkspaceLifecycle();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      {
        error: message,
        workspaces: [],
        repos: [],
        lifecycle: {
          records: [] as WorkspaceLifecycleRecordView[],
          summary: {
            unreadCount: 0,
            archivedCount: 0,
            nextAttentionWorkspaceId: null,
          } satisfies WorkspaceLifecycleSummaryView,
        },
      },
      { status: 200 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { action?: string; workspaceId?: string };
    const workspaceId = body.workspaceId?.trim();
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (body.action !== 'archive' && body.action !== 'restore' && body.action !== 'mark_read') {
      return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
    }

    const result = mutateWorkspaceLifecycleRecord({
      action: body.action,
      workspaceId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update workspace lifecycle' },
      { status: 500 },
    );
  }
}
