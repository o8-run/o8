import 'server-only';
import { getProjectsLedger } from '@/lib/repos/projects';
import { listProjects } from '@/lib/projects/store';
import { getLane } from '@/lib/lane/registry';
import { normalizeAgentBusRepoPath } from '@/lib/agents/repo-paths';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { ProjectThread } from './types';

export interface ThreadTarget {
  repoPath: string | null;
  laneId?: string | null;
  packetId?: string | null;
  threadId?: string | null;
  sessionKey?: string | null;
}

/** Repo membership is a location filter, never proof of project ownership. */
export async function createThreadProjectScope(knownPackets?: ReadonlyMap<string, OrchestratorPacket>) {
  const ledger = await getProjectsLedger();
  const projects = new Map(listProjects().map(project => [project.id, project]));
  const packets = knownPackets ?? new Map([
    ...listMissionRegistryEntries({ includeArchived: true }).flatMap(entry => entry.mission.packets),
    ...currentMissionState().packets,
  ].map(packet => [packet.id, packet]));
  const project = (id: unknown): ProjectThread['project'] => {
    if (typeof id !== 'string' || !id || id.trim() !== id) return null;
    const candidates = ledger.projects.filter(candidate => candidate.id === id || candidate.sqliteProjectId === id);
    if (candidates.length !== 1) return null;
    const match = candidates[0];
    return { id, panelProjectId: match.id, name: match.name,
      slug: projects.get(match.sqliteProjectId ?? id)?.slug ?? '', mainRepo: null, currentRepo: null, relatedRepos: [] };
  };
  const sameRepo = (left: string | null | undefined, right: string | null) => Boolean(left && right
    && normalizeAgentBusRepoPath(left) === normalizeAgentBusRepoPath(right));
  const targetProject = (target: ThreadTarget): ProjectThread['project'] => {
    const identities: NonNullable<ProjectThread['project']>[] = [];
    const remember = (id: unknown) => {
      if (id == null) return true;
      const identity = project(id);
      if (!identity) return false;
      identities.push(identity); return true;
    };
    const lane = target.laneId ? getLane(target.laneId) : null;
    if (target.laneId && (!lane || !sameRepo(lane.repoPath, target.repoPath)
      || target.sessionKey && target.sessionKey !== lane.sessionKey || !remember(lane.projectId))) return null;
    if (target.packetId) {
      if (lane && lane.packetId !== target.packetId) return null;
      const packet = packets.get(target.packetId);
      if (!packet && !lane) return null;
      if (packet && ((!lane && !sameRepo(packet.workspaceTargetPath, target.repoPath)) || !remember(packet.projectId))) return null;
    }
    if (target.threadId) {
      const history = readPersistedLlmChat(target.threadId)?.history;
      const identity = project((history as { projectId?: unknown } | undefined)?.projectId);
      if (!history || !sameRepo(history.repoPath, target.repoPath) || !identity) return null;
      identities.push(identity);
    }
    return identities.length && identities.every(identity => identity.panelProjectId === identities[0].panelProjectId) ? identities[0] : null;
  };
  return { project, targetProject };
}
