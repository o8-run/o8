import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let mailbox: string;
const device = 'bot-thread-fixture-device';
const worker = 'bot-thread-fixture-worker';
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  writeFileSync(join(server.directory, 'bots.json'), JSON.stringify({ bots: [
    { id: 'fixture:mailbox', house: 'fixture', name: 'Fixture', mainThread: { kind: 'mailbox', id: 'mailbox' } },
    { id: 'fixture:external', house: 'fixture', name: 'External', mainThread: { kind: 'url', url: 'https://example.invalid' } },
  ] }));
  mailbox = join(server.directory, 'bots/fixture/mailbox/thread.jsonl');
}, 120_000);
afterAll(async () => { await server?.stop(); });
const post = (id: string, body: unknown, token = server.token) => fetch(`${origin}/api/bots/${encodeURIComponent(id)}/thread`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-o8-client-addr': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' }, body: JSON.stringify(body),
});
it('refuses lesser principals before writing the mailbox', async () => {
  for (const [token, status] of [['', 401], ['wrong-token', 401], ['o8ro_fixture', 403], [device, 403], [worker, 403]] as const) {
    expect((await post('fixture:mailbox', { text: 'forbidden' }, token)).status).toBe(status);
  }
  expect(existsSync(mailbox)).toBe(false);
});
it('appends and reads an operator reply through o8d with Next stopped', async () => {
  const response = await post('fixture:mailbox', { text: '  fixture reply  ' });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, message: { role: 'user', text: 'fixture reply' } });
  const lines = readFileSync(mailbox, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ id: body.message.id, role: 'user', text: 'fixture reply' });
  const listing = await fetch(`${origin}/api/bots/fixture%3Amailbox/thread`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(listing.status).toBe(200);
  expect((await listing.json()).messages).toEqual([expect.objectContaining({ id: body.message.id, role: 'user', text: 'fixture reply' })]);
});
it('preserves unknown bot, missing mailbox and empty reply refusals', async () => {
  expect((await post('unknown', { text: 'reply' })).status).toBe(404);
  expect((await post('fixture:external', { text: 'reply' })).status).toBe(409);
  expect((await post('fixture:mailbox', { text: '   ' })).status).toBe(400);
});
