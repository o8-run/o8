import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import { GET } from './route';
import { GET as THREAD } from './[id]/thread/route';

const AGENT = 'bf4d168a-f3a4-4625-9603-d43837e19abd';
let root: string;

beforeEach(() => {
  auth.denied = false;
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

it('GET /api/bots lists the grok bot', async () => {
  const body = await (await GET(req('/api/bots'))).json();
  expect(body.bots).toHaveLength(1);
  expect(body.bots[0]).toMatchObject({ id: `grok:${AGENT}`, house: 'grok', name: 'cash' });
});

it('GET /api/bots honours panel auth', async () => {
  auth.denied = true;
  expect((await GET(req('/api/bots'))).status).toBe(401);
});

it('thread route returns mailbox messages and the deep link; unknown bots 404', async () => {
  const dir = join(dirs.data, 'bots', 'grok', AGENT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'thread.jsonl'), `${JSON.stringify({ id: 'a', role: 'user', text: 'yo' })}\n`);
  const id = encodeURIComponent(`grok:${AGENT}`);
  const body = await (await THREAD(req(`/api/bots/${id}/thread`), { params: Promise.resolve({ id }) })).json();
  expect(body.messages).toEqual([{ id: 'a', role: 'user', text: 'yo', at: null }]);
  expect(body.externalUrl).toBe(`grokbot://app/v1/agent?id=${AGENT}`);
  const missing = await THREAD(req('/api/bots/x/thread'), { params: Promise.resolve({ id: 'x' }) });
  expect(missing.status).toBe(404);
});
