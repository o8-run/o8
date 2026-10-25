import 'server-only';
import { realpath } from 'node:fs/promises';
import { laneGit } from '@/lib/lane/lane-git';
import { listLanes } from '@/lib/lane/registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { listPullRequestContext } from '@/lib/orchestrator/pull-request-context';
import { parseGithubRemoteIdentity } from '@/lib/repos/github-identity';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

/** Repository/PR identity is independent of the workspace displaying it. */
export async function prMergeMembership(repo: string, pr: { number: number; headRefName: string; headRepoFullName?: string | null;
  githubIdentity?: { repositoryId: number; pullRequestId: number } }) {
  const target = repo.toLowerCase();
  const lanes = listLanes();
  const missions = [...listMissionRegistryEntries({ includeArchived: true, strict: true }).map(e => e.mission), readOrchestratorControlPlaneState({ strict: true })];
  const paths = new Map<string, Promise<string | null>>();
  const repositories = new Map<string, Promise<string | null>>();
  const identity = (path: string | null | undefined): Promise<string | null> => {
    if (!path) return Promise.resolve(null);
    if (!paths.has(path)) paths.set(path, (async () => {
      try {
        const cwd = await realpath(path);
        const common = (await laneGit(cwd, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
        const key = await realpath(common);
        if (!repositories.has(key)) repositories.set(key, (async () => {
          const remote = (await laneGit(cwd, cwd, ['remote', 'get-url', 'origin'])).stdout.trim();
          const parsed = parseGithubRemoteIdentity(remote);
          return parsed.githubOwner && parsed.githubRepo ? `${parsed.githubOwner}/${parsed.githubRepo}`.toLowerCase() : null;
        })());
        return await repositories.get(key)!;
      } catch { return null; }
    })());
    return paths.get(path)!;
  };
  const sameRepo = async (candidates: Array<string | null | undefined>) => {
    const known = await Promise.all(candidates.map(identity));
    const identified = known.filter((s): s is string => s !== null);
    if (!identified.length || (identified.includes(target) && identified.some(s => s !== target))) return 'unknown';
    return identified.includes(target) ? 'match' : 'other';
  };
  const deliveries = new Set<string>();
  const deliveryLanes = new Set<string>();
  if (pr.githubIdentity) {
    let after = 0;
    for (;;) {
      const page = listPullRequestContext({ host: 'github.com', ...pr.githubIdentity, number: pr.number }, { after, limit: 200 });
      for (const link of page.links) if (link.kind === 'delivery' && link.source === 'packet') {
        if (link.packetId) deliveries.add(link.packetId);
        if (link.laneId) deliveryLanes.add(link.laneId);
      }
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
  }
  const packets = new Map<string, OrchestratorPacket[]>();
  const unresolved = new Set<string>();
  const explicitByPacket = new Map<string, Set<number>>();
  const sameHeadRepo = pr.headRepoFullName?.toLowerCase() === target;
  for (const mission of missions) for (const packet of mission.packets) {
    const bound = lanes.filter(l => l.packetId === packet.id);
    const explicit = [packet.reviewSource?.pullRequest, packet.repairSource?.pullRequest, ...bound.map(l => l.prNumber)]
      .filter((n): n is number => typeof n === 'number');
    explicitByPacket.set(packet.id, new Set([...(explicitByPacket.get(packet.id) ?? []), ...explicit]));
    if (deliveries.has(packet.id)) { packets.set(packet.id, [...(packets.get(packet.id) ?? []), packet]); continue; }
    if (!explicit.includes(pr.number) && (explicit.length || !sameHeadRepo || packet.branchTarget !== pr.headRefName)) continue;
    // Multi-repository missions use the packet target, never the mission's unrelated primary repository.
    const relation = await sameRepo([packet.workspaceTargetPath || mission.repoPath]);
    if (relation === 'unknown') unresolved.add(packet.id);
    if (relation === 'match') packets.set(packet.id, [...(packets.get(packet.id) ?? []), packet]);
  }
  const matchingLanes = [];
  for (const lane of lanes) {
    let matches = deliveryLanes.has(lane.id) || Boolean(lane.packetId && packets.has(lane.packetId));
    const explicit = lane.packetId ? explicitByPacket.get(lane.packetId) : undefined;
    const plausible = lane.prNumber === pr.number || (lane.prNumber === null && !explicit?.size && sameHeadRepo && lane.branch === pr.headRefName);
    if (!matches && plausible) {
      const relation = await sameRepo([lane.repoPath, lane.worktreePath]);
      if (relation === 'unknown') unresolved.add(lane.id);
      matches = relation === 'match';
    }
    if (matches) {
      matchingLanes.push(lane);
      if (lane.packetId && !packets.has(lane.packetId)) packets.set(lane.packetId, []);
    }
  }
  for (const id of deliveries) if (!packets.has(id)) packets.set(id, []);
  return { packets: [...packets].sort(([a], [b]) => a.localeCompare(b)), lanes: matchingLanes.sort((a, b) => a.id.localeCompare(b.id)), unresolved: [...unresolved].sort() };
}
