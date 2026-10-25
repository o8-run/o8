import 'server-only';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { threadProjectMatches } from '@/components/desktop/o8-panel/thread-project-identity';
import { getTaskPool } from '@/lib/tasks/pool';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { listRecordedApprovals } from '@/lib/approvals/store';
import { extractApprovalContextIds } from '@/lib/approvals/context';
import { listRepos } from '@/lib/repos/registry';
import { normalizeAgentBusRepoPath } from '@/lib/agents/repo-paths';
import { listRecentAgentMessages } from '@/lib/agents/store';
import { listRecordedInboxItems } from '@/lib/supervisor/inbox';
import { listPersistedLlmChats, readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { getProjectsLedgerSync } from '@/lib/repos/projects';
import { listProjects } from '@/lib/projects/store';
import { buildDagMetadata } from '@/lib/orchestrator/dag';
import { groupThreads, type ThreadGrouping } from './grouping';
import { attachThreadEvidence } from './evidence';
import { redactThreadDisplay } from './redaction';
import type { ProjectThread, ProjectThreads, ThreadEvidence, ThreadState } from './types';

const states: ThreadState[] = ['waiting', 'review', 'working', 'resolved'];
function stateFor(status: string, group?: string): ThreadState {
  if (['completed', 'archived', 'released', 'resolved', 'self_healed', 'dismissed'].includes(status) || group === 'done') return 'resolved';
  if (['awaiting_human', 'awaiting_input', 'awaiting_orchestrator', 'blocked', 'failed', 'recovering', 'human_required', 'escalated', 'pending', 'unknown', 'paused', 'waiting', 'idle'].includes(status) || group === 'blocked') return 'waiting';
  if (['reviewing', 'awaiting_review', 'review-ready'].includes(status) || group === 'review') return 'review';
  return 'working';
}
function blank(kind: ThreadEvidence['kind'], state: ThreadState, sessionKey: string | null, observedAt: string): ThreadEvidence {
  return { kind, state, sessionKey, observedAt, childIds: [], requirements: [], artifacts: [], merges: [], workers: [], stages: [], history: [], truncated: false };
}
function synthetic(id: string, title: string, repoPath: string, runtime: string, status: string, thread: ThreadEvidence): ProjectThread {
  return { id, title, repoPath, runtime, status, thread, packetId: null, laneId: null, summary: '', group: thread.state === 'waiting' ? 'blocked' : thread.state === 'resolved' ? 'done' : thread.state === 'review' ? 'review' : 'running',
    workerIntent: null, workerRouting: null, branch: null, baseBranch: null, repoName: path.basename(repoPath), queueState: null, releaseState: null,
    blockedReason: null, lastEventAt: null, lastEventLabel: null, allowedFiles: [], sourceIssue: null, problemDossierId: null, problemRemedyId: null, project: null, lane: null, execution: null };
}
export interface ThreadReadOptions { repoPaths?: string[]; projectId?: string | null; state?: ThreadState; taskId?: string; offset?: number; limit?: number; revision?: string; model?: ThreadGrouping }
export class ThreadReadInputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export async function readProjectThreads(options: ThreadReadOptions = {}): Promise<ProjectThreads & { task?: ProjectThread }> {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (options.model && !['A', 'B', 'C'].includes(options.model)) throw new ThreadReadInputError('Use grouping A, B or C.');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 250 || (options.state && !states.includes(options.state))) throw new ThreadReadInputError('Use a valid thread state and a nonnegative offset with a limit from 1 to 250.');
  const observedAt = new Date().toISOString();
  const paths = new Set((options.repoPaths ?? []).map(normalizeAgentBusRepoPath));
  const ledger = getProjectsLedgerSync();
  const projectRecords = new Map(listProjects().map(project => [project.id, project]));
  const recordProject = (id: string | null): ProjectThread['project'] => {
    if (!id) return null;
    const aliases = ledger.projects.filter(candidate => candidate.sqliteProjectId === id);
    const project = ledger.projects.find(candidate => candidate.id === id) ?? (aliases.length === 1 ? aliases[0] : undefined);
    return { id, panelProjectId: project?.id ?? null, name: project?.name ?? 'Unavailable project',
      slug: projectRecords.get(project?.sqliteProjectId ?? id)?.slug ?? '', mainRepo: null, currentRepo: null, relatedRepos: [] };
  };
  const recordVisible = (id: string | null) => !options.projectId || threadProjectMatches(recordProject(id), options.projectId);
  const visible = (task: Pick<ProjectThread, 'repoPath' | 'project'>) => {
    if (paths.size && (!task.repoPath || !paths.has(normalizeAgentBusRepoPath(task.repoPath)))) return false;
    if (!options.projectId) return true;
    if (task.project) return threadProjectMatches(task.project, options.projectId);
    return Boolean(task.repoPath && ledger.projects.find(project => project.id === options.projectId)?.repoPaths.some(repo => normalizeAgentBusRepoPath(repo) === normalizeAgentBusRepoPath(task.repoPath!)));
  };
  const pool = await getTaskPool({ includeDone: true, includeMissionHistory: true });
  const inventory = await getRuntimeInventorySnapshot();
  const missions = listMissionRegistryEntries({ includeArchived: true }).map(entry => entry.mission);
  const current = currentMissionState();
  if (current.missionId) { const index = missions.findIndex(mission => mission.missionId === current.missionId); if (index >= 0) missions.splice(index, 1); missions.push(current); }
  const packets = new Map(missions.flatMap(mission => mission.packets).concat(current.packets).map(packet => [packet.id, packet]));
  const tasks: ProjectThread[] = pool.tasks.filter(visible).map(task => ({ ...task,
    thread: blank(task.packetId ? 'packet' : 'lane', stateFor(task.status, task.group), task.lane?.sessionKey ?? task.execution?.sessionKey ?? null, observedAt) }));
  for (const item of listRecordedInboxItems({ includeAllProjects: true, includeDismissed: true })) {
    if (!recordVisible(item.projectId)) continue;
    const existing = tasks.find(task => item.packetId && task.packetId === item.packetId && task.repoPath === item.repoPath);
    if (existing) {
      if (!['resolved', 'self_healed', 'dismissed'].includes(item.status) && existing.thread.state !== 'resolved') {
        existing.thread.state = stateFor(item.status); existing.group = existing.thread.state === 'waiting' ? 'blocked' : 'running';
        existing.blockedReason = item.errorExcerpt || item.kind.replaceAll('_', ' ');
      }
      continue;
    }
    const node = synthetic(`inbox:${item.id}`, item.packetTitle || item.kind.replaceAll('_', ' '), item.repoPath, 'unknown', item.status, blank('inbox', stateFor(item.status), item.sessionKey, observedAt));
    node.project = recordProject(item.projectId);
    node.blockedReason = item.errorExcerpt || item.kind.replaceAll('_', ' '); node.lastEventAt = item.lastSeenAt;
    if (visible(node)) tasks.push(node);
  }
  for (const approval of listRecordedApprovals()) {
    if (!recordVisible(approval.projectId)) continue;
    const ids = extractApprovalContextIds(approval.metadata);
    const matched = tasks.find(task => ids.laneId ? task.laneId === ids.laneId : ids.packetId ? task.packetId === ids.packetId : task.thread.sessionKey === approval.sessionKey);
    const repo = matched?.repoPath ?? approval.metadata?.RepoPath ?? approval.metadata?.repoPath ?? approval.metadata?.Workspace;
    if (!repo) continue;
    const node = matched ?? synthetic(`approval:${approval.id}`, approval.title, repo, approval.runtime, 'pending', blank('approval', 'waiting', approval.sessionKey, observedAt));
    if (!matched) node.project = recordProject(approval.projectId);
    if (!visible(node)) continue;
    node.thread.state = 'waiting'; node.group = 'blocked'; node.blockedReason = approval.summary || approval.description || approval.title;
    if (!matched) { node.lastEventAt = new Date(approval.updatedAt).toISOString(); tasks.push(node); }
  }
  for (const repo of await listRepos()) {
    if (!visible({ repoPath: repo.localPath, project: null })) continue;
    const messages = listRecentAgentMessages(repo.localPath, 250);
    const latest = [...new Map(messages.map(message => [message.conversation?.id ?? message.id, message] as const).reverse()).values()];
    for (const message of latest) {
      const bound = tasks.find(task => task.repoPath && normalizeAgentBusRepoPath(task.repoPath) === normalizeAgentBusRepoPath(repo.localPath) && (message.refs.laneId ? task.laneId === message.refs.laneId : Boolean(message.refs.packetId && task.packetId === message.refs.packetId)));
      if (bound) {
        bound.thread.history.push({ id: message.id, at: message.timestamp, label: message.text.slice(0, 500) });
        if (message.delivery === 'failed' && message.conversation?.status !== 'closed') {
          bound.thread.state = 'waiting'; bound.group = 'blocked'; bound.blockedReason = 'Handoff delivery failed. Open the recorded exchange.';
        }
        continue;
      }
      const state = message.conversation?.status === 'closed' ? 'resolved' : message.delivery === 'failed' ? 'waiting' : 'working';
      const node = synthetic(`handoff:${message.conversation?.id ?? message.id}`, `${message.from} → ${message.to}`, repo.localPath, message.refs.identities?.from?.runtime ?? 'unknown', state, blank('handoff', state, null, observedAt));
      node.summary = message.text.slice(0, 500); node.lastEventAt = message.timestamp;
      node.blockedReason = state === 'waiting' ? 'Handoff delivery failed. Open the recorded exchange.' : null;
      node.thread.history = [{ id: message.id, at: message.timestamp, label: node.summary }];
      tasks.push(node);
    }
  }
  const sessions = new Set(tasks.map(task => task.thread.sessionKey).filter(Boolean));
  for (const agent of inventory.agents) {
    if (!agent.sessionKey || sessions.has(agent.sessionKey) || !agent.workspace) continue;
    const node = synthetic(`session:${agent.sessionKey}`, agent.currentTask || agent.name, agent.workspace, agent.runtime, agent.status, blank('session', stateFor(agent.status), agent.sessionKey, observedAt));
    node.branch = agent.branch || null; node.lastEventAt = agent.lastEventAt;
    if (visible(node)) { tasks.push(node); sessions.add(agent.sessionKey); }
  }
  for (const id of listPersistedLlmChats()) {
    const key = `llm-chat:${id}`; if (sessions.has(key)) continue;
    const record = readPersistedLlmChat(id); if (!record?.history.repoPath) continue;
    const node = synthetic(`session:${key}`, record.history.title || 'Saved conversation', record.history.repoPath, 'llm-chat', 'idle', blank('session', 'resolved', key, observedAt));
    node.lastEventAt = record.modifiedAt;
    if (visible(node)) { tasks.push(node); sessions.add(key); }
  }
  await Promise.all(tasks.map(task => attachThreadEvidence(task, packets.get(task.packetId ?? ''), inventory.agents, options.taskId === task.id || missions.some(mission => mission.missionId === options.taskId && mission.packets.some(packet => packet.id === task.packetId)))));
  for (const mission of missions) {
    const children = tasks.filter(task => mission.packets.some(packet => packet.id === task.packetId));
    if (!children.length || !mission.missionId) continue;
    const state = states.find(candidate => children.some(child => child.thread.state === candidate))!;
    const node = synthetic(mission.missionId, mission.summary || mission.prompt || 'Mission', children[0].repoPath!, mission.runtime || 'mixed', state, blank('mission', state, null, observedAt));
    node.thread.childIds = children.map(child => child.id);
    const waves = buildDagMetadata(mission.packets).waves;
    for (const wave of waves) {
      const members = children.filter(child => wave.packetIds.includes(child.packetId!));
      if (!members.length) continue;
      node.thread.stages.push({ name: `Wave ${wave.wave}`, done: members.filter(child => child.thread.state === 'resolved').length, total: members.length });
      for (const child of members) {
        child.thread.stages = [{ name: `Wave ${wave.wave}`, done: child.thread.state === 'resolved' ? 1 : 0, total: 1 }];
        for (const worker of child.thread.workers) worker.stage = `Wave ${wave.wave}`;
      }
    }
    node.thread.workers = [...new Map(children.flatMap(child => child.thread.workers).map(worker => [worker.sessionKey, worker])).values()];
    node.thread.artifacts = children.flatMap(child => child.thread.artifacts);
    node.thread.merges = [...new Map(children.flatMap(child => child.thread.merges).map(pr => [pr.id, pr])).values()];
    node.thread.history = children.flatMap(child => child.thread.history).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
    tasks.push(node);
  }
  tasks.sort((a, b) => states.indexOf(a.thread.state) - states.indexOf(b.thread.state) || (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? '') || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(states.map(state => [state, groupThreads(tasks, options.model ?? 'C').filter(task => task.thread.state === state).length])) as ProjectThreads['counts'];
  const grouped = groupThreads(tasks, options.model ?? 'C');
  const filtered = options.state ? grouped.filter(task => task.thread.state === options.state) : grouped;
  const revision = createHash('sha256').update(JSON.stringify(filtered.map(task => [task.id, task.repoPath, task.thread.state, task.lastEventAt]))).digest('hex');
  if (options.revision && options.revision !== revision) throw new ThreadReadInputError('Threads changed between pages. Refresh this view.', 409);
  const selected = options.taskId ? tasks.find(task => task.id === options.taskId) : undefined;
  return { revision, schema: 'o8/project.threads/v1', observedAt, counts, tasks: filtered.slice(offset, offset + limit).map(redactThreadDisplay), offset,
    nextOffset: offset + limit < filtered.length ? offset + limit : null,
    ...(selected ? { task: redactThreadDisplay(selected) } : {}) };
}
