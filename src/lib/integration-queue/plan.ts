import 'server-only';
import { realpath, stat } from 'node:fs/promises';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';
import { getLane, findLaneByPacket } from '@/lib/lane/registry';
import { readEffectivePolicy } from '@/lib/lane/effective-policy-read';
import { laneGit } from '@/lib/lane/lane-git';
import { readExternalReview } from '@/lib/tasks/external-review-store';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { detectFileOverlaps, recommendMergeOrder } from '@/lib/worktree/conflicts';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { Lane } from '@/lib/lane/types';
import { hashInputs } from './store';
import type { QueueEntry, QueuePlan, QueueSpec } from './types';

export type QueueSources = Map<string, Lane>;
export async function queueGit(cwd: string, args: string[], repoPath = cwd) {
  return (await laneGit(cwd, repoPath, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}
export async function buildQueuePlan(repoId: string, repoPath: string, spec: QueueSpec): Promise<{ plan: QueuePlan; sources: QueueSources }> {
  const sources: QueueSources = new Map();
  const ancestors = new Map<string, Set<string>>();
  const plan: QueuePlan = { repoId, targetRef: spec.targetRef, targetSha: null, entries: [], order: [], blockers: [], inputHash: '' };
  try {
    await queueGit(repoPath, ['check-ref-format', spec.targetRef]);
    plan.targetSha = await queueGit(repoPath, ['rev-parse', '--verify', `${spec.targetRef}^{commit}`]);
  } catch { plan.blockers.push('The target revision is unreadable. Refresh the local target and inspect it.'); }
  // Active packets take precedence over historical copies. Unknown dependencies
  // never acquire completion from another repository or an ambient mission.
  const packets = new Map(listMissionRegistryEntries({ includeArchived: true }).flatMap(entry => entry.mission.packets).map(packet => [packet.id, packet]));
  for (const packet of readOrchestratorControlPlaneState().packets) packets.set(packet.id, packet);
  for (const change of spec.changes) {
    const entry: QueueEntry = { id: change.id, laneId: null, packetId: null, headSha: null, comparisonSha: null, revisionId: null,
      declaredDependencies: [...change.dependsOn], detectedDependencies: [], satisfiedDependencies: [], overlapDependencies: [], files: [], blockers: [], policy: null };
    plan.entries.push(entry);
    try {
      const external = change.id.startsWith('external-pr-') ? readExternalReview(change.id) : null;
      const lane = getLane(change.id) ?? findLaneByPacket(external?.revision.packetId ?? change.id);
      if (!lane || await realpath(lane.repoPath) !== await realpath(repoPath)) throw new Error('Missing repository-owned lane');
      sources.set(change.id, lane);
      entry.laneId = lane.id; entry.packetId = lane.packetId;
      entry.revisionId = external?.revision.id ?? null;
      const packet = lane.packetId ? packets.get(lane.packetId) : null;
      if (!packet) entry.blockers.push('The accepted task and its dependency state are unavailable. Inspect the task.');
      entry.declaredDependencies.push(...(packet?.dependencyPacketIds ?? []));
      const policy = await readEffectivePolicy(lane.id);
      entry.policy = policy;
      entry.headSha = policy?.headSha ?? null;
      if (!policy?.headSha || !policy.comparisonRef) throw new Error('Unknown revision');
      if (policy.nextAction.value === 'human') entry.blockers.push(policy.nextAction.reason);
      if (external && (external.repoId !== repoId || external.revision.headSha !== policy.headSha)) {
        entry.blockers.push('The adopted PR revision and the reviewed work revision disagree. Re-adopt and review the current head.');
      }
      const cwd = lane.worktreePath || lane.repoPath;
      entry.comparisonSha = await queueGit(cwd, ['rev-parse', '--verify', `${policy.comparisonRef}^{commit}`], lane.repoPath);
      entry.files = (await laneGit(cwd, lane.repoPath, ['diff', '--no-renames', '--name-only', '-z', `${entry.comparisonSha}..${entry.headSha}`])).stdout.split('\0').filter(Boolean).sort();
      if (await queueGit(cwd, ['rev-parse', 'HEAD'], lane.repoPath) !== policy.headSha) throw new Error('Source changed during read');
    } catch {
      entry.blockers.push('Source identity, effective policy or changed paths are unreadable. An operator must inspect this task.');
      // An unknown diff can overlap anything; independent eligibility is unproven.
      plan.blockers.push(`Overlap detection is incomplete for ${change.id}. Restore its reviewed source before preparing a combination.`);
    }
  }
  const selectedHeads = new Set(plan.entries.map(entry => entry.headSha));
  for (const entry of plan.entries) {
    const lane = sources.get(entry.id);
    if (!lane || !entry.headSha) continue;
    try {
      const cwd = lane.worktreePath || lane.repoPath;
      if (await queueGit(cwd, ['rev-parse', '--is-shallow-repository'], lane.repoPath) !== 'false') throw new Error('Incomplete history');
      const history = (await queueGit(cwd, ['rev-list', '--max-count=100001', entry.headSha], lane.repoPath)).split('\n');
      if (history.length > 100000) throw new Error('Ancestry detection is incomplete');
      ancestors.set(entry.id, new Set(history.filter(sha => selectedHeads.has(sha))));
    } catch {
      plan.blockers.push(`Ancestry detection is incomplete for ${entry.id}. An operator must inspect its history.`);
    }
  }
  const aliases = new Map<string, string>();
  for (const entry of plan.entries) for (const alias of [entry.id, entry.laneId, entry.packetId]) if (alias) {
    const existing = aliases.get(alias);
    if (existing && existing !== entry.id) plan.blockers.push('A task is selected more than once through different identities. Select each task once.');
    aliases.set(alias, entry.id);
  }
  for (const entry of plan.entries) {
    entry.declaredDependencies = [...new Set(entry.declaredDependencies.map(id => aliases.get(id) ?? id))];
    for (const other of plan.entries) {
      if (entry.id === other.id || !other.headSha) continue;
      if (entry.headSha === other.headSha) {
        entry.blockers.push(`Duplicate source head with ${other.id}. Select one task for this revision.`);
      } else if (ancestors.get(entry.id)?.has(other.headSha)) entry.detectedDependencies.push(other.id);
    }
    for (const dependency of entry.declaredDependencies) if (!plan.entries.some(other => other.id === dependency)) {
      const packet = packets.get(dependency);
      const receipt = packet?.releaseStatePayload;
      let satisfied = false;
      try {
        if (packet?.releaseState === 'released' && hasCanonicalReleaseEvidence(packet) && receipt?.headSha && receipt.mergeCommit
          && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.headSha) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.mergeCommit)
          && packet.workspaceTargetPath && await realpath(packet.workspaceTargetPath) === await realpath(repoPath) && plan.targetSha) {
          await queueGit(repoPath, ['merge-base', '--is-ancestor', receipt.mergeCommit, plan.targetSha]);
          const lane = findLaneByPacket(dependency);
          const live = lane?.worktreePath && await stat(lane.worktreePath).then(() => true, error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          });
          if (live && await queueGit(lane!.worktreePath!, ['rev-parse', 'HEAD'], lane!.repoPath) !== receipt.headSha) throw new Error('Released head changed');
          entry.satisfiedDependencies.push({ id: dependency, headSha: receipt.headSha, mergeCommit: receipt.mergeCommit, source: receipt.source! });
          satisfied = true;
        }
      } catch { /* An unreadable receipt or target ancestry is not completion. */ }
      if (!satisfied) entry.blockers.push(`Unknown, unselected or unproven dependency ${dependency}. Include its reviewed task or inspect its target-pinned release receipt.`);
    }
  }
  const worktrees: WorktreeInfo[] = plan.entries.filter(entry => sources.has(entry.id)).map(entry => {
    const lane = sources.get(entry.id)!;
    return { id: entry.id, path: lane.worktreePath || lane.repoPath, branch: lane.branch, baseBranch: entry.comparisonSha ?? lane.baseBranch,
      agentType: lane.runtime, status: 'ready', createdAt: 0, lastActivityAt: 0, dirtyFiles: entry.files, claudeManaged: false };
  });
  const overlaps = detectFileOverlaps(worktrees);
  const recommendations = await recommendMergeOrder(worktrees, overlaps, async worktree => {
    const entry = plan.entries.find(item => item.id === worktree.id)!;
    const lane = sources.get(entry.id)!;
    if (!entry.comparisonSha || !entry.headSha) return 0;
    // Keep the existing ranking formula, but pin its sizes and use the same
    // hardened Git boundary as every other queue source probe.
    try {
      const stat = await queueGit(worktree.path, ['diff', '--numstat', `${entry.comparisonSha}..${entry.headSha}`], lane.repoPath);
      return stat.split('\n').reduce((sum, line) => {
        const [added, deleted] = line.split('\t');
        return sum + (Number.parseInt(added, 10) || 0) + (Number.parseInt(deleted, 10) || 0);
      }, 0);
    } catch { plan.blockers.push(`Change size is unreadable for ${entry.id}. Inspect its source before ordering overlapping work.`); return 0; }
  });
  const rank = new Map(recommendations.map(item => [item.worktreeId, item.position]));
  const priority = [...plan.entries].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.id.localeCompare(b.id));
  const dependencies = (entry: QueueEntry) => [...entry.declaredDependencies, ...entry.detectedDependencies]
    .filter(id => !entry.satisfiedDependencies.some(dependency => dependency.id === id));
  const ordered: QueueEntry[] = [];
  const visiting = new Set<string>(); const visited = new Set<string>(); const stack: QueueEntry[] = [];
  const visit = (entry: QueueEntry) => {
    if (visiting.has(entry.id)) {
      for (const cyclic of stack.slice(stack.findIndex(item => item.id === entry.id))) cyclic.blockers.push('Dependency cycle. An operator must correct the declared dependencies.');
      return;
    }
    if (visited.has(entry.id)) return;
    visiting.add(entry.id); stack.push(entry);
    for (const id of dependencies(entry)) { const parent = plan.entries.find(item => item.id === id); if (parent) visit(parent); }
    stack.pop(); visiting.delete(entry.id); visited.add(entry.id); ordered.push(entry);
  };
  priority.forEach(visit);
  // The existing overlap recommendation is a preference. Explicit and ancestry
  // dependencies win; only overlapping predecessors couple eligibility.
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    entry.overlapDependencies = ordered.slice(0, i).filter(other => overlaps.some(overlap =>
      (overlap.worktreeA === entry.id && overlap.worktreeB === other.id) || (overlap.worktreeB === entry.id && overlap.worktreeA === other.id))).map(other => other.id);
    for (const id of [...dependencies(entry), ...entry.overlapDependencies]) if (!plan.order.includes(id)) {
      entry.blockers.push(`Prerequisite ${id} is blocked; inspect its dependency, overlap and policy reasons.`);
    }
    if (!entry.blockers.length && !plan.blockers.length) plan.order.push(entry.id);
  }
  // Observation time is not an input. Everything else, including fresh policy,
  // the reviewed revision, comparison base, graph and check argv, is declared.
  plan.inputHash = hashInputs({ version: 1, spec, targetSha: plan.targetSha, order: plan.order, blockers: plan.blockers,
    entries: plan.entries.map(entry => ({ ...entry, policy: entry.policy ? { ...entry.policy, readAt: undefined } : null })) });
  return { plan, sources };
}
