import { execFileSync } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { getSqlite } from '@/lib/db';
import { listApprovalsForContext } from '@/lib/approvals/store';
import { listArtifacts } from '@/lib/artifacts/store';
import { listTaskArtifactsByPacket } from '@/lib/task-artifacts/store';
import { getLane, getLaneEvents } from '@/lib/lane/registry';
import { evaluateContractCoverage, readCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';
import { getRuntime } from '@/lib/runtimes/registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { AgentSummary } from '@/lib/fleet/types';
import type { ProjectThread, ThreadWorker } from './types';
import type { createThreadProjectScope, ThreadTarget } from './project-scope';
import { threadProjectMatches } from '@/components/desktop/o8-panel/thread-project-identity';

export async function attachThreadEvidence(task: ProjectThread, packet: OrchestratorPacket | undefined, agents: AgentSummary[], detail: boolean, scope: Awaited<ReturnType<typeof createThreadProjectScope>>) {
  const db = getSqlite();
  const lane = task.laneId ? getLane(task.laneId) : null;
  const members = agents.filter(agent => agent.sessionKey === task.thread.sessionKey && (!agent.workspace || agent.workspace === task.repoPath || agent.workspace === lane?.worktreePath));
  if (task.thread.sessionKey && !members.length) members.push({ sessionKey: task.thread.sessionKey,
    name: lane?.label ?? task.title, runtime: task.runtime, model: lane?.model ?? task.workerRouting?.selectedModel ?? '', status: task.status } as AgentSummary);
  task.thread.workers = await Promise.all(members.map(async agent => {
    const usage = db.prepare('SELECT SUM(input_tokens + output_tokens) AS tokens FROM usage_logs WHERE session_key = ? AND repo_path = ? AND (? IS NULL OR lane_id = ?) AND (? IS NULL OR packet_id = ?)').get(agent.sessionKey, task.repoPath, task.laneId, task.laneId, task.packetId, task.packetId) as { tokens: number | null };
    const worker: ThreadWorker = { sessionKey: agent.sessionKey, name: agent.name, runtime: agent.runtime, model: agent.model || null,
      status: agent.status, tokens: usage.tokens ?? agent.tokenUsage?.totalTokens ?? null, tools: null, toolsTruncated: false, stage: null };
    if (detail) {
      try {
        let cancel = () => {};
        const transcript = await Promise.race([
          Promise.resolve(getRuntime(agent.runtime as Parameters<typeof getRuntime>[0])?.readTranscript(agent.sessionKey, undefined, 5_000)),
          new Promise<undefined>(resolve => { const timer = setTimeout(() => resolve(undefined), 2_000); cancel = () => clearTimeout(timer); }),
        ]).finally(() => cancel());
        if (transcript) { worker.tools = transcript.reduce((sum, entry) => sum + (entry.toolCalls?.length ?? 0), 0); worker.toolsTruncated = transcript.length >= 5_000; }
      } catch { /* Unavailable telemetry stays unknown. */ }
    }
    return worker;
  }));
  const projectId = task.project?.panelProjectId;
  const inProject = (target: ThreadTarget) => !task.project || threadProjectMatches(scope.targetProject(target), projectId ?? task.project.id);
  const artifactHref = (id: string, interactive = false) => `/api/panel/threads/artifact?${new URLSearchParams({ id,
    ...(projectId ? { projectId } : {}), ...(interactive ? { source: 'interactive' } : {}) })}`;
  task.thread.artifacts = lane || packet ? listArtifacts(packet ? { packetId: packet.id } : { laneId: lane!.id })
    .filter(record => record.repoPath === task.repoPath && (!record.laneId || record.laneId === task.laneId) && inProject(record))
    .slice(-50).map(record => ({ id: record.id, title: record.label || record.kind, kind: record.kind, href: artifactHref(record.id) })) : [];
  if (packet) task.thread.artifacts.push(...listTaskArtifactsByPacket(packet.id, 50).filter(record => record.target.repoPath === task.repoPath
    && record.target.laneId === task.laneId && record.target.sessionKey === task.thread.sessionKey && inProject(record.target))
    .map(record => ({ id: record.id, title: record.title, kind: 'interactive', href: artifactHref(record.id, true), interactive: true })));
  if (packet && lane) {
    const completion = db.prepare(`SELECT changed_files_json AS files FROM session_outcomes
      WHERE packet_id = ? AND lane_id = ? AND session_key IS ? AND repo_path = ? ORDER BY completed_at DESC LIMIT 1`)
      .get(packet.id, lane.id, lane.sessionKey, task.repoPath) as { files: string } | undefined;
    let files: unknown = [];
    try { files = JSON.parse(completion?.files ?? '[]'); } catch { /* Malformed historical receipts carry no file authority. */ }
    if (Array.isArray(files)) task.thread.artifacts.push(...[...new Set(files.filter((file): file is string => typeof file === 'string'
      && file.length > 0 && file.length < 4096 && !path.isAbsolute(file) && !/[\\\x00\r\n]/.test(file) && !file.split('/').includes('..')))].slice(0, 50)
      .map(file => ({ id: `file:${lane.id}:${file}`, title: file, kind: 'file',
        href: `/api/v2/files?${new URLSearchParams({ path: file, workspace: lane.worktreePath || lane.repoPath, preview: '1' })}` })));
  }
  // Immutable delivery links, never a branch-name or PR-number guess.
  const prs = db.prepare(`SELECT p.pull_request_id AS id, p.title, p.url, p.state, p.merged_at AS mergedAt,
    p.status_checks_json AS checks, p.head_sha AS head FROM conversation_pr_context c
    JOIN github_pull_requests p ON p.repository_id = c.repository_id AND p.pull_request_id = c.pull_request_id AND p.number = c.number
    WHERE c.source = 'packet' AND c.packet_id = ? AND c.lane_id = ? ORDER BY c.id DESC LIMIT 50`).all(task.packetId, task.laneId) as Array<{ id: number; title: string; url: string; state: string; mergedAt: string | null; checks: string; head: string | null }>;
  task.thread.merges = [...new Map(prs.map(pr => {
    let checks: Array<{ state?: string; status?: string; conclusion?: string }> = [];
    try { const parsed = JSON.parse(pr.checks); if (Array.isArray(parsed)) checks = parsed; } catch { /* Unknown, never green. */ }
    const statuses = checks.map(check => String(check.conclusion ?? check.state ?? check.status ?? '').toLowerCase());
    const state = statuses.some(value => ['failure', 'failed', 'error', 'cancelled', 'timed_out', 'action_required'].includes(value)) ? 'fail'
      : statuses.some(value => ['pending', 'queued', 'in_progress', 'running', 'waiting'].includes(value)) ? 'running'
        : statuses.length && statuses.every(value => ['success', 'successful', 'neutral', 'skipped'].includes(value)) ? 'pass' : 'unknown';
    return [String(pr.id), { id: String(pr.id), title: pr.title, url: pr.url, state: pr.mergedAt ? 'merged' : pr.state, checks: state as 'pass' | 'fail' | 'running' | 'unknown', head: pr.head }] as const;
  })).values()];
  if (lane?.prNumber && !task.thread.merges.length) task.thread.merges.push({ id: `lane:${lane.id}`, title: `PR #${lane.prNumber}`, url: '', state: lane.outcome === 'merged' ? 'merged' : 'Provider identity unavailable', checks: 'unknown', head: null });
  const events = lane ? getLaneEvents(lane.id, 101) : [];
  task.thread.history = [...task.thread.history, ...events.slice(0, 100).map(event => ({ id: event.id, at: event.timestamp, label: event.verb.replaceAll('_', ' ') }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
  task.thread.truncated = events.length > 100 || task.thread.artifacts.length >= 50 || prs.length >= 50;
  let currentHead: string | null = null;
  let covered = new Set<string>();
  if (detail && packet?.taskContract && lane) {
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', lane.worktreePath || lane.repoPath, ...args], {
        encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024, env: childEnvironment({ env: { GIT_OPTIONAL_LOCKS: '0' } }), stdio: ['ignore', 'pipe', 'pipe'],
      }).replace(/\n$/, '');
      currentHead = git('rev-parse', 'HEAD');
      const approval = listApprovalsForContext({ packetId: packet.id, laneId: lane.id }).filter(item => item.toolName === 'orchestrator_review'
        && item.args?.reviewSuperseded !== true).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const result = evaluateContractCoverage({ contract: packet.taskContract, contractRequired: true, evidence: readCoverageEvidence(approval?.args),
        reviewedHeadSha: currentHead, changedPaths: git('diff', '--name-only', `${lane.baseBranch}...HEAD`).split('\n'), repositoryPaths: git('ls-tree', '-r', '--name-only', 'HEAD').split('\n') });
      if (approval?.args?.approved === true && git('rev-parse', 'HEAD') === currentHead) covered = new Set(result.checks.filter(check => check.covered).map(check => check.requirementId));
    } catch { /* Missing or stale proof must not become a checked requirement. */ }
  }
  task.thread.requirements = packet?.taskContract?.requirements.map(requirement => ({ id: requirement.id, text: requirement.expectedBehavior,
    covered: covered.has(requirement.id), verification: requirement.verification, head: currentHead })) ?? [];
}
