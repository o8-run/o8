import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Symon's o8 team tools, served by the WS listener with Next stopped: the same
// peers and messages as the TS handlers, and a tell from either process lands in
// the same mailbox the other reads.
it.skipIf(process.platform === 'win32')('serves team presence, messages and tell natively with Next stopped', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-team-routes-')));
  const device = 'team-routes-fixture-device-0123456789abcdef';
  const worker = 'team-routes-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);

  // One registered repo with a live peer, a stale peer, a malformed presence file and one message.
  const repo = join(directory, 'fixture-repo');
  const presence = join(repo, '.git', 'agents', 'presence');
  const mailbox = join(repo, '.git', 'agents', 'mailbox');
  mkdirSync(presence, { recursive: true });
  mkdirSync(mailbox, { recursive: true });
  const now = Date.now();
  writeFileSync(join(presence, 'live.json'), JSON.stringify({ handle: 'Nova', status: 'working', runtime: 'codex', lastSeen: new Date(now).toISOString() }));
  writeFileSync(join(presence, 'stale.json'), JSON.stringify({ handle: 'Ember', status: 'working', runtime: 'claude', lastSeen: new Date(now - 60 * 60_000).toISOString() }));
  writeFileSync(join(presence, 'broken.json'), '{not json');
  writeFileSync(join(mailbox, 'Nova.jsonl'), `${JSON.stringify({ fromHandle: 'Atlas', text: 'fixture: first note', at: new Date(now - 60_000).toISOString() })}\n`);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'fixture-repo', name: 'fixture-repo', localPath: repo, isGitRepo: false, defaultBranch: 'main' }] }));

  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}` };
    const call = (path: string, headers: Record<string, string> = {}, body?: unknown) => fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport: no grant for a phone or a worker.
    for (const [path, body] of [['/api/team/presence'], ['/api/team/messages'], ['/api/team/tell', {}]] as const) {
      expect([path, (await call(path, {}, body)).status]).toEqual([path, 401]);
      for (const token of [device, worker]) expect([path, (await call(path, { authorization: `Bearer ${token}` }, body)).status]).toEqual([path, 403]);
    }

    // The TS handlers in this process, on the same data directory.
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') });
    delete process.env.O8_DATA_DIR;
    const local = (path: string, body?: unknown) => new NextRequest(`http://127.0.0.1${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...operator, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const { GET: presenceTs } = await import('@/app/api/team/presence/route');
    const { GET: messagesTs } = await import('@/app/api/team/messages/route');
    const { POST: tellTs } = await import('@/app/api/team/tell/route');

    const peers = await (await call('/api/team/presence', operator)).json() as { peers: Array<{ codename: string; repo: string }> };
    expect(peers.peers.map(peer => [peer.codename, peer.repo])).toEqual([['Nova', 'fixture-repo']]);
    expect(peers).toEqual(await (await presenceTs()).json());

    const messages = '/api/team/messages?limit=5';
    const before = await (await call(messages, operator)).json() as { messages: Array<{ from: string; to: string; text: string }> };
    expect(before.messages.map(m => [m.from, m.to, m.text])).toEqual([['Atlas', 'Nova', 'fixture: first note']]);
    expect(before).toEqual(await (await messagesTs(local(messages))).json());

    // A native tell resolves the live peer by handle, case-insensitively, and appends to its mailbox.
    const told = await call('/api/team/tell', operator, { to: '@nova', text: 'fixture: hold the ship', from: 'Symon' });
    expect([told.status, await told.json()]).toEqual([200, { ok: true, schema: 'o8/team.tell/v1', to: 'Nova', repo: 'fixture-repo' }]);
    const lines = readFileSync(join(mailbox, 'Nova.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { fromHandle: string; text: string });
    expect(lines.map(line => [line.fromHandle, line.text])).toEqual([['Atlas', 'fixture: first note'], ['Symon', 'fixture: hold the ship']]);
    // A TS tell lands in the same mailbox the native read sees.
    expect((await tellTs(local('/api/team/tell', { to: 'Nova', text: 'fixture: from TS', from: 'Atlas' }))).status).toBe(200);
    const after = await (await call(messages, operator)).json() as typeof before;
    expect(after.messages.map(m => m.text).sort()).toEqual(['fixture: first note', 'fixture: from TS', 'fixture: hold the ship']);
    expect(after).toEqual(await (await messagesTs(local(messages))).json());

    // Refusals match: a stale or unknown handle is 404, a missing field is 400.
    for (const body of [{ to: 'Ember', text: 'fixture' }, { to: 'Ghost', text: 'fixture' }, { to: 'Nova' }]) {
      const native = await call('/api/team/tell', operator, body);
      const ts = await tellTs(local('/api/team/tell', body));
      expect([native.status, await native.json()]).toEqual([ts.status, await ts.json()]);
    }
    expect(readFileSync(join(mailbox, 'Nova.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
