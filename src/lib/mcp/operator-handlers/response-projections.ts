import type { TaskPool } from '@/lib/tasks/pool';

export function projectOperatorDefaults(data: unknown, args: Record<string, unknown>): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const { values, sources, recentRoleReceipts, cliAuth, ...details } = data as Record<string, unknown>;
  return {
    values,
    sources,
    ...(args.includeDetails === true ? details : {}),
    ...(args.includeReceipts === true ? { recentRoleReceipts } : {}),
    ...(args.includeAuth === true ? { cliAuth } : {}),
  };
}

export function projectStatusAgent(agent: Record<string, unknown>, includeEvidence: boolean) {
  if (includeEvidence || !agent.statusEvidence || typeof agent.statusEvidence !== 'object') return agent;
  const { evidence, ...statusEvidence } = agent.statusEvidence as Record<string, unknown>;
  return {
    ...agent,
    statusEvidence: { ...statusEvidence, evidenceCount: Array.isArray(evidence) ? evidence.length : 0 },
  };
}

export function projectTaskPool(pool: TaskPool, includeDetails: boolean) {
  return {
    schema: 'o8/mcp/task.pool/v1',
    tasks: includeDetails ? pool.tasks : pool.tasks.map((task) => ({
      id: task.id,
      packetId: task.packetId,
      laneId: task.laneId,
      title: task.title,
      group: task.group,
      status: task.status,
      runtime: task.runtime,
      repoName: task.repoName,
      branch: task.branch,
      queueState: task.queueState,
      releaseState: task.releaseState,
      blockedReason: task.blockedReason,
      ...(task.failureReason ? { failureReason: task.failureReason } : {}),
      ...(task.cleanup ? { cleanup: task.cleanup } : {}),
      lastEventAt: task.lastEventAt,
      execution: task.execution,
    })),
    groups: Object.fromEntries(Object.entries(pool.groups).map(([group, tasks]) => [group, tasks.map((task) => task.id)])),
    counts: pool.counts,
  };
}
