import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readPublication } from '@/lib/github-broker/publication-store';
import { NextRequest } from 'next/server';
import { getSqlite } from '@/lib/db';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { githubProvider } from '@/lib/git-providers/github';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST as publish } from '@/app/api/panel/prs/[number]/route';

const host = vi.hoisted(() => ({ installation: 9000, head: 'a'.repeat(40), merged: false, queue: false, queued: false,
  closed: false, failRead: false, failStateRead: false, holdFinalRead: null as (() => Promise<void>) | null, holdMutation: null as (() => Promise<void>) | null, holdStateRead: null as (() => Promise<void>) | null, lost: false, lostBeforeApply: false, raceHead: false, internalError: false, auto: false, failCheck: false, missingCheck: false, mutations: [] as Array<Record<string, unknown>>, reads: 0 }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('@/lib/github-broker/managed', () => ({ readManagedGithubToken: () => ({ installationId: host.installation, token: 'fixture', accountLogin: 'example' }), readActiveIdentity: () => 'fixture', readSignInEpoch: () => 1 }));
const approved = 'a'.repeat(40);
const mergedSha = 'c'.repeat(40);
let number = 7000;
const requestFor = (extra: Record<string, unknown> = {}, token = getOrCreateWsToken()) => {
  const body = { repo: 'example/publication', number, action: 'merge', mergeMethod: 'squash', commitSha: approved, ...extra };
  return new NextRequest(`http://localhost/api/panel/prs/${number}`, { method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
};
const post = (extra: Record<string, unknown> = {}) => {
  const body = { repo: 'example/publication', number, action: 'merge', mergeMethod: 'squash', commitSha: approved, ...extra };
  const request = new Request(`http://localhost/api/panel/prs/${number}`, { method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}` }, body: JSON.stringify(body) });
  return publish(request, { params: Promise.resolve({ number: String(number) }) });
};
beforeEach(() => {
  number++; host.installation++; Object.assign(host, { head: approved, merged: false, queue: false, queued: false, lost: false, lostBeforeApply: false, raceHead: false, internalError: false, auto: false, failCheck: false, missingCheck: false, closed: false, failRead: false, failStateRead: false, holdFinalRead: null, holdMutation: null, holdStateRead: null, mutations: [], reads: 0 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/merge') || (url.endsWith('/graphql') && body.query?.startsWith('mutation'))) {
      host.mutations.push(body);
      if (host.holdMutation) { const hold = host.holdMutation; host.holdMutation = null; await hold(); }
      if (host.raceHead) host.head = 'd'.repeat(40);
      if (host.lostBeforeApply) throw new Error('Connection lost after sending');
      if ((body.sha ?? body.variables?.input?.expectedHeadOid) !== host.head) return url.endsWith('/graphql') ? Response.json({ errors: [{ type: 'UNPROCESSABLE', message: 'Head changed' }], data: null }) : Response.json({ message: 'Head changed' }, { status: 409 });
      if (host.internalError && url.endsWith('/graphql')) return Response.json({ errors: [{ type: 'INTERNAL', message: 'Unconfirmed' }], data: null });
      if (host.queue) host.queued = true; else if (body.query?.includes('enablePullRequestAutoMerge')) host.auto = true; else host.merged = true;
      if (host.lost) throw new Error('Response lost');
      if (url.endsWith('/merge')) return Response.json({ merged: true, sha: mergedSha });
      return Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'entry' } }, enablePullRequestAutoMerge: { pullRequest: { id: 'node' } } } });
    }
    if (body.query?.includes('query PublicationState') && host.holdStateRead) { const hold = host.holdStateRead; host.holdStateRead = null; await hold(); }
    if (body.query?.includes('query PublicationState') && host.failStateRead) throw new Error('Read unavailable');
    if (body.query?.includes('query PublicationState')) return Response.json({ data: { node: { headRefOid: host.head, isInMergeQueue: host.queued, autoMergeRequest: host.auto ? { enabledAt: '2026-01-01' } : null } } });
    if (url.endsWith('/graphql')) return Response.json({ data: { repository: { mergeQueue: host.queue ? { id: 'queue' } : null, pullRequest: { isInMergeQueue: host.queued }, object: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'CheckRun', name: 'ci', isRequired: true }] } } } } } });
    if (/\/pulls\/\d+$/.test(url)) {
      host.reads++;
      if (host.failRead) throw new Error('Read unavailable');
      const response = Response.json({ id: number, node_id: 'node', number, title: 'Fixture', state: host.merged || host.closed ? 'closed' : 'open', merged: host.merged, merged_at: host.merged ? '2026-01-01' : null, merge_commit_sha: host.merged ? mergedSha : null,
        draft: false, mergeable: true, head: { sha: host.head, ref: 'work', repo: { full_name: 'example/publication' } }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 42 } } });
      if (host.reads === 2 && host.holdFinalRead) {
        const hold = host.holdFinalRead; host.holdFinalRead = null;
        const json = response.json.bind(response); response.json = async () => { await hold(); return json(); };
      }
      return response;
    }
    if (url.includes('/check-runs')) return Response.json({ total_count: host.missingCheck ? 0 : 1, check_runs: host.missingCheck ? [] : [{ name: 'ci', status: 'completed', conclusion: host.failCheck ? 'failure' : 'success' }] });
    if (url.includes('/status')) return Response.json({ state: 'success', statuses: [] });
    return Response.json([]);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('installs publication tables at database boot before a publication', () => {
  expect(getSqlite().prepare("SELECT name FROM sqlite_master WHERE name LIKE 'github_publication_%' ORDER BY name").all()).toEqual([{ name: 'github_publication_events' }, { name: 'github_publication_intents' }]);
});
it('refuses without an approved SHA before any mutation', async () => {
  const response = await post({ commitSha: undefined });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'A reviewed commit and merge method are required' });
  expect(host.mutations).toHaveLength(0);
});
it('publishes an approved head through the numbered PR route', async () => {
  expect((await post()).status).toBe(200);
  expect(host.mutations).toHaveLength(1);
  expect(host.mutations[0].sha).toBe(approved);
});
it('moved head refuses and never publishes the replacement', async () => {
  host.head = 'd'.repeat(40);
  expect((await post()).status).toBe(409);
  expect(host.mutations).toHaveLength(0);
});
it.each(['failCheck', 'missingCheck'] as const)('refuses %s', async key => {
  host[key] = true;
  expect((await post()).status).toBe(409);
  expect(host.mutations).toHaveLength(0);
});
it('reconciles a lost merge response before retry, without double publication', async () => {
  host.lost = true;
  expect((await post()).status).toBe(202);
  const reads = host.reads;
  const retry = await post();
  expect(retry.status).toBe(200);
  expect(host.reads).toBeGreaterThan(reads);
  expect(host.mutations).toHaveLength(1);
  expect(await retry.json()).toMatchObject({ publication: { status: 'merged', approvedSha: approved, mergedSha } });
});
it('enqueues with a host head pin and reports queued separately', async () => {
  host.queue = true;
  const response = await post({ action: 'enable-auto-merge' });
  expect(response.status).toBe(200);
  expect(host.mutations[0].variables).toMatchObject({ input: { expectedHeadOid: approved } });
  expect(await response.json()).toMatchObject({ publication: { status: 'queued', mergedSha: null } });
});

it('keeps an unconfirmed open outcome unknown across retries and store reads', async () => {
  host.lostBeforeApply = true;
  const first = await post();
  const before = host.reads;
  const second = await post();
  expect(host.reads).toBeGreaterThan(before);
  expect(host.mutations).toHaveLength(1);
  expect([first.status, second.status]).toEqual([202, 202]);
  const events = getSqlite().prepare('SELECT receipt FROM github_publication_events').all() as Array<{ receipt: string }>;
  expect(events.map(e => JSON.parse(e.receipt))).toContainEqual(expect.objectContaining({ number, approvedSha: approved, mergedSha: null, status: 'unknown', authorizingPrincipal: 'operator', checks: expect.any(Object) }));
});
it('host refuses a head that moves after the last read', async () => {
  host.raceHead = true;
  expect((await post()).status).toBe(409);
  expect(host.merged).toBe(false);
  expect(host.mutations).toHaveLength(1);
  expect(host.mutations[0].sha).toBe(approved);
});
it('the GitHub provider returns the same durable queue outcome', async () => {
  host.queue = true;
  expect(await githubProvider.merge('example/publication', number, { expectedHeadSha: approved, mergeMethod: 'squash' })).toMatchObject({ status: 'queued', approvedSha: approved, mergedSha: null });
  expect(host.mutations[0].variables).toMatchObject({ input: { expectedHeadOid: approved } });
});
it('concurrent route confirmations publish only once', async () => {
  const responses = await Promise.all([post(), post()]);
  expect(responses.map(r => r.status).every(s => s === 200 || s === 202)).toBe(true);
  expect(host.mutations).toHaveLength(1);
});
it('records auto-merge enabled separately and pins its host mutation', async () => {
  const response = await post({ action: 'enable-auto-merge' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ publication: { status: 'auto_merge_enabled', approvedSha: approved, mergedSha: null } });
  expect(host.mutations[0].variables).toMatchObject({ input: { expectedHeadOid: approved } });
});
it('middleware still refuses a worker before the hosting route', async () => {
  const { panelGateMiddleware } = await import('@/middleware');
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const workerToken = mintPacketWorkerToken(`worker-${number}`);
  try {
    for (const path of [`/api/panel/prs/${number}`]) {
      const request = new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { authorization: `Bearer ${workerToken}`, host: 'localhost' }, body: '{}' });
      expect(panelGateMiddleware(request).status).toBe(403);
    }
    expect(host.mutations).toHaveLength(0);
  } finally { /* Credential exists only in the isolated test data directory. */ }
});
it('retains a persisted packet hold through the numbered PR route', async () => {
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const repo = mkdtempSync(join(tmpdir(), 'o8-publication-hold-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/publication.git']);
  const id = `packet-publication-${number}`;
  await withLockedState(state => {
    state.packets.push({ id, status: 'awaiting_review', branchTarget: 'work', workspaceTargetPath: repo, mergeHold: true } as typeof state.packets[number]);
  });
  try {
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ mergeGate: { checks: expect.arrayContaining([expect.objectContaining({ name: `packet:${id}:merge-hold`, verdict: 'fail' })]) } });
    expect(host.mutations).toHaveLength(0);
  } finally {
    await withLockedState(state => { state.packets = state.packets.filter(p => p.id !== id); });
    rmSync(repo, { recursive: true, force: true });
  }
});
it('reconciles a lost queue acknowledgement without enqueuing twice', async () => {
  host.queue = true; host.lost = true;
  expect((await post({ action: 'enable-auto-merge' })).status).toBe(202);
  const response = await post({ action: 'enable-auto-merge' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ publication: { status: 'queued', approvedSha: approved, mergedSha: null } });
  expect(host.mutations).toHaveLength(1);
});

it.each([false, true])('refuses a definite GraphQL head mismatch, queue=%s', async queue => {
  host.queue = queue; host.raceHead = true;
  const response = await post({ action: 'enable-auto-merge' });
  expect(response.status).toBe(409);
  expect(host.merged).toBe(false);
  expect(host.mutations).toHaveLength(1);
  expect(host.mutations[0].variables).toMatchObject({ input: { expectedHeadOid: approved } });
});

it('keeps an indeterminate GraphQL execution error unknown without retrying the mutation', async () => {
  host.internalError = true;
  expect((await post({ action: 'enable-auto-merge' })).status).toBe(202);
  expect((await post({ action: 'enable-auto-merge' })).status).toBe(202);
  expect(host.mutations).toHaveLength(1);
});

const receipt = () => readPublication('https://api.github.com', 'example/publication', number)!;
const ageIntent = () => {
  const current = receipt();
  current.createdAt = new Date(Date.now() - 31_000).toISOString();
  getSqlite().prepare('UPDATE github_publication_intents SET receipt=? WHERE number=?').run(JSON.stringify(current), number);
};
it('settles an unknown publication after the head moves and permits a fresh decision', async () => {
  host.lostBeforeApply = true;
  expect((await post()).status).toBe(202);
  host.head = 'd'.repeat(40);
  expect((await post({ commitSha: host.head })).status).toBe(409);
  expect(receipt()).toMatchObject({ status: 'refused', reason: expect.stringContaining('head changed') });
  expect(host.mutations).toHaveLength(1);
  host.lostBeforeApply = false;
  expect((await post({ commitSha: host.head })).status).toBe(200);
  expect(host.mutations).toHaveLength(2);
});
it('settles a request that did not reach the host only after the bounded window', async () => {
  host.lostBeforeApply = true;
  expect((await post()).status).toBe(202);
  expect((await post()).status).toBe(202);
  ageIntent();
  expect((await post()).status).toBe(409);
  expect(receipt().status).toBe('refused');
  expect(host.mutations).toHaveLength(1);
  host.lostBeforeApply = false;
  expect((await post()).status).toBe(200);
  expect(host.mutations).toHaveLength(2);
});
it.each([false, true])('settles confirmed removal of deferred publication, queue=%s', async queue => {
  host.queue = queue;
  expect((await post({ action: 'enable-auto-merge' })).status).toBe(200);
  host.auto = false; host.queued = false;
  expect((await post({ action: 'enable-auto-merge' })).status).toBe(409);
  expect(receipt().status).toBe(queue ? 'refused' : 'disabled');
  expect(host.mutations).toHaveLength(1);
});
it('settles a closed unmerged pull request without another mutation', async () => {
  host.lostBeforeApply = true;
  expect((await post()).status).toBe(202);
  host.closed = true;
  expect((await post()).status).toBe(409);
  expect(receipt()).toMatchObject({ status: 'refused', mergedSha: null });
  expect(host.mutations).toHaveLength(1);
});
it.each(['unknown', 'queued', 'auto_merge_enabled'] as const)('failed reconciliation reads preserve %s evidence', async status => {
  host.queue = status === 'queued'; host.lostBeforeApply = status === 'unknown';
  await post({ action: status === 'unknown' ? 'merge' : 'enable-auto-merge' });
  const before = receipt();
  host.failRead = status === 'unknown'; host.failStateRead = status !== 'unknown';
  await post({ action: status === 'unknown' ? 'merge' : 'enable-auto-merge' });
  expect(receipt()).toEqual(before);
  expect(host.mutations).toHaveLength(1);
});
it.each([false, true])('admits missing required checks as pending for auto-merge/queue, queue=%s', async queue => {
  host.queue = queue; host.missingCheck = true;
  const response = await post({ action: queue ? 'merge' : 'enable-auto-merge' });
  expect(response.status).toBe(200);
  expect(host.mutations).toHaveLength(1);
  expect(await response.json()).toMatchObject({ publication: { status: queue ? 'queued' : 'auto_merge_enabled' } });
});
it('records the real operator principal on the numbered PR route', async () => {
  const { panelGateMiddleware } = await import('@/middleware');
  const request = requestFor({ principal: 'anonymous' });
  expect(panelGateMiddleware(request).headers.get('x-middleware-next')).toBe('1');
  const response = await publish(request, { params: Promise.resolve({ number: String(number) }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ publication: { authorizingPrincipal: 'operator' } });
});
it('refuses a device bearer at the numbered PR route', async () => {
  const { panelGateMiddleware } = await import('@/middleware');
  const token = 'hosting-device-fixture-0123456789';
  writeFileSync(join(getDataDir(), 'mobile-device-tokens'), createHash('sha256').update(token).digest('hex') + '\n');
  const request = requestFor({ principal: 'operator' }, token);
  expect(panelGateMiddleware(request).status).toBe(403);
  expect(host.mutations).toHaveLength(0);
});
it('normalizes caller SHA before gating and publication', async () => {
  const response = await post({ commitSha: approved.toUpperCase() });
  expect(response.status).toBe(200);
  expect(host.mutations[0].sha).toBe(approved);
  expect(receipt().approvedSha).toBe(approved);
});
it('records the queue method rather than a caller-selected method', async () => {
  host.queue = true;
  expect((await post()).status).toBe(200);
  expect(receipt().method).toBe('queue');
});
it('does not report an explicit merge as accepted when auto-merge is in effect', async () => {
  expect((await post({ action: 'enable-auto-merge' })).status).toBe(200);
  const response = await post();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ publication: { status: 'auto_merge_enabled', action: 'enable-auto-merge' }, error: expect.stringContaining('explicit merge was not sent') });
  expect(host.mutations).toHaveLength(1);
});
it('stores a host/installation/repository identity rather than a token-derived scope', async () => {
  expect((await post()).status).toBe(200);
  expect(receipt().scope).toBe(JSON.stringify(['https://api.github.com', host.installation, 'example/publication']));
});
it('checks the winning claim SHA when concurrent callers approved different heads', async () => {
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  host.holdFinalRead = async () => { entered(); await resumed; };
  const first = post();
  await ready;
  try {
    host.head = 'd'.repeat(40);
    expect((await post({ commitSha: host.head })).status).toBe(200);
  } finally { release(); }
  const response = await first;
  expect(response.status).toBe(409);
  expect(host.mutations).toHaveLength(1);
});

it('a late response cannot return a newer head publication as its own success', async () => {
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  host.holdMutation = async () => { entered(); await resumed; };
  const first = post();
  await ready;
  try {
    host.head = 'd'.repeat(40);
    expect((await post({ commitSha: host.head })).status).toBe(409);
    expect((await post({ commitSha: host.head })).status).toBe(200);
  } finally { release(); }
  expect((await first).status).toBe(409);
  expect(host.mutations).toHaveLength(2);
  expect(receipt()).toMatchObject({ status: 'merged', approvedSha: host.head });
});

it('late reconciliation cannot return a newer head publication as success', async () => {
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  host.holdStateRead = async () => { entered(); await resumed; };
  const first = post({ action: 'enable-auto-merge' });
  await ready;
  try {
    host.head = 'd'.repeat(40); host.auto = false;
    expect((await post({ commitSha: host.head })).status).toBe(409);
    expect((await post({ commitSha: host.head })).status).toBe(200);
  } finally { release(); }
  expect((await first).status).toBe(409);
  expect(host.mutations).toHaveLength(2);
  expect(receipt()).toMatchObject({ status: 'merged', approvedSha: host.head });
});
