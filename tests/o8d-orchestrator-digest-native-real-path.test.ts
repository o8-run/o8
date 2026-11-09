import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The operator MCP `digest` tool's route over the native transport with Next stopped. The path is
// in no middleware allowlist and the handler requires the ws-token, so over native only the
// operator reaches it. Operator bodies stop at field validation or the repo registry before the
// Codex exec, keeping every case deterministic.
it.skipIf(process.platform === 'win32')('serves orchestrator digest natively, operator-ws-token-only, and refuses the rest (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-orchestrator-digest-')));
  const device = 'orchestrator-digest-fixture-device-0123456789abcdef';
  const worker = 'orchestrator-digest-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const call = (headers: Record<string, string>, body: unknown) => fetch(`${origin}/api/orchestrator/digest`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Middleware floor over native (forged loopback markers are inert under the unverified-proxy
    // stamp): only the operator ws-token is admitted; a lesser credential never reaches the digest.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    const unregistered = { text: 'inbound bulk fixture', repoPath: join(directory, 'not-a-registered-repo') };
    expect((await call(forged, unregistered)).status).toBe(401); // anonymous
    expect((await call({ ...forged, authorization: `Bearer ${device}` }, unregistered)).status).toBe(403); // enrolled device
    expect((await call({ ...forged, authorization: `Bearer ${worker}` }, unregistered)).status).toBe(403); // dispatched worker

    // Operator passes the middleware floor and requirePanelAuth, then stops at the missing-field
    // check or the repo registry before any Codex exec. native == in-process TS.
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const handler = await import('@/app/api/orchestrator/digest/route');
    const operator = { authorization: `Bearer ${server.token}` };
    for (const body of [{ repoPath: directory }, { text: 'inbound bulk fixture' }, unregistered]) {
      const native = await call(operator, body);
      const ts = await handler.POST(new NextRequest('http://127.0.0.1/api/orchestrator/digest', {
        method: 'POST', headers: { 'content-type': 'application/json', ...operator }, body: JSON.stringify(body) }));
      const nativeBody = await native.json();
      expect([native.status, nativeBody]).toEqual([ts.status, await ts.json()]);
      expect(native.status).toBe(400);
      expect(nativeBody).toMatchObject({ ok: false });
    }
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
