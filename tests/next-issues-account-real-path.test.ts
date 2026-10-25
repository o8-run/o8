// @resource-owning: subprocess route host, owned SQLite and GitHub transport
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

let server: ChildProcess;
let origin = '';
const headers = { authorization: 'Bearer fixture-next-issues-operator', 'Content-Type': 'application/json' };
const createPath = '/api/panel/issues/create';
const controlPath = '/__fixture/issues';
async function api(path: string, body: unknown) {
  return fetch(`${origin}${path}`, { headers, method: 'POST', body: JSON.stringify(body) });
}
beforeAll(async () => {
  server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--issues', '--issues-managed'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-next-issues-operator' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: server.stdout! });
  for await (const line of lines) {
    try { origin = JSON.parse(line).origin || ''; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin).toBeTruthy();
}, 30_000);
beforeEach(async () => { expect((await api(controlPath, { account: 'a' })).status).toBe(200); });
afterAll(async () => {
  if (server?.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited;
  }
});

it('refuses another account replaying a receipt on the same installation', async () => {
  const body = { repo: 'fixture/alpha', title: 'Account A receipt', clientMutationId: 'owner-receipt' };
  const original = await (await api(createPath, body)).json();
  expect(original).toMatchObject({ ok: true });
  await api(controlPath, { account: 'b' });
  const replay = await api(createPath, body);
  expect(replay.status).toBe(409);
  expect(await replay.json()).not.toHaveProperty('url');
  await api(controlPath, { account: 'a' });
  expect(await (await api(createPath, body)).json()).toEqual(original);
});

it('refuses sending an A draft with B credentials when the account switches at reservation', async () => {
  const body = { repo: 'fixture/alpha', title: 'A draft across reservation', clientMutationId: 'owner-reservation' };
  await api(controlPath, { switchOnReserve: true });
  const response = await api(createPath, body);
  const { postsSeen } = await (await api(controlPath, {})).json();
  expect(postsSeen.filter((post: { title: string }) => post.title === body.title)).toHaveLength(0);
  expect(response.status).toBe(409);
  expect((await api(createPath, body)).status).toBe(409);
  await api(controlPath, { account: 'a' });
  expect(await (await api(createPath, body)).json()).toMatchObject({ ok: true });
});

it('retries the original key after a definite 429 and its cooldown', async () => {
  const body = { repo: 'fixture/alpha', title: 'Retry after definite 429', clientMutationId: 'cooldown-original-key' };
  await api(controlPath, { rateLimitNext: true });
  const refused = await api(createPath, body);
  const refusal = await refused.json();
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  const duringCooldown = await api(createPath, body);
  expect(duringCooldown.status).toBe(429);
  expect(await duringCooldown.json()).toMatchObject({ creationRefused: true });
  await delay(2200);
  const retry = await api(createPath, body);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ ok: true });
  expect(refused.status).toBe(429);
  expect(refusal).toMatchObject({ creationRefused: true });
  const { postsSeen } = await (await api(controlPath, {})).json();
  expect(postsSeen.filter((post: { title: string }) => post.title === body.title)).toHaveLength(2);
});

it('keeps the committed receipt with A when the account changes while its reply is held', async () => {
  const body = { repo: 'fixture/alpha', title: 'A committed reply held', clientMutationId: 'owner-delayed-reply' };
  await api(controlPath, { holdReplyNext: true });
  const creation = api(createPath, body);
  await expect.poll(async () => (await (await api(controlPath, {})).json()).held).toBe(true);
  await api(controlPath, { account: 'b', releaseReply: true });
  const response = await creation;
  expect(response.status).toBe(409);
  expect(await response.json()).not.toHaveProperty('url');
  expect((await api(createPath, body)).status).toBe(409);
  await api(controlPath, { account: 'a' });
  expect(await (await api(createPath, body)).json()).toMatchObject({ ok: true });
  const { postsSeen } = await (await api(controlPath, {})).json();
  expect(postsSeen.filter((post: { title: string }) => post.title === body.title)).toEqual([{ title: body.title, account: 'a' }]);
});
