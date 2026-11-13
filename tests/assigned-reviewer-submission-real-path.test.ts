import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const { POST } = await import('@/app/api/orchestrator/review/route');
const { createLane } = await import('@/lib/lane/registry');
const { mintAssignedReviewerToken } = await import('@/lib/auth/review-submission');
const { startReviewTurn, finishReviewTurn } = await import('@/lib/lane/review-turn-state');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { withControlPlaneLock, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'o8-assigned-review-')); roots.push(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'o8 test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'file.txt'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD'); const packetId = `review-${randomUUID()}`;
  await withControlPlaneLock(() => writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: repo,
    packets: [{ id: packetId, title: 'Review fixture', runtime: 'codex', workspaceTargetPath: repo, branchTarget: 'main',
      status: 'queued', queueState: 'held', holdIntent: 'explicit-dispatch', releaseState: 'pending' } as OrchestratorPacket] }));
  const lane = createLane({ repoPath: repo, branch: 'fixture', baseBranch: 'main', packetId, runtime: 'codex', label: 'Review fixture' });
  const turnId = startReviewTurn({ laneId: lane.id, threadId: `review-fixture-${randomUUID()}`, backend: 'codex', surface: 'auto-review', expectedHeadSha: head });
  const author = mintPacketWorkerToken(packetId, { processMarker: 'fixture-author-run' });
  const reviewer = mintAssignedReviewerToken(packetId, turnId);
  return { packetId, head, lane, turnId, author, reviewer };
}
function submit(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  return POST(new NextRequest('http://localhost/api/orchestrator/review', { method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${token}` },
    body: JSON.stringify({ packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, clientMutationId: randomUUID() }),
  }));
}
it('requires the assigned reviewer for the packet', async () => {
  const f = await fixture();
  const response = await submit(f, f.author);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'reviewer_assignment_required' } });
});
it('accepts the assigned reviewer through the production route', async () => {
  const f = await fixture();
  const response = await submit(f, f.reviewer);
  expect(response.status).toBe(200);
  expect((await response.json()).result).toMatchObject({ recorded: true, reviewedHeadSha: f.head });
});
it('keeps packet identity checks at the route', async () => {
  const f = await fixture();
  const response = await submit(f, mintPacketWorkerToken('another-review-fixture'));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'worker_packet_mismatch' } });
});
it('refuses a credential after its assignment ends', async () => {
  const f = await fixture();
  finishReviewTurn({ laneId: f.lane.id, reviewTurnId: f.turnId, outcome: 'completed' });
  expect((await submit(f, f.reviewer)).status).toBe(403);
});
it('refuses unavailable roles and stale assignment credentials', async () => {
  const f = await fixture();
  expect((await submit(f, '')).status).toBe(403);
  const replacement = mintAssignedReviewerToken(f.packetId, f.turnId);
  expect((await submit(f, f.reviewer)).status).toBe(403);
  expect((await submit(f, replacement)).status).toBe(200);
});
