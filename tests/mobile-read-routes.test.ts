import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/inbox/parked-workspaces', () => ({ createParkedWorkspaceContext: () => ({}), parkedWorkspaceProjection: () => ({}) }));
vi.mock('@/lib/inbox/preferences', () => ({ legacyInboxPin: () => null }));
vi.mock('@/lib/inbox/store', () => ({ inboxSubject: () => ({}), inboxProjection: () => ({}), inboxRunStartedAt: () => '2026-01-01T00:00:00Z' }));
vi.mock('@/lib/mobile/machine-name', () => ({ localMachineName: () => 'Studio iMac' }));
vi.mock('@/lib/repos/thread-git-context', () => ({ threadGitContext: () => ({}) }));
vi.mock('@/lib/mobile/orchestrator-thread-project', () => ({ OrchestratorThreadProjectError: class extends Error {} }));
vi.mock('@/lib/lane/registry', () => ({ findLaneByPacket: () => null, getLaneEvents: () => [] }));
vi.mock('@/lib/orchestrator/control-plane', () => ({ syncOrchestratorControlPlaneState: async () => ({ updatedAt: '2026-01-01', packets: [{ id: 'packet-one', orchestratorThreadId: 'thoughts-one', title: 'Worker', status: 'awaiting_review', workspaceTargetPath: '/repo', releaseState: 'released', review: { approved: false } }] }) }));

