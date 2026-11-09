import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

type Ledger = { projects: Array<{ id: string; name: string; repoPaths: string[] }>; activeProjectId: string };
const active = (ledger: Ledger) => ledger.projects.find(project => project.id === ledger.activeProjectId);

// The MCP server's project create, served by the WS listener with Next stopped. Native and TS
// creates alternate on one data directory, and each side reads back the state the other wrote.
it.skipIf(process.platform === 'win32')('creates projects natively with the TS answer', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-projects-create-')));
  const device = 'projects-create-fixture-device-0123456789abcdef';
  const worker = 'projects-create-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const path = '/api/panel/projects';
    const operator = { authorization: `Bearer ${server.token}` };
    const send = (method: string, headers: Record<string, string>, body?: unknown) => fetch(`${origin}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await send('POST', forged, { name: 'Refused' })).status).toBe(401);
    for (const token of [device, worker]) {
      expect((await send('POST', { ...forged, authorization: `Bearer ${token}` }, { name: 'Refused' })).status).toBe(403);
    }

    // The TS handler publishes its realtime change to this server, never to a default port.
    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      WS_TOKEN: server.token, CORTEX_REALTIME_INTERNAL_ORIGIN: origin });
    delete process.env.O8_DATA_DIR;
    const projects = await import('@/app/api/panel/projects/route');
    const tsPost = (body: unknown) => projects.POST(new NextRequest(`http://127.0.0.1${path}`, { method: 'POST',
      headers: { ...operator, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const read = async (response: Response) => [response.status, response.headers.get('cache-control'), await response.json()] as const;
    const nativeRead = async () => read(await send('GET', operator));
    const tsRead = async () => read(await projects.GET());

    // Refusals match and create nothing.
    const before = await nativeRead();
    for (const body of [{}, { name: '   ' }, { name: 'x'.repeat(61) }]) {
      expect([JSON.stringify(body), ...await read(await send('POST', operator, body))])
        .toEqual([JSON.stringify(body), ...await read(await tsPost(body))]);
    }
    expect(await nativeRead()).toEqual(before);

    // Each create makes the new project active, and the other side reads the same ledger back.
    const created: string[] = [];
    for (const [side, name] of [['native', 'Alpha'], ['ts', 'Beta'], ['native', 'Alpha'], ['ts', 'Beta']] as const) {
      const [status, cache, ledger] = await read(side === 'native' ? await send('POST', operator, { name }) : await tsPost({ name }));
      expect([side, name, status, cache, active(ledger as Ledger)?.name, active(ledger as Ledger)?.repoPaths])
        .toEqual([side, name, 200, 'no-store, max-age=0', name, []]);
      created.push((ledger as Ledger).activeProjectId);
      expect([side, name, await nativeRead()]).toEqual([side, name, await tsRead()]);
      expect([side, name, (await nativeRead())[2]]).toEqual([side, name, ledger]);
    }
    // A repeated name is a separate project, the same way on both sides.
    expect(new Set(created).size).toBe(4);
    const [, , finalLedger] = await nativeRead();
    expect((finalLedger as Ledger).projects.filter(project => ['Alpha', 'Beta'].includes(project.name)).map(project => project.name).sort())
      .toEqual(['Alpha', 'Alpha', 'Beta', 'Beta']);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
