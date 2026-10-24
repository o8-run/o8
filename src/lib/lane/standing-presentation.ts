import type { AgentSummary } from '@/lib/fleet/types';
import { listLanes } from './registry';
import { readStandingLane } from './standing-store';

/** The worker grid keeps one surface while packet identity changes underneath it. */
export function projectStandingWorkers(agents: AgentSummary[]): AgentSummary[] {
  const bySession = new Map(listLanes().flatMap(lane => lane.sessionKey ? [[lane.sessionKey, lane] as const] : []));
  return agents.flatMap(agent => {
    const lane = bySession.get(agent.sessionKey);
    const state = lane ? readStandingLane(lane.id) : null;
    if (!lane || !state) return [agent];
    if (state.removed) return [];
    const task = state.tasks.find(task => !['done', 'queued'].includes(task.phase));
    const queueDepth = state.tasks.filter(task => task.phase === 'queued').length;
    return [{ ...agent, name: lane.label, branch: lane.branch,
      currentTask: task?.prompt ?? (state.stopped ? 'Standing worker stopped' : 'Standing worker ready'),
      standingLane: { laneId: lane.id, currentTask: task?.prompt ?? null, queueDepth, stopped: state.stopped } }];
  });
}
