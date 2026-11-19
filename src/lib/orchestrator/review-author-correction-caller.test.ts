import { beforeEach, expect, it, vi } from 'vitest';

// Pins the real upstream caller's request shape: review-author handoffs carry
// admission callbacks and must never ask for a merge hold. In native mode a
// callback-carrying merge hold is refused (worker-corrections), so a future
// `holdMerges: true` here would break every author handoff.
const { correctWorkers } = vi.hoisted(() => ({ correctWorkers: vi.fn(async () => ({ id: 'receipt' })) }));
const sha = 'a'.repeat(40);
const packet = {
  id: 'pkt-review', orchestratorThreadId: 'thoughts-review', workspaceTargetPath: '/fixture/repo',
  launchContext: { workMode: 'edit' }, review: {
    auditApprovalId: 'approval-1', approved: false, reviewedHeadSha: sha,
    findings: [{ file: 'answer.txt', description: 'Preserve the original request.', resolution: 'deferred', severity: 'note' }],
  },
};
const lane = { ownership: 'managed', sessionKey: 'codex-owned:author', status: 'reviewing', repoPath: '/fixture/repo', worktreePath: '/fixture/wt' };
vi.mock('@/lib/runtime/owner-context', () => ({ runtimeOwnerRequired: () => false }));
vi.mock('@/lib/cortex/owner-process', () => ({ isNativeCortexReader: () => true }));
vi.mock('@/lib/orchestrator/operator-mission-service/steer-owner-client', () => ({ callSteerOwner: vi.fn() }));
vi.mock('@/lib/db', () => ({ getSqlite: () => ({ prepare: () => ({ get: () => ({ count: 0 }) }) }) }));
vi.mock('@/lib/approvals/store', () => ({ getApproval: () => ({ status: 'rejected', toolName: 'orchestrator_review',
  args: { packetId: 'pkt-review', approved: false, reviewTurnOutcome: 'completed', reviewedHeadSha: sha } }) }));
vi.mock('@/lib/lane/registry', () => ({ findLaneByPacket: () => lane }));
vi.mock('@/lib/lane/lane-git', () => ({ laneGitSync: (_cwd: string, _repo: string, args: string[]) => (args[0] === 'rev-parse' ? sha : '') }));
vi.mock('@/lib/lane/packet-stop-hold', () => ({ packetSteerHoldReason: () => null }));
vi.mock('./composer-queue', () => ({ validateComposerQueueTarget: (input: { repoPath: string; threadId: string }) => ({ repoPath: input.repoPath, threadId: input.threadId }) }));
vi.mock('./control-plane', () => ({ readOrchestratorControlPlaneState: () => ({ packets: [packet] }) }));
vi.mock('./mission-registry', () => ({ findMissionRegistryEntryByPacketId: () => null }));
vi.mock('./lifecycle-mutation-lock', () => ({ withPacketLifecycleMutationLock: (_id: string, run: () => unknown) => run() }));
vi.mock('./pr-repair-owner', () => ({ samePrRepairRepo: () => true }));
vi.mock('./worker-corrections', () => ({ correctWorkers, listCorrectableWorkers: vi.fn(), readWorkerCorrection: () => null }));
vi.mock('./correction-review', () => ({ saveCorrectionReviewSource: vi.fn() }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async () => null }));

const { correctAuthorFromReview } = await import('./review-author-correction');

beforeEach(() => correctWorkers.mockClear());

it('hands review findings to the author without a merge hold, carrying admission callbacks', async () => {
  await correctAuthorFromReview({ repoPath: '/fixture/repo', threadId: 'thoughts-review',
    review: { packetId: 'pkt-review', approvalId: 'approval-1', reviewedHeadSha: sha, surfaceId: 'codex-owned:author', runId: 'run-1' } });
  expect(correctWorkers).toHaveBeenCalledOnce();
  const [request, checks] = correctWorkers.mock.calls[0] as unknown as [{ payload: { holdMerges: boolean; mode: string; targets: unknown[] } }, Record<string, unknown>];
  expect(request.payload.holdMerges).toBe(false);
  expect(request.payload.mode).toBe('send');
  expect(request.payload.targets).toEqual([{ surfaceId: 'codex-owned:author', runId: 'run-1' }]);
  expect(checks).toMatchObject({ code: expect.any(Function), state: expect.any(Function), persist: expect.any(Function) });
});
