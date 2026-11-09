import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The Targeting Machine (operator MCP `o8_targets` tool and the Targets panel) over the native
// transport with Next stopped. The path is in no middleware allowlist, so only the operator ws-token
// passes. The fixture repo has no skeleton cache, so every scan ends at `no-skeleton` before any
// git pass or model call, keeping every case deterministic.
it.skipIf(process.platform === 'win32')('serves panel targets natively, operator-ws-token-only, and keeps scan jobs with their listener (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-panel-targets-')));
  const device = 'panel-targets-fixture-device-0123456789abcdef';
  const worker = 'panel-targets-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const repoPath = join(directory, 'repo-fixture');
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const url = (query: Record<string, string>) => `/api/panel/targets?${new URLSearchParams({ repoPath, ...query })}`;
    const call = (path: string, headers: Record<string, string>) => fetch(`${origin}${path}`, { headers });

    // Middleware floor over native (forged loopback markers are inert under the unverified-proxy
    // stamp): a lesser credential cannot start a scan that spends the triage model.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    const start = url({ mode: 'start' });
    expect((await call(start, forged)).status).toBe(401); // anonymous
    expect((await call(start, { ...forged, authorization: `Bearer ${device}` })).status).toBe(403); // enrolled device
    expect((await call(start, { ...forged, authorization: `Bearer ${worker}` })).status).toBe(403); // dispatched worker

    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const handler = await import('@/app/api/panel/targets/route');
    const operator = { authorization: `Bearer ${server.token}` };
    const inProcess = (path: string) => handler.GET(new Request(`http://127.0.0.1${path}`, { headers: operator }));

    // The synchronous triage (the MCP tool's call): native == in-process TS.
    const native = await call(url({}), operator);
    const ts = await inProcess(url({}));
    const nativeBody = await native.json();
    expect([native.status, nativeBody]).toEqual([ts.status, await ts.json()]);
    expect(nativeBody).toMatchObject({ ok: true, count: 0, targets: [], reason: 'no-skeleton' });

    // The panel's start -> poll scan: the job lives in the listener that started it.
    const started = await (await call(start, operator)).json() as { ok: boolean; jobId: string };
    expect(started).toMatchObject({ ok: true, jobId: expect.any(String) });
    const poll = url({ jobId: started.jobId });
    let result: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 50; attempt++) {
      result = await (await call(poll, operator)).json() as Record<string, unknown>;
      if ((result.progress as { phase?: string } | undefined)?.phase === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(result).toMatchObject({ ok: true, jobId: started.jobId, count: 0, reason: 'no-skeleton', progress: { phase: 'complete' } });
    // Another process's map has no such job, and a job answers only for its own repoPath.
    expect((await inProcess(poll)).status).toBe(404);
    expect((await call(`/api/panel/targets?${new URLSearchParams({ repoPath: directory, jobId: started.jobId })}`, operator)).status).toBe(404);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
