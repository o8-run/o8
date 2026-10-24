import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';

let server: ChildProcess;
let origin = '';
const token = 'fixture-next-issues-operator';
const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function api(path: string, body?: unknown, authorized = true) {
  return fetch(`${origin}${path}`, { headers: authorized ? headers : { 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
}
beforeAll(async () => {
  server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--issues', '--composer', '--shell'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: server.stdout! });
  for await (const line of lines) {
    try { origin = JSON.parse(line).origin || ''; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin).toBeTruthy();
}, 30_000);
afterAll(async () => {
  if (server?.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited;
  }
});



it('uses production issue routes, operator admission and installation boundaries, and persists creation', async () => {
  const list = '/api/panel/issues?repo=fixture/alpha';
  expect((await api(list, undefined, false)).status).toBe(401);
  const response = await api(list);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ repo: 'fixture/alpha', issues: [
    { number: 7, title: 'Repair fixture', state: 'open' },
  ] });
  expect(await (await api('/api/panel/issues/8?repo=fixture/alpha')).json()).toMatchObject({ issue: { state: 'closed' } });
  const detail = await api('/api/panel/issues/7?repo=fixture/alpha');
  expect(await detail.json()).toMatchObject({ repo: 'fixture/alpha', issue: { number: 7, comments: 2, body: 'Issue fixture context.' } });
  expect((await api('/api/panel/issues/7?repo=outside/private')).status).toBe(404);
  const denied = await api('/api/panel/issues/create', { repo: 'outside/private', title: 'Refused' });
  expect(await denied.json()).toMatchObject({ ok: false });
  expect((await api('/api/panel/issues/create', { repo: 'fixture/alpha', title: 'No operator' }, false)).status).toBe(401);
  expect((await api('/api/panel/issues/create', { repo: 'fixture/alpha', title: ' ' })).status).toBe(400);
  const enhanced = await api('/api/panel/issues/enhance', { repo: 'fixture/alpha', title: 'Rough idea', description: 'Details' });
  expect(await enhanced.json()).toMatchObject({ title: 'Enhanced fixture', body: '## Description\nEnhanced details', labels: ['bug'] });
  const created = await api('/api/panel/issues/create', { repo: 'fixture/alpha', title: 'Created from native', description: 'Retained body', labels: ['bug'] });
  expect(await created.json()).toMatchObject({ ok: true, number: 9, repo: 'fixture/alpha' });
  expect(await (await api('/api/panel/issues/9?repo=fixture/alpha')).json()).toMatchObject({ issue: { title: 'Created from native', body: 'Retained body', labels: [{ name: 'bug' }] } });
});

it('deduplicates concurrent keyed creation and replays its persisted receipt', async () => {
  const body = { repo: 'fixture/alpha', title: 'Keyed creation', description: 'One logical request', clientMutationId: 'round1-create-key' };
  const replies = await Promise.all([api('/api/panel/issues/create', body), api('/api/panel/issues/create', body)]);
  expect(replies.map(reply => reply.status)).toEqual([200, 200]);
  const [first, second] = await Promise.all(replies.map(reply => reply.json()));
  expect(second.number).toBe(first.number);
  const replay = await api('/api/panel/issues/create', body);
  expect(await replay.json()).toMatchObject({ ok: true, number: first.number });
  const changed = await api('/api/panel/issues/create', { ...body, title: 'Changed request' });
  expect(changed.status).toBe(409);
  expect((await api('/api/panel/issues/create', body, false)).status).toBe(401);
  const otherInstallation = await api('/api/panel/issues/create', { ...body, repo: 'fixture/beta' });
  expect(await otherInstallation.json()).toMatchObject({ ok: true, repo: 'fixture/beta', number: 9 });
  const issues = await api('/api/panel/issues?repo=fixture/alpha&fresh=1');
  expect((await issues.json()).issues.filter((issue: { title: string }) => issue.title === body.title)).toHaveLength(1);
});

it('does not repeat a keyed creation when GitHub commits but its reply is lost', async () => {
  const body = { repo: 'fixture/alpha', title: 'Commit then disconnect', clientMutationId: 'round1-unknown-key' };
  const first = await api('/api/panel/issues/create', body);
  const retry = await api('/api/panel/issues/create', body);
  const issues = await api('/api/panel/issues?repo=fixture/alpha&fresh=1');
  expect((await issues.json()).issues.filter((issue: { title: string }) => issue.title === body.title)).toHaveLength(1);
  expect(first.status).toBe(409); expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({ ok: false, creationOutcomeUnknown: true });
});
