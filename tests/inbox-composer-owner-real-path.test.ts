import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const parking = vi.hoisted(() => vi.fn());
vi.mock('@/lib/inbox/workspace-parking', () => ({ startSettledWorkspaceParking: parking }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
const root = realpathSync(mkdtempSync('/tmp/o8-inbox-cq-'));
const repo = join(root, 'repo'); mkdirSync(repo);
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'cortex-ide.db'));
const { PATCH } = await import('@/app/api/v2/chat-history/route');
const { writePersistedLlmChat, persistCanonicalChatHistoryRecord, readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { inboxSubject, readInboxState } = await import('@/lib/inbox/store');
const { runInboxAutoSettleSweep } = await import('@/lib/inbox/settlement');
const { attachPullRequestContext } = await import('@/lib/orchestrator/pull-request-context');
const { upsertGitHubPullRequest } = await import('@/lib/github-broker/store');
const { getSqlite, closeDb } = await import('@/lib/db');
let reads = 0;
let mode = 'empty';
let current = '';
let sequence = 0;
const server = createServer(async (request, response) => {
  if (request.url === '/internal/realtime') { response.writeHead(202).end(); return; }
  if (request.url !== '/internal/composer-queue') { response.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  expect(body.method).toBe('list');
  expect(body.params.target.threadId).toBe(current);
  const subject = inboxSubject('conversation', current, repo);
  reads++;
  // The post-read is after the actual metadata transaction, never inside it.
  if (reads === 2) expect(readInboxState(subject).settledOverride).toBe('settled');
  if (mode === 'history-after' && reads === 2) {
    const saved = readPersistedLlmChat(current)!.history;
    persistCanonicalChatHistoryRecord(current, { ...saved, messages: [...saved.messages,
      { id: 'interleaved', role: 'assistant', content: 'Arrived while the owner reply was pending.', timestamp: 3 }] });
  }
  if (mode === 'offline-before' || (mode === 'offline-after' && reads === 2)) {
    response.writeHead(503).end(); return;
  }
  const items = mode === 'queued-before' || (mode === 'queued-after' && reads === 2)
    ? [{ id: 'queued-during-settle', repoPath: repo, threadId: current, status: 'queued', payload: {} }] : [];
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { items } }));
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  vi.stubEnv('O8_WS_PORT', String(address.port));
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function seed() {
  current = `thoughts-queue-settle-${++sequence}`; reads = 0; parking.mockClear();
  getSqlite().exec('DELETE FROM conversation_pr_context');
  writePersistedLlmChat(current, { repoPath: repo, messages: [
    { id: 'u', role: 'user', content: 'Existing task', timestamp: 1 },
    { id: 'a', role: 'assistant', content: 'Completed task', timestamp: 2 },
  ] });
  const mergedAt = new Date().toISOString();
  upsertGitHubPullRequest({ pullRequestId: sequence, repositoryId: 1, repoFullName: 'example/fixture', number: sequence,
    title: 'Fixture', state: 'closed', author: null, body: '', headRefName: 'fixture', baseRefName: 'main', additions: 1,
    deletions: 0, changedFiles: 1, reviewDecision: null, statusCheckRollup: [], url: `https://github.com/example/fixture/pull/${sequence}`,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: mergedAt, closedAt: mergedAt, mergedAt,
    headSha: 'a'.repeat(40), mergeCommit: 'b'.repeat(40) });
  attachPullRequestContext(current, { host: 'github.com', repositoryId: 1, pullRequestId: sequence, number: sequence });
  return inboxSubject('conversation', current, repo);
}
it.each(['manual', 'sweep'])('%s refuses a queue change after commit, reopens the subject and never starts parking', async path => {
  const subject = seed(); mode = 'queued-after';
  if (path === 'manual') {
    const response = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'PATCH', body: JSON.stringify({ tabId: current, inboxAction: 'settle' }),
    }));
    expect(response.status).toBe(409); expect((await response.json()).error).toContain('Thread has a queued message.');
  } else expect(await runInboxAutoSettleSweep({ force: true, agents: [], idleDays: 0 })).not.toContain(current);
  expect(reads).toBe(2); expect(readInboxState(subject).settledOverride).toBe('active');
  expect(parking).not.toHaveBeenCalled();
});
it.each(['manual', 'sweep'])('%s fails closed when the owner is unavailable before commit', async path => {
  const subject = seed(); mode = 'offline-before';
  if (path === 'manual') {
    const response = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', { method: 'PATCH', body: JSON.stringify({ tabId: current, inboxAction: 'settle' }) }));
    expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('1');
  } else expect(await runInboxAutoSettleSweep({ force: true, agents: [], idleDays: 0 })).not.toContain(current);
  expect(reads).toBe(1); expect(readInboxState(subject).settledOverride).toBeNull(); expect(parking).not.toHaveBeenCalled();
});
it.each(['manual', 'sweep'])('%s reverts when the owner is unavailable after commit', async path => {
  const subject = seed(); mode = 'offline-after';
  if (path === 'manual') {
    const response = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', { method: 'PATCH', body: JSON.stringify({ tabId: current, inboxAction: 'settle' }) }));
    expect(response.status).toBe(503);
  } else expect(await runInboxAutoSettleSweep({ force: true, agents: [], idleDays: 0 })).not.toContain(current);
  expect(reads).toBe(2); expect(readInboxState(subject).settledOverride).toBe('active'); expect(parking).not.toHaveBeenCalled();
});
it('does not start parking when a send is already queued', async () => {
  const subject = seed(); mode = 'queued-before';
  const response = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', { method: 'PATCH', body: JSON.stringify({ tabId: current, inboxAction: 'settle' }) }));
  expect(response.status).toBe(409); expect(reads).toBe(1);
  expect(readInboxState(subject).settledOverride).toBeNull(); expect(parking).not.toHaveBeenCalled();
});

it('unpins the current history after recheck without overwriting an interleaved reply', async () => {
  seed(); mode = 'history-after';
  persistCanonicalChatHistoryRecord(current, { ...readPersistedLlmChat(current)!.history, pinned: true });
  const response = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', { method: 'PATCH', body: JSON.stringify({ tabId: current, inboxAction: 'settle' }) }));
  expect(response.status).toBe(200); expect(reads).toBe(2);
  const saved = readPersistedLlmChat(current)!.history;
  expect(saved.messages).toContainEqual(expect.objectContaining({ id: 'interleaved', content: 'Arrived while the owner reply was pending.' }));
  expect((saved as { pinned?: boolean }).pinned).toBe(false);
  expect(parking).toHaveBeenCalledOnce();
});
