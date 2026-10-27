import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';

let host: ChildProcess;
let origin = '';
const headers = { authorization: 'Bearer fixture-sidebar-operator', 'content-type': 'application/json' };
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--sidebar'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-sidebar-operator' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: host.stdout! });
  for await (const line of lines) {
    try { origin = (JSON.parse(line) as { origin?: string }).origin ?? ''; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin).toBeTruthy();
}, 30_000);
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
});
type Thread = { id: string; title: string; repoPath: string; status: string };
async function threads() {
  const all: Thread[] = [];
  for (let offset = 0; offset <= 2000; offset += 500) {
    const response = await fetch(`${origin}/api/mobile/orchestrator/threads?limit=500&offset=${offset}`, { headers });
    expect(response.status).toBe(200);
    const page = (await response.json()).threads as Thread[];
    all.push(...page);
    if (page.length < 500) break;
  }
  return all.filter(thread => thread.id.startsWith('thoughts-sidebar-'));
}
it('pages the same 2,000 persisted threads as the desktop history route in recency order', async () => {
  const actual = await threads();
  const response = await fetch(`${origin}/api/v2/chat-history/list?include=orchestrator`, { headers });
  const desktop = (await response.json()).conversations as Array<{ tabId: string }>;
  expect(actual).toHaveLength(2000);
  expect(actual.map(thread => thread.id)).toEqual(desktop.filter(row => row.tabId.startsWith('thoughts-sidebar-')).map(row => row.tabId));
  expect(new Set(actual.map(thread => thread.repoPath)).size).toBe(2);
  expect(actual.find(thread => thread.id === 'thoughts-sidebar-0000')?.status).toBe('failed');
});
it('persists rename and archive in the records read by both thread routes', async () => {
  const tabId = 'thoughts-sidebar-0014';
  for (const patch of [{ title: 'Operator renamed fixture' }, { archivedAt: '2026-10-02T00:00:00.000Z' }]) {
    const response = await fetch(`${origin}/api/v2/chat-history`, { method: 'PATCH', headers, body: JSON.stringify({ tabId, ...patch }) });
    expect(response.status).toBe(200);
  }
  const record = await (await fetch(`${origin}/api/v2/chat-history?tabId=${tabId}`, { headers })).json();
  expect(record.title).toBe('Operator renamed fixture');
  expect(record.archivedAt).toBe('2026-10-02T00:00:00.000Z');
  expect((await threads()).some(thread => thread.id === tabId)).toBe(false);
});

it('archives the registered worker only from its workspace through the production handler', async () => {
  const sessionKey = 'pi-builtin-owned:grid-runtime';
  const inventory = await (await fetch(`${origin}/api/runtime/inventory?fresh=1`, { headers })).json();
  const worker = inventory.agents.find((row: { sessionKey: string }) => row.sessionKey === sessionKey);
  expect(worker).toBeTruthy();
  const other = (await threads()).find(row => row.repoPath !== worker.workspace)!.repoPath;
  const archive = (workspace: string) => fetch(`${origin}/api/runtime/archive?${new URLSearchParams({ workspace })}`, {
    method: 'POST', headers, body: JSON.stringify({ sessionKey, clientMutationId: 'fixture-owned-worker-archive' }),
  });
  const state = async () => (await (await fetch(`${origin}/api/runtime/archive?${new URLSearchParams({ sessionKeys: sessionKey })}`, { headers })).json()).states[sessionKey];
  expect((await archive(other)).status).toBe(404);
  expect(await state()).toBe('active');
  const accepted = await archive(worker.workspace);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  expect(await state()).toBe('archived');
});
