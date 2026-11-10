import { writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

const laneId = process.env.O8_TEST_MERGE_LANE_ID;
const resultPath = process.env.O8_TEST_MERGE_RESULT_PATH;
const slowFirstPushMs = Number(process.env.O8_TEST_SLOW_FIRST_PUSH_MS ?? 0);

describe.skipIf(!laneId || !resultPath)('worktree-side merge child', () => {
  it('runs the actual merge entry point in a separate process', async () => {
    const { getLane } = await import('@/lib/lane/registry');
    const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
    if (slowFirstPushMs > 0) {
      // Holds the repo-tree lease, as a slow first push would.
      const mergeGit = await import('@/lib/lane/worktree-merge-git');
      const publishWorkerBranch = mergeGit.pushWorkerBranchBestEffort;
      vi.spyOn(mergeGit, 'pushWorkerBranchBestEffort').mockImplementationOnce(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, slowFirstPushMs));
        return publishWorkerBranch(...args);
      });
    }
    const lane = getLane(laneId!);
    expect(lane).not.toBeNull();
    const result = await performWorktreeSideMerge({
      lane: lane!,
      command: {
        verb: 'merge',
        laneId: laneId!,
        actor: 'system',
        orchestratorReviewed: true,
      },
      actor: 'system',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval: async (_lane, _actor, input) => ({
        ok: false,
        laneId: laneId!,
        note: input.note,
      }),
    });
    writeFileSync(resultPath!, JSON.stringify(result));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  }, 30_000);
});
