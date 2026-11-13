import { ensureReviewQueueDrainStarted } from '@/lib/lane/review-drain-bootstrap';
import { readExternalReview } from './external-review-store';
import { resolveReviewerPrSource } from '@/lib/orchestrator/reviewer-pr-source';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { nextPacketReferenceLabel } from '@/lib/orchestrator/store';
import { dispatch } from '@/lib/lane/commands';
import { getLane, findLaneByPacket } from '@/lib/lane/registry';
import { getProjectContext } from '@/lib/projects/context';

/** One revision owns one packet and lane. Replay never substitutes a newer PR head. */
export async function startExternalReview(taskId: string) {
  const task = readExternalReview(taskId);
  if (!task) throw new Error('External review task unavailable.');
  const { revision } = task;
  return withPacketLifecycleMutationLock(revision.packetId, async () => {
    if (readExternalReview(taskId)?.revision.id !== revision.id) throw new Error('Review input changed. Refresh the task.');
    const source = await resolveReviewerPrSource({ repoPath: task.repoPath, packetId: revision.packetId, pullRequest: task.pullRequest });
    if (source.headSha !== revision.headSha) throw new Error('PR head changed. Adopt the current revision before reviewing.');
    const context = await getProjectContext({ repoPath: task.repoPath });
    const branch = `review/external-${revision.id}`;
    await withLockedState(state => {
      if (state.packets.some(p => p.id === revision.packetId)) return;
      state.packets.push({ id: revision.packetId, referenceLabel: nextPacketReferenceLabel(state.packets), projectId: context.id,
        title: `Review PR #${task.pullRequest}`, summary: revision.intendedOutcome ?? 'Intended outcome missing.',
        workspaceTargetPath: task.repoPath, branchTarget: branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
        queueState: 'held', holdIntent: 'operator', status: 'awaiting_review', releaseState: 'pending', mergeHold: true,
        reviewSource: source, workerIntent: 'reviewer', taskContractRequired: false,
        launchContext: { source: 'desktop', presentation: 'tab', repoContext: 'registered', workMode: 'read-only' }, review: null, lane: null });
    });
    let lane = findLaneByPacket(revision.packetId);
    if (!lane) {
      const opened = await dispatch({ verb: 'open_lane', repoPath: task.repoPath, projectId: context.id, branch,
        baseBranch: revision.baseSha, runtime: 'codex', label: `Review PR #${task.pullRequest}`, packetId: revision.packetId, actor: 'orchestrator' },
      { packetCreationBase: { repoPath: task.repoPath, packetId: revision.packetId, branch, baseBranch: revision.baseSha, baseCommit: revision.headSha } });
      if (!opened.ok || !opened.laneId) throw new Error('Reviewer checkout unavailable. Retry this revision after inspection.');
      lane = getLane(opened.laneId);
    }
    if (!lane) throw new Error('Reviewer lane unavailable.');
    if (readExternalReview(taskId)?.state === 'approved' || readExternalReview(taskId)?.state === 'sent_back') return readExternalReview(taskId);
    const requested = await dispatch({ verb: 'request_review', laneId: lane.id, actor: 'user' });
    if (!requested.ok) throw new Error(requested.note);
    ensureReviewQueueDrainStarted();
    return readExternalReview(taskId);
  });
}
