/**
 * `o8 task …` — packet/lane task-pool projection for agents and humans.
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

type TaskPoolGroup = 'ready' | 'running' | 'review' | 'blocked' | 'done';

interface TaskPoolRepoSummary {
  id: string;
  name: string;
  localPath: string;
  role: string | null;
  isMain: boolean;
  isCurrent: boolean;
}

interface TaskPoolProjectSummary {
  id: string;
  name: string;
  slug: string;
  mainRepo: TaskPoolRepoSummary | null;
  currentRepo: TaskPoolRepoSummary | null;
  relatedRepos: TaskPoolRepoSummary[];
}

interface TaskPoolLaneSummary {
  id: string;
  label: string;
  status: string;
  runtime: string;
  branch: string;
  baseBranch: string;
  sessionKey: string | null;
  worktreePath: string | null;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

interface TaskPoolTask {
  id: string;
  packetId: string | null;
  laneId: string | null;
  title: string;
  summary: string;
  group: TaskPoolGroup;
  status: string;
  runtime: string;
  workerIntent: string | null;
  workerRouting: {
    requestedProvider: string | null;
    requestedRuntime: string | null;
    selectedProvider: string;
    selectedRuntime: string;
    enforcement: string;
    confidence: string;
    reason: string;
  } | null;
  branch: string | null;
  baseBranch: string | null;
  repoPath: string | null;
  repoName: string | null;
  queueState: string | null;
  releaseState: string | null;
  blockedReason: string | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  allowedFiles: string[];
  project: TaskPoolProjectSummary | null;
  lane: TaskPoolLaneSummary | null;
  taskBrief?: string;
}

interface TaskPool {
  schema: 'o8/task.pool/v1';
  tasks: TaskPoolTask[];
  groups: Record<TaskPoolGroup, TaskPoolTask[]>;
  counts: Record<TaskPoolGroup, number>;
}

interface TaskDetail {
  schema: 'o8/task.detail/v1';
  task: TaskPoolTask;
}

interface TaskMutation {
  schema: 'o8/task.mutation/v1';
  ok: boolean;
  action: 'create' | 'claim' | 'dispatch' | 'block' | 'report' | 'archive' | 'prune';
  taskId: string;
  packetId: string | null;
  laneId: string | null;
  note: string;
  eventId?: string;
  statusChanged?: boolean;
  workerRouting?: TaskPoolTask['workerRouting'];
  task: TaskPoolTask | null;
}

const VALUE_FLAGS = new Set([
  '--project',
  '--repo',
  '--title',
  '--summary',
  '--note',
  '--message',
  '--model',
  '--worker',
  '--provider',
  '--runtime',
  '--reason',
  '--code',
  '--event',
  '--status',
]);

function hasFlag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

function readFlagValue(rest: string[], name: string): string | null {
  const index = rest.indexOf(name);
  if (index === -1) return null;
  const value = rest[index + 1];
  return value && !value.startsWith('-') ? value : null;
}

function taskQuery(rest: string[]): string {
  const params = new URLSearchParams();
  if (hasFlag(rest, '--include-done')) params.set('includeDone', 'true');
  if (hasFlag(rest, '--include-brief')) params.set('includeBrief', 'true');
  const projectId = readFlagValue(rest, '--project');
  if (projectId) params.set('projectId', projectId);
  const repoPath = readFlagValue(rest, '--repo');
  if (repoPath) params.set('repoPath', repoPath);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function positionalArgs(rest: string[]): string[] {
  const args: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index];
    if (!entry) continue;
    if (VALUE_FLAGS.has(entry)) {
      index += 1;
      continue;
    }
    if (entry.startsWith('-')) continue;
    args.push(entry);
  }
  return args;
}

function taskIdFromRest(rest: string[], command: string): string {
  const id = positionalArgs(rest)[0]?.trim();
  if (!id) {
    throw new CliError(
      'invalid_args',
      `o8 task ${command} <id> needs a packet, lane, or task id.`,
      EXIT.INVALID_ARGS,
      `Example: o8 task ${command} pkt-abc --human`,
    );
  }
  return id;
}

function printTaskLine(task: TaskPoolTask): void {
  const id = task.packetId ?? task.laneId ?? task.id;
  const repo = task.repoName ?? 'no repo';
  const project = task.project?.name ?? 'no project';
  process.stdout.write(`  ${id}  ${task.status}  ${repo}  ${project}\n`);
  if (task.workerIntent || task.workerRouting) {
    process.stdout.write(`    worker=${task.workerIntent ?? 'unknown'} selected=${task.workerRouting?.selectedRuntime ?? task.runtime}\n`);
  }
  process.stdout.write(`    ${task.title}\n`);
}

function printHumanTaskPool(pool: TaskPool): void {
  printHumanHeading('task pool');
  printHumanKv([
    ['blocked', String(pool.counts.blocked)],
    ['review', String(pool.counts.review)],
    ['running', String(pool.counts.running)],
    ['ready', String(pool.counts.ready)],
    ['done', String(pool.counts.done)],
  ]);

  for (const group of ['blocked', 'review', 'running', 'ready', 'done'] as TaskPoolGroup[]) {
    printHumanHeading(`${group} (${pool.counts[group]})`);
    if (pool.groups[group].length === 0) {
      process.stdout.write('  (none)\n');
      continue;
    }
    for (const task of pool.groups[group]) {
      printTaskLine(task);
    }
  }
}

function printHumanTaskDetail(detail: TaskDetail): void {
  const { task } = detail;
  printHumanHeading('task');
  printHumanKv([
    ['id', task.id],
    ['packet', task.packetId ?? '(none)'],
    ['lane', task.laneId ?? '(none)'],
    ['group', task.group],
    ['status', task.status],
    ['runtime', task.runtime],
    ['worker', task.workerIntent ?? '(none)'],
    ['selected runtime', task.workerRouting?.selectedRuntime ?? '(none)'],
    ['repo', task.repoName ?? '(none)'],
    ['project', task.project?.name ?? '(none)'],
    ['branch', task.branch ?? '(none)'],
  ]);
  process.stdout.write(`\n${task.title}\n`);
  if (task.summary) process.stdout.write(`\n${task.summary}\n`);
  if (task.taskBrief) {
    printHumanHeading('brief');
    process.stdout.write(task.taskBrief.split('\n').map((line) => `  ${line}`).join('\n') + '\n');
  }
}

function printHumanMutation(result: TaskMutation): void {
  printHumanHeading(`task ${result.action}`);
  printHumanKv([
    ['ok', String(result.ok)],
    ['task', result.taskId],
    ['packet', result.packetId ?? '(none)'],
    ['lane', result.laneId ?? '(none)'],
    ['note', result.note],
    ['selected runtime', result.workerRouting?.selectedRuntime ?? result.task?.workerRouting?.selectedRuntime ?? '(none)'],
  ]);
  if (result.task) {
    process.stdout.write(`\n${result.task.title}\n`);
    process.stdout.write(`  status: ${result.task.status} · group: ${result.task.group}\n`);
  }
}

async function runTaskMutation(
  mode: OutputMode,
  action: TaskMutation['action'],
  rest: string[],
  body: Record<string, unknown>,
): Promise<number> {
  const id = taskIdFromRest(rest, action);
  const cfg = resolveConfig();
  const operatorPaths = {
    claim: `/api/tasks/${encodeURIComponent(id)}/claim`,
    dispatch: `/api/tasks/${encodeURIComponent(id)}/dispatch`,
    archive: `/api/tasks/${encodeURIComponent(id)}/archive`,
    prune: `/api/tasks/${encodeURIComponent(id)}/prune`,
  };
  const path = action in operatorPaths
    ? operatorPaths[action as keyof typeof operatorPaths]
    : `/api/tasks/${encodeURIComponent(id)}/${action}`;
  const res = await apiFetch<TaskMutation>(
    cfg,
    path,
    { method: 'POST', body },
  );
  if (!res.data) {
    throw new CliError('invalid_response', `Server returned an empty ${action} result.`, EXIT.INVALID_ARGS);
  }
  if (!res.data.ok) {
    throw new CliError('mutation_failed', res.data.note || `Task ${action} failed.`, EXIT.CONFLICT);
  }
  if (mode.human) {
    printHumanMutation(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}

export async function runTaskList(mode: OutputMode, rest: string[]): Promise<number> {
  const cfg = resolveConfig();
  const res = await apiFetch<TaskPool>(cfg, `/api/tasks${taskQuery(rest)}`);
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty task pool.', EXIT.INVALID_ARGS);
  }
  if (mode.human) {
    printHumanTaskPool(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}

export async function runTaskBrief(mode: OutputMode, rest: string[]): Promise<number> {
  const id = taskIdFromRest(rest, 'brief');
  const cfg = resolveConfig();
  const res = await apiFetch<TaskDetail>(cfg, `/api/tasks/${encodeURIComponent(id)}${taskQuery(rest)}`);
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty task detail.', EXIT.INVALID_ARGS);
  }
  if (mode.human) {
    printHumanTaskDetail(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}

export async function runTaskCreate(mode: OutputMode, rest: string[]): Promise<number> {
  const title = readFlagValue(rest, '--title') ?? positionalArgs(rest).join(' ').trim();
  if (!title) {
    throw new CliError(
      'invalid_args',
      'o8 task create requires --title or a title argument.',
      EXIT.INVALID_ARGS,
      'Example: o8 task create --title "Wire task pool actions" --repo /path/to/repo',
    );
  }

  const cfg = resolveConfig();
  const res = await apiFetch<TaskMutation>(
    cfg,
    '/api/tasks',
    {
      method: 'POST',
      body: {
        actor: 'orchestrator',
        title,
        summary: readFlagValue(rest, '--summary') ?? readFlagValue(rest, '--message'),
        projectId: readFlagValue(rest, '--project'),
        repoPath: readFlagValue(rest, '--repo'),
        model: readFlagValue(rest, '--model'),
        workerIntent: readFlagValue(rest, '--worker'),
        requestedProvider: readFlagValue(rest, '--provider'),
        requestedRuntime: readFlagValue(rest, '--runtime'),
      },
    },
  );
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty create result.', EXIT.INVALID_ARGS);
  }
  if (mode.human) {
    printHumanMutation(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}

export async function runTaskClaim(mode: OutputMode, rest: string[]): Promise<number> {
  return runTaskMutation(mode, 'claim', rest, {
    actor: 'orchestrator',
    projectId: readFlagValue(rest, '--project'),
    repoPath: readFlagValue(rest, '--repo'),
    note: readFlagValue(rest, '--note'),
  });
}

export async function runTaskDispatch(mode: OutputMode, rest: string[]): Promise<number> {
  return runTaskMutation(mode, 'dispatch', rest, {
    actor: 'orchestrator',
    projectId: readFlagValue(rest, '--project'),
    repoPath: readFlagValue(rest, '--repo'),
    message: readFlagValue(rest, '--message'),
    model: readFlagValue(rest, '--model'),
    workerIntent: readFlagValue(rest, '--worker'),
    requestedProvider: readFlagValue(rest, '--provider'),
    requestedRuntime: readFlagValue(rest, '--runtime'),
  });
}

export async function runTaskBlock(mode: OutputMode, rest: string[]): Promise<number> {
  const reason = readFlagValue(rest, '--reason');
  if (!reason) {
    throw new CliError(
      'invalid_args',
      'o8 task block <id> requires --reason.',
      EXIT.INVALID_ARGS,
      'Example: o8 task block pkt-abc --reason "Waiting on API key"',
    );
  }
  return runTaskMutation(mode, 'block', rest, {
    actor: 'orchestrator',
    projectId: readFlagValue(rest, '--project'),
    repoPath: readFlagValue(rest, '--repo'),
    reason,
    code: readFlagValue(rest, '--code'),
  });
}

export async function runTaskReport(mode: OutputMode, rest: string[]): Promise<number> {
  return runTaskMutation(mode, 'report', rest, {
    actor: 'orchestrator',
    projectId: readFlagValue(rest, '--project'),
    repoPath: readFlagValue(rest, '--repo'),
    event: readFlagValue(rest, '--event'),
    status: readFlagValue(rest, '--status'),
    reason: readFlagValue(rest, '--reason'),
    message: readFlagValue(rest, '--message'),
  });
}

export async function runTaskArchive(mode: OutputMode, rest: string[]): Promise<number> {
  return runTaskMutation(mode, 'archive', rest, {
    actor: 'orchestrator',
    projectId: readFlagValue(rest, '--project'),
    repoPath: readFlagValue(rest, '--repo'),
    reason: readFlagValue(rest, '--reason'),
  });
}

export async function runTaskPrune(mode: OutputMode, rest: string[]): Promise<number> {
  return runTaskMutation(mode, 'prune', rest, {
    actor: 'orchestrator',
    projectId: readFlagValue(rest, '--project'),
    repoPath: readFlagValue(rest, '--repo'),
    reason: readFlagValue(rest, '--reason'),
  });
}
