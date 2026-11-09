import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The MCP-callable JSON Brain Q&A (cortex_ask tool + the `o8 ask` worker CLI) over the
// native transport with Next stopped. middleware admits a valid brain-read-worker bearer
// (self-allowlisted), a worker token (WORKER_CAPABILITIES) and the operator ws-token, and
// refuses the rest; over native anonymous is 401 at the tail and an enrolled device 403.
// The handler then refuses a brain-read worker that addresses another project or packet,
// and a worker that addresses no packet of its own. Every case below short-circuits before
// any Brain retrieval, so they are deterministic.
it.skipIf(process.platform === 'win32')('serves the Brain Q&A natively, operator- or brain-read-scoped, and refuses the rest (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-cortex-ask-')));
  const device = 'cortex-ask-fixture-device-0123456789abcdef';
  const worker = 'cortex-ask-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const ask = (headers: Record<string, string>, body: unknown = { question: 'Release policy?' }) =>
      fetch(`${origin}/api/cortex/ask/answer`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Over native (forged loopback markers are inert under the unverified-proxy stamp),
    // no unauthenticated caller reaches the Brain: anonymous is refused at the middleware
    // tail (401) and an enrolled device at the middleware (403). A legacy unbound worker
    // token is worker-allowlisted through the middleware, but the handler refuses it
    // (workerPacketRefusal -> worker_packet_mismatch, 403) because it addresses no packet
    // of its own, before any retrieval.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await ask(forged)).status).toBe(401); // anonymous -> middleware tail
    expect((await ask({ ...forged, authorization: `Bearer ${device}` })).status).toBe(403); // enrolled device -> middleware
    expect((await ask({ ...forged, authorization: `Bearer ${worker}` })).status).toBe(403); // unbound worker -> handler packet refusal
    // A brain-read-prefixed bearer with a bad signature is refused as an invalid credential.
    expect((await ask({ ...forged, authorization: 'Bearer o8br_not-a-real.credential' })).status).toBe(401);

    // Mint a valid (HMAC-signed) brain-read-worker token in the child's data dir so the
    // native principal resolver recognizes it via the shared signing key, and import the
    // TS handler for the native == TS comparison on the cases that reach it.
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const { mintBrainReadWorkerToken } = await import('@/lib/auth/brain-read-worker-token');
    const repoA = join(directory, 'repo-a');
    mkdirSync(repoA, { recursive: true }); // the mint canonicalizes the granted root on disk
    const brainRead = mintBrainReadWorkerToken(repoA, 'cortex-fixture-project-a');
    const handler = await import('@/app/api/cortex/ask/answer/route');
    const parity = async (headers: Record<string, string>, body: unknown) => {
      const native = await ask(headers, body);
      const ts = await handler.POST(new NextRequest('http://127.0.0.1/api/cortex/ask/answer', {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
      expect([native.status, await native.json()]).toEqual([ts.status, await ts.json()]);
      return native.status;
    };
    // Operator reaches the handler; a missing question is rejected there (400) before any
    // retrieval, native == TS. This proves the operator ws-token passes the middleware floor.
    expect(await parity({ authorization: `Bearer ${server.token}` }, {})).toBe(400);
    // A brain-read worker is self-allowlisted through the middleware, then the handler refuses
    // it the moment it addresses a packet (403 worker_brain_scope_mismatch), before any
    // retrieval, native == TS.
    expect(await parity({ authorization: `Bearer ${brainRead}` }, { question: 'Release policy?', packetId: 'cortex-fixture-packet' })).toBe(403);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