const h = vi.hoisted(() => ({
  closed: false,
  threads: [{ id: 'thoughts-one', lastMessageAt: '2026-01-01', status: 'busy' }],
  links: [{ repositoryFullName: 'org/repo', number: 7, threadId: 'thoughts-one' }],
  capacity: { generatedAt: 1000, capacities: [{ runtime: 'agent', identityId: 'private-id', buckets: [{ label: 'Weekly', usedRatio: 0.25, resetsAt: '2026-01-02' }], account: { organization: 'Team', email: 'hidden@example.test', resetsLeft: 2, credits: { amount: 3, currency: 'USD', secret: 'hidden' }, extraUsage: { used: { amount: 1, currency: null } } } }] },
}));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({ listMobileOrchestratorThreads: () => h.threads, listArchivedOrchestratorThreadIds: () => [], createMobileOrchestratorThread: vi.fn() }));
vi.mock('@/lib/orchestrator/pull-request-context', () => ({ listPullRequestContext: () => ({ links: h.links, nextCursor: null }) }));
vi.mock('@/lib/github-broker', () => ({ fetchGitHubPullRequestDetail: vi.fn(async () => ({ number: 7, title: 'Change', state: h.closed ? 'closed' : 'open', draft: true, inMergeQueue: false, updatedAt: '2026-01-01', changedFiles: 4, body: 'private', statusCheckRollup: [{ name: 'Lint', status: 'completed', conclusion: 'failure' }, { name: 'Test', status: 'completed', conclusion: 'success' }, { name: 'Build', status: 'queued', conclusion: null }] })) }));
vi.mock('@/lib/runtime/capacity-service', () => ({ getRuntimeCapacityControlSnapshot: async () => h.capacity }));
const dir = mkdtempSync(join(tmpdir(), 'o8-mobile-read-'));
process.env.CORTEX_IDE_DATA_DIR = dir;
const token = 'mobile-read-device-fixture';
writeFileSync(join(dir, 'mobile-device-tokens'), createHash('sha256').update(token).digest('hex') + '\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const { panelGateMiddleware } = await import('@/middleware');
const prs = await import('@/app/api/mobile/pull-requests/route');
const usage = await import('@/app/api/mobile/usage/route');
const threads = await import('@/app/api/mobile/orchestrator/threads/route');
const packets = await import('@/app/api/mobile/orchestrator/packets/route');
function request(path: string, bearer = token, method = 'GET') {
  return new NextRequest(`http://localhost:3001${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'x-o8-client-addr': '198.51.100.2' } });
}
describe('paired mobile read routes through the real gate', () => {
  it.each(['/api/mobile/pull-requests', '/api/mobile/usage'])('limits %s to authenticated GET', path => {
    expect(panelGateMiddleware(request(path)).status).toBe(200);
    expect(panelGateMiddleware(request(path, '')).status).toBe(401);
    expect(panelGateMiddleware(request(path, 'revoked-device')).status).toBe(401);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) expect(panelGateMiddleware(request(path, token, method)).status).toBe(403);
  });
  it.each(['/api/panel/prs', '/api/runtime/capacity', '/api/orchestrator/state'])('preserves operator-only %s', path => {
    expect(panelGateMiddleware(request(path)).status).toBe(403);
  });
  it('refuses a formerly active device after durable revocation', () => {
    const path = '/api/mobile/usage';
    expect(panelGateMiddleware(request(path)).status).toBe(200);
    writeFileSync(join(dir, 'mobile-device-tokens'), '');
    expect(panelGateMiddleware(request(path)).status).toBe(401);
    writeFileSync(join(dir, 'mobile-device-tokens'), createHash('sha256').update(token).digest('hex') + '\n');
  });
  it('returns only linked PR display facts and checks', async () => {
    const req = request('/api/mobile/pull-requests');
    expect(panelGateMiddleware(req).status).toBe(200);
    const body = await (await prs.GET(req)).json();
    expect(body.pullRequests).toEqual([{ repository: 'org/repo', number: 7, title: 'Change', state: h.closed ? 'closed' : 'open', draft: true, mergeQueueState: false, checks: { passing: 1, failing: 1, pending: 1, failingNames: ['Lint'] }, threadId: 'thoughts-one', updatedAt: '2026-01-01' }]);
    expect(body.updatedAt).toBeDefined();
  });
  it('does not return closed PRs or accept arbitrary repository selectors', async () => {
    h.closed = true;
    const body = await (await prs.GET(request('/api/mobile/pull-requests?repo=other/private'))).json();
    expect(body.pullRequests).toEqual([]);
    h.closed = false;
  });
  it('adds thread display facts and omits absent facts', async () => {
    const req = request('/api/mobile/orchestrator/threads');
    expect(panelGateMiddleware(req).status).toBe(200);
    const body = await (await threads.GET(req)).json();
    expect(body.threads[0]).toMatchObject({ machineDisplayName: 'Studio iMac', runStartedAt: '2026-01-01T00:00:00Z', pullRequestNumber: 7, pullRequestState: 'open', changeCount: 4 });
    h.links = [];
    h.threads[0].status = 'idle';
    const missing = await (await threads.GET(req)).json();
    expect(missing.threads[0]).not.toHaveProperty('pullRequestNumber');
    expect(missing.threads[0]).not.toHaveProperty('changeCount');
    expect(missing.threads[0]).not.toHaveProperty('runStartedAt');
    h.links = [{ repositoryFullName: 'org/repo', number: 7, threadId: 'thoughts-one' }];
  });
  it('exposes the packet join without exposing internal packet payloads', async () => {
    const req = request('/api/mobile/orchestrator/packets?repoPath=/repo');
    expect(panelGateMiddleware(req).status).toBe(200);
    const body = await (await packets.GET(req)).json();
    expect(body.agents[0]).toMatchObject({ orchestratorThreadId: 'thoughts-one', packetStatus: 'awaiting_review', outcome: 'merged', workerLabel: 'Worker', rejected: true });
    expect(body.updatedAt).toBe('2026-01-01');
    expect((await (await packets.GET(request('/api/mobile/orchestrator/packets?repoPath=/other'))).json()).agents).toEqual([]);
  });
  it('projects usage without private ids, email or unknown nested values', async () => {
    const req = request('/api/mobile/usage');
    expect(panelGateMiddleware(req).status).toBe(200);
    const body = await (await usage.GET(req)).json();
    expect(body.accounts[0]).toMatchObject({ runtime: 'agent', windows: [{ label: 'Weekly', percentUsed: 25, resetsAt: '2026-01-02' }], account: { organization: 'Team', resetsLeft: 2, credits: { amount: 3, currency: 'USD' }, extraUsage: { used: { amount: 1, currency: null } } } });
    const again = await (await usage.GET(req)).json();
    expect(again).toEqual(body);
    expect(JSON.stringify(body)).not.toMatch(/email|hidden|private-id|secret/);
  });
});
