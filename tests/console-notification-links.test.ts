import { expect, it, vi } from 'vitest';
import type { PushPayload } from '@/lib/push/send';

const send = vi.hoisted(() => vi.fn(async (_subscription: unknown, _payload: PushPayload) => ({
  endpoint: 'https://push.invalid/subscription', ok: true, status: 201,
})));
vi.mock('@/lib/push/send', () => ({ sendPushToSubscription: send }));
vi.mock('@/lib/push/store', () => ({ listPushSubscriptions: () => [{ endpoint: 'https://push.invalid/subscription' }] }));
vi.mock('@/lib/push/push-gate', () => ({ recordPushGate: vi.fn() }));

const notify = await import('@/lib/push/notify');
const { createReviewReadyCoalescer } = await import('@/lib/push/review-ready-coalescer');
const { POST } = await import('@/app/api/mobile/push/test/route');

it('delivers event metadata without links to the removed console', async () => {
  notify.notifyApprovalCreated({ approvalId: 'approval-fixture', title: 'Review requested' });
  notify.notifyAgentFinished({ sessionName: 'session-fixture', state: 'completed' });
  notify.notifyMergeConflict({ repo: 'repo-fixture', fileCount: 1 });
  notify.notifyOrchestratorReady({ threadId: 'thread-fixture' });
  notify.notifyReviewReady({ laneId: 'lane-fixture', label: 'Review ready' });
  const coalescer = createReviewReadyCoalescer({ schedule: () => {}, shouldDeliver: () => true });
  coalescer.enqueue({ laneId: 'lane-fixture', label: 'Review ready' });
  coalescer.flush();
  const response = await POST();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, delivered: 1, failed: 0, total: 1 });
  const payloads = send.mock.calls.map(([, payload]) => payload);
  expect(payloads.map(payload => payload.data?.kind)).toEqual([
    'approval', 'agent', 'conflict', 'orchestrator', 'review-ready', 'review-ready', 'test',
  ]);
  for (const payload of payloads) expect(payload).not.toHaveProperty('url');
});
