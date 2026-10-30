import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Lane } from '@/lib/lane/types';

const h = vi.hoisted(() => ({
  lane: undefined as Lane | undefined,
  claimAvailable: true,
  reviewerPrompts: [] as string[],
  markReviewCompleted: vi.fn(),
}));

vi.mock('@/lib/lane/review-drain-recovery', () => ({
  claimNextReview: vi.fn(() => {
    if (!h.claimAvailable || !h.lane) return null;
    h.claimAvailable = false;
    return {
      id: 'review-completeness-trace',
      lane_id: h.lane.id,
      repo_path: h.lane.repoPath,
      attempts: 0,
      head_sha: null,
      claim_owner: 'claim-completeness-trace',
    };
  }),
  isReviewClaimCurrent: vi.fn(() => true),
  runReviewRecoveryPass: vi.fn(async () => {}),
}));

vi.mock('@/lib/lane/review-queue-settlement', () => ({
  MAX_REVIEW_ATTEMPTS: 5,
  markReviewCompleted: h.markReviewCompleted,
  markReviewDeferred: vi.fn(),
  markReviewFailed: vi.fn(),
  markReviewSkipped: vi.fn(),
}));

vi.mock('@/lib/lane/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/registry')>();
  return {
    ...actual,
    appendEvent: vi.fn(),
    getLane: vi.fn(() => h.lane),
    getLatestLaneReviewScreenshot: vi.fn(() => null),
  };
});

vi.mock('@/lib/lane/merge-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/merge-gate')>();
  return {
    ...actual,
    runMergeGate: vi.fn(async () => ({ passed: true, violations: [] })),
  };
});

vi.mock('@/lib/lane/lane-diff-facts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/lane-diff-facts')>();
  return {
    ...actual,
    getLaneDiffFacts: vi.fn(() => ({
      changedFiles: ['src/lib/example.ts'],
      addedLines: [],
      addedDiffLines: [],
    })),
  };
});

vi.mock('@/lib/lane/review-quota-fallback', () => ({
  runReviewerTurnWithQuotaFallback: vi.fn(async (input: {
    prompt: string | ((backendId: 'claude') => string);
  }) => {
    h.reviewerPrompts.push(
      typeof input.prompt === 'function' ? input.prompt('claude') : input.prompt,
    );
    return {
      ok: true,
      backend: 'claude' as const,
      text: 'Reviewed without blocking findings.',
      errors: [],
      fallback: null,
      reviewTurnId: 'turn-completeness-trace',
    };
  }),
}));

vi.mock('@/lib/lane/packet-explainer-queue', () => ({
  drainPacketExplainerQueue: vi.fn(async () => {}),
  enqueuePacketExplainer: vi.fn(async () => {}),
  notifyCorrectnessReviewQueued: vi.fn(),
  startPacketExplainerQueueDrain: vi.fn(() => () => {}),
}));

const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const { buildBlindSecondPassPrompt } = await import('@/lib/lane/blind-second-pass-review');

function laneFixture(): Lane {
  const now = new Date().toISOString();
  return {
    id: 'lane-completeness-trace',
    projectId: null,
    label: 'review completeness trace fixture',
    repoPath: process.cwd(),
    worktreePath: process.cwd(),
    branch: 'fix/review-completeness-trace',
    baseBranch: 'origin/main',
    runtime: 'claude-code',
    sessionKey: null,
    packetId: null,
    prNumber: null,
    status: 'reviewing',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
    lastEventAt: null,
    lastEventLabel: null,
  };
}

beforeEach(() => {
  h.lane = laneFixture();
  h.claimAvailable = true;
  h.reviewerPrompts.length = 0;
  h.markReviewCompleted.mockClear();
});

describe('review completeness trace through lane prompt entry points', () => {
  it('assembles the auto-review prompt through the production queue drain', async () => {
    await drainReviewQueue();

    expect(h.reviewerPrompts).toHaveLength(1);
    expect(h.reviewerPrompts[0]).toContain(
      'COMPLETENESS trace - when the change establishes or restores an invariant',
    );
    expect(h.reviewerPrompts[0]).toContain(
      '`SITE: <file:line> covered=<yes|no> evidence=<file:line|reason>`',
    );
    expect(h.reviewerPrompts[0]).toContain('or any COMPLETENESS site is uncovered');
    expect(h.reviewerPrompts[0]).toContain(
      'list every uncovered `SITE:` line in the request-changes findings',
    );
    expect(h.markReviewCompleted).toHaveBeenCalledOnce();
  });

  it('assembles the blind second-pass prompt through its lane-level builder', () => {
    const lane = laneFixture();
    const prompt = buildBlindSecondPassPrompt(
      lane,
      {
        summary: 'One production path changed.',
        changedFiles: ['src/lib/example.ts'],
        addedLines: [],
        cwd: lane.worktreePath || lane.repoPath,
      },
      ['review protocol changed'],
    );

    expect(prompt).toContain(
      'COMPLETENESS trace - when the change establishes or restores an invariant',
    );
    expect(prompt).toContain(
      '`SITE: <file:line> covered=<yes|no> evidence=<file:line|reason>`',
    );
    expect(prompt).toContain('every COMPLETENESS site is covered');
  });
});
