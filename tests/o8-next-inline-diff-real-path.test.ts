import { realpathSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeInlineHost, startInlineHost } from '../scripts/next/surfaces/inline-host-fixture';
let fixture: Awaited<ReturnType<typeof startInlineHost>>;
let heldFixture: Promise<Awaited<ReturnType<typeof startInlineHost>>> | undefined;
let origin = '';
let workspace = '';
const token = 'fixture-inline-operator';
beforeAll(async () => {
  fixture = await startInlineHost(['--inline', '--inline-ready-fail-first'], token);
  origin = fixture.origin;
  const data = await (await request('/api/mobile/orchestrator/threads')).json() as { threads: Array<{ repoPath: string }> };
  workspace = realpathSync(data.threads[0].repoPath);
}, 210_000);
afterAll(async () => {
  if (fixture) await closeInlineHost(fixture.host);
  if (heldFixture) await closeInlineHost((await heldFixture).host);
});
function heldHost() { return heldFixture ??= startInlineHost(['--inline', '--inline-held'], token); }
async function heldRequest(path: string, body?: object, credential = token) {
  const held = await heldHost();
  return fetch(held.origin + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${credential}`, 'content-type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function heldApproval() {
  const before = await (await heldRequest('/api/orchestrator/inline-fixture-log')).json() as { held: { head: string; baseHead: string } };
  const merge = await heldRequest('/api/orchestrator/merge', { packetId: 'next-inline', expectedHeadSha: before.held.head,
    idempotencyKey: 'fixture-held-auth' });
  const receipt = await merge.json() as { result: { approvalId: string } };
  expect(receipt.result.approvalId).toBeTruthy();
  return { before, id: receipt.result.approvalId };
}
function request(path: string, body?: object, credential = token) {
  return fetch(origin + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${credential}`, 'content-type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it('reads real worktree hunks and preserves authentication and revision refusals', async () => {
  expect(await (await request('/api/orchestrator/inline-fixture-log')).json()).toMatchObject({ readinessAttempts: 2 });
  const path = '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: workspace, baseBranch: 'main' });
  const response = await request(path); expect(response.status).toBe(200);
  const data = await response.json() as { diff: string; headSha: string; truncated: boolean };
  expect(data.diff).toContain('@@'); expect(data.headSha).toMatch(/^[a-f0-9]{40}$/); expect(data.truncated).toBe(false);
  expect((await request(path, undefined, 'fixture-invalid')).status).toBe(401);
  expect((await request(path + '&headSha=' + '0'.repeat(40))).status).toBe(409);
});
it('uses the production merge route and its body/idempotency refusals', async () => {
  expect((await request('/api/orchestrator/merge', {})).status).toBe(400);
  expect((await request('/api/orchestrator/merge', { packetId: 'next-inline' })).status).toBe(400);
  expect((await request('/api/orchestrator/merge', { packetId: 'next-inline', idempotencyKey: 'fixture-inline-decision' }, 'fixture-invalid')).status).toBe(401);
});

it('bounds binary/large diffs and refuses selected-path escapes without reading a symlink target', async () => {
  const canary = ['owned', 'inline-boundary', 'canary'].join('-');
  const outside = join(workspace, '..', 'outside-diff.txt'); writeFileSync(outside, canary);
  const link = join(workspace, 'outside-link.txt'); symlinkSync(outside, link);
  const base = '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: workspace, baseBranch: 'main' });
  for (const file of ['../outside-diff.txt', outside]) expect((await request(base + '&' + new URLSearchParams({ file }))).ok).toBe(false);
  const linked = await request(base + '&file=outside-link.txt'); expect(await linked.text()).not.toContain(canary);
  unlinkSync(link);
  writeFileSync(join(workspace, 'binary.dat'), Buffer.from([0, 0xff, 0xfe]));
  const binary = await (await request(base + '&file=binary.dat')).json() as { diff: string };
  expect(binary.diff).toContain('Binary');
  writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
  const large = await (await request(base + '&file=large.txt')).json() as { diff: string; truncated: boolean };
  expect(large.truncated).toBe(true); expect(large.diff.length).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it('keeps held-approval confirmation behind the production operator-token gate', async () => {
  const { before, id } = await heldApproval();
  const denied = await heldRequest('/api/panel/approvals', { action: 'approve', id }, 'fixture-invalid');
  expect(denied.status).toBe(401);
  expect(await (await heldRequest('/api/orchestrator/inline-fixture-log')).json()).toMatchObject({
    confirmation: null, held: { currentBase: before.held.baseHead, approval: { id, status: 'pending' } },
  });
}, 210_000);

it('posts an ordinary held Confirm exactly once for its original approval through the production route', async () => {
  const { before, id } = await heldApproval();
  const review = await (await heldRequest('/api/orchestrator/review-state?' + new URLSearchParams({
    packetId: 'next-inline', spoken: '1', approvalId: id,
  }))).json() as { spokenReview: { evidence: { headSha: string; fingerprint: string; governanceFingerprint: string } } };
  const evidence = review.spokenReview.evidence;
  const response = await heldRequest('/api/panel/approvals', { action: 'approve', id, spokenReviewEvidence: {
    approvalId: id, packetId: 'next-inline', reviewedHeadSha: evidence.headSha,
    reviewedDiffFingerprint: evidence.fingerprint, reviewedGovernanceFingerprint: evidence.governanceFingerprint,
  } });
  expect(response.status).toBe(200);
  const log = await (await heldRequest('/api/orchestrator/inline-fixture-log')).json() as { requests: string[] };
  expect(log.requests.filter(path => path === 'POST /api/panel/approvals')).toHaveLength(1);
  expect(log).toMatchObject({ confirmation: id, held: { currentBase: before.held.head,
    approval: { id, status: 'approved', continuationStatus: 'completed' } } });
}, 210_000);
