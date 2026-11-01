import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ denied: false }));
vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: () => auth.denied ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : null,
}));
const dirs = vi.hoisted(() => ({ data: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => dirs.data }));
const membership = vi.hoisted(() => ({ failed: false }));
vi.mock('@/lib/agents/bot-membership-store', () => ({ listBotMembers: () => {
  if (membership.failed) throw new Error('Fixture membership store unavailable');
  return [];
} }));

import { GET } from './route';
import { GET as THREAD } from './[id]/thread/route';

const AGENT = 'bf4d168a-f3a4-4625-9603-d43837e19abd';
let root: string;

beforeEach(() => {
  auth.denied = false;
  membership.failed = false;
  root = mkdtempSync(join(tmpdir(), 'o8-bots-route-'));
  dirs.data = join(root, 'data');
  mkdirSync(join(root, 'agents', AGENT), { recursive: true });
  writeFileSync(join(root, 'agents', AGENT, 'profile.json'), JSON.stringify({ name: 'cash' }));
  vi.stubEnv('O8_GROK_AGENT_DATA', join(root, 'agents'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const req = (path: string) => new NextRequest(`http://127.0.0.1:3000${path}`);

it('GET /api/bots lists the grok bot after Settings setup', async () => {
  mkdirSync(dirs.data, { recursive: true });
  writeFileSync(join(dirs.data, 'settings.toml'), `[bots]\nrail_enabled = ["grok:${AGENT}"]\n`);
  const body = await (await GET(req('/api/bots'))).json();
  expect(body.bots).toHaveLength(1);
  expect(body.bots[0]).toMatchObject({ id: `grok:${AGENT}`, house: 'grok', name: 'cash' });
});

it('a discovered bot is absent from the rail until explicitly set up in Settings', async () => {
  const body = await (await GET(req('/api/bots'))).json();
  expect(body.bots).toEqual([]);
});

it('GET /api/bots honours panel auth', async () => {
  auth.denied = true;
  expect((await GET(req('/api/bots'))).status).toBe(401);
});

it('store failures produce unavailable responses instead of silently dropping durable members', async () => {
  membership.failed = true;
  const response = await GET(req('/api/bots'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Bot roster is temporarily unavailable.' });
  expect((await THREAD(req('/api/bots/x/thread'), { params: Promise.resolve({ id: 'x' }) })).status).toBe(503);
});

it('thread route returns mailbox messages and the deep link; unknown bots 404', async () => {
  const dir = join(dirs.data, 'bots', 'grok', AGENT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'thread.jsonl'), `${JSON.stringify({ id: 'a', role: 'user', text: 'yo' })}\n`);
  const id = encodeURIComponent(`grok:${AGENT}`);
  const body = await (await THREAD(req(`/api/bots/${id}/thread`), { params: Promise.resolve({ id }) })).json();
  expect(body.messages).toEqual([{ id: 'a', key: 'id:a', role: 'user', text: 'yo', at: null }]);
  expect(body.externalUrl).toBe(`grokbot://app/v1/agent?id=${AGENT}`);
  const missing = await THREAD(req('/api/bots/x/thread'), { params: Promise.resolve({ id: 'x' }) });
  expect(missing.status).toBe(404);
});

function mailbox() {
  const dir = join(dirs.data, 'bots', 'grok', AGENT);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'thread.jsonl');
}

const message = (id: string, at = '2026-10-31T12:00:00Z', text = id) =>
  JSON.stringify({ id, role: 'bot', text, at });

async function threadMessages(): Promise<Array<{ id: string; key?: string; text: string; at: string | null }>> {
  const response = await THREAD(req(`/api/bots/grok%3A${AGENT}/thread`), {
    params: Promise.resolve({ id: `grok:${AGENT}` }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['bot', 'externalUrl', 'messages']);
  return body.messages;
}

it('thread route deduplicates stable ids before limiting and orders timestamped backfill', async () => {
  writeFileSync(mailbox(), [
    message('new', '2026-10-31T12:01:00Z'),
    message('old'),
    ...Array.from({ length: 510 }, () => message('new', '2026-10-31T12:01:00Z', 'duplicate')),
  ].join('\n') + '\n');
  expect((await threadMessages()).map(m => [m.id, m.text])).toEqual([['old', 'old'], ['new', 'new']]);
});

it('thread route distinguishes identical legacy/source occurrences without changing source ids', async () => {
  const identical = { role: 'bot', text: 'identical', at: '2026-10-31T12:00:00Z' };
  writeFileSync(mailbox(), [JSON.stringify(identical), JSON.stringify({ ...identical, id: 'byte-0' })].join('\n') + '\n');
  const messages = await threadMessages();
  expect(messages.map(m => m.id)).toEqual(['byte-0', 'byte-0']);
  expect(messages[0].key).not.toEqual(messages[1].key);
  expect(messages.map(m => m.key)).toEqual(['byte:0', 'id:byte-0']);
});

it('thread route preserves append order when timestamps are absent or invalid', async () => {
  writeFileSync(mailbox(), [
    message('new', '2026-10-31T12:01:00Z'),
    JSON.stringify({ id: 'legacy', role: 'user', text: 'no timestamp' }),
    message('old'),
    message('invalid', 'not-a-date'),
  ].join('\n') + '\n');
  expect((await threadMessages()).map(m => m.id)).toEqual(['new', 'legacy', 'old', 'invalid']);
});

it('thread route breaks equal timestamp ties by first complete append order', async () => {
  writeFileSync(mailbox(), `${message('b')}\n${message('a')}\n${message('b')}\n`);
  expect((await threadMessages()).map(m => m.id)).toEqual(['b', 'a']);
});

it('thread route bounds the mailbox to its recent 1 MiB byte window', async () => {
  writeFileSync(mailbox(), `${message('outside-budget', undefined, 'x'.repeat(1024 * 1024 + 128))}\n${message('recent')}\n`);
  expect((await threadMessages()).map(m => m.id)).toEqual(['recent']);
});

it('thread route ignores an unfinished last record until its newline is appended', async () => {
  const path = mailbox();
  writeFileSync(path, `${message('committed')}\n${message('unfinished')}`);
  expect((await threadMessages()).map(m => m.id)).toEqual(['committed']);
  appendFileSync(path, '\n');
  expect((await threadMessages()).map(m => m.id)).toEqual(['committed', 'unfinished']);
});

it('thread route shows the last 500 distinct messages in order', async () => {
  writeFileSync(mailbox(), Array.from({ length: 503 }, (_, n) => message(`m-${n}`)).join('\n') + '\n');
  const messages = await threadMessages();
  expect(messages).toHaveLength(500);
  expect(messages[0].id).toBe('m-3');
  expect(messages.at(-1)?.id).toBe('m-502');
});

it('thread route keeps legacy fallback ids stable while the bounded tail advances', async () => {
  const path = mailbox();
  writeFileSync(path, `${'x'.repeat(1024 * 1024)}\n${JSON.stringify({ role: 'bot', text: 'legacy' })}\n`);
  const [legacy] = await threadMessages();
  appendFileSync(path, `${message('later')}\n`);
  expect((await threadMessages())[0]).toEqual(legacy);
});

it('thread route preserves distinct long source ids and separates them from legacy fallback identities', async () => {
  const prefix = 'x'.repeat(160);
  writeFileSync(mailbox(), [
    JSON.stringify({ role: 'bot', text: 'legacy' }),
    message('byte-0', undefined, 'explicit id'),
    message(`${prefix}a`, undefined, 'long a'),
    message(`${prefix}b`, undefined, 'long b'),
  ].join('\n') + '\n');
  const messages = await threadMessages();
  expect(messages.map(m => m.text)).toEqual(['legacy', 'explicit id', 'long a', 'long b']);
  expect(messages.slice(2).map(m => m.id)).toEqual([`${prefix}a`, `${prefix}b`]);
});

it('thread route includes a complete record at the payload boundary using one budgeted context byte', async () => {
  const first = `${message('first')}\n`;
  const last = `${message('last')}\n`;
  const filler = 'x'.repeat(1024 * 1024 - 1 - Buffer.byteLength(first + last) - 1) + '\n';
  writeFileSync(mailbox(), `{}\n${first}${filler}${last}`);
  expect((await threadMessages()).map(m => m.id)).toEqual(['first', 'last']);
});

it.each([
  ['ASCII', 'x'.repeat(20_001), 'x'.repeat(20_000)],
  ['complete emoji', 'x'.repeat(19_998) + '😀', 'x'.repeat(19_998) + '😀'],
  ['emoji crossing the cap', 'x'.repeat(19_999) + '😀', 'x'.repeat(19_999)],
])('thread route caps %s without introducing an unpaired surrogate', async (_, text, expected) => {
  writeFileSync(mailbox(), `${message('source-id', undefined, text)}\n`);
  expect(await threadMessages()).toMatchObject([{ id: 'source-id', key: 'id:source-id', text: expected }]);
});

it.each([
  ['ASCII', 'x'.repeat(81), 'x'.repeat(80)],
  ['complete emoji', 'x'.repeat(78) + '😀', 'x'.repeat(78) + '😀'],
  ['emoji crossing the cap', 'x'.repeat(79) + '😀', 'x'.repeat(79)],
])('roster route caps configured and provider %s names at Unicode boundaries', async (_, name, expected) => {
  mkdirSync(dirs.data, { recursive: true });
  writeFileSync(join(dirs.data, 'bots.json'), JSON.stringify({ bots: [{ id: 'o8:named', house: 'o8', name }] }));
  writeFileSync(join(dirs.data, 'settings.toml'), `[bots]\nrail_enabled = [\"o8:named\", \"grok:${AGENT}\"]\n`);
  writeFileSync(join(root, 'agents', AGENT, 'profile.json'), JSON.stringify({ name }));
  const body = await (await GET(req('/api/bots'))).json();
  expect(body.bots).toHaveLength(2);
  expect(body.bots.map((bot: { name: string }) => bot.name)).toEqual([expected, expected]);
});
