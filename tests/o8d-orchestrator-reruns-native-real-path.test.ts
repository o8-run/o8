import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Packet rerun, reset and spawn, served by the WS listener with Next stopped:
// each production handler gives the same answer as the TS handler in this
// process on the same data directory.
it.skipIf(process.platform === 'win32')('serves packet rerun, reset and spawn natively with the TS answer', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-orchestrator-reruns-')));
  const saved = { ...process.env };
  // Codex preflight counts these as auth. The child inherits this environment, its
  // HOME is the fixture directory and its key store is the fixture data directory,
  // so without them a complete spawn is refused on every machine before any launch.
  // The worker env pass-through switches could hand the login probe a real Codex home.
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_HOME',
    'O8_WORKER_ENV_INHERIT', 'O8_WORKER_ENV_ALLOW']) delete process.env[name];
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };

    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const handlers = {
      '/api/orchestrator/rerun-with-feedback': (await import('@/app/api/orchestrator/rerun-with-feedback/route')).POST,
      '/api/orchestrator/reset-packet': (await import('@/app/api/orchestrator/reset-packet/route')).POST,
      '/api/orchestrator/spawn-prompt': (await import('@/app/api/orchestrator/spawn-prompt/route')).POST,
    };
    const cases: Array<[keyof typeof handlers, Record<string, unknown>]> = [
      ['/api/orchestrator/reset-packet', { packetId: 'fixture-missing', idempotencyKey: 'fixture-reset' }],
      ['/api/orchestrator/reset-packet', { packetId: 'fixture-missing' }],
      ['/api/orchestrator/rerun-with-feedback', { packetId: 'fixture-missing', feedback: 'Fixture feedback', idempotencyKey: 'fixture-rerun' }],
      ['/api/orchestrator/rerun-with-feedback', { packetId: 'fixture-missing', feedback: 'Fixture feedback' }],
      ['/api/orchestrator/spawn-prompt', { repoPath: directory, task: 'Fixture task' }],
      ['/api/orchestrator/spawn-prompt', { repoPath: directory, task: 'Fixture task', clientMutationId: 'fixture-spawn', count: 0 }],
    ];
    for (const [path, body] of cases) {
      // Distinct keys per process, so neither answer is a replay of the other's receipt.
      const own = (suffix: string) => Object.fromEntries(Object.entries(body).map(([key, value]) =>
        [key, key === 'idempotencyKey' || key === 'clientMutationId' ? `${value}-${suffix}` : value]));
      const native = await fetch(origin + path, { method: 'POST', headers: operator, body: JSON.stringify(own('native')) });
      const ts = await handlers[path](new NextRequest(`http://127.0.0.1${path}`, { method: 'POST', headers: operator, body: JSON.stringify(own('ts')) }));
      const nativeBody = await native.json();
      expect([path, native.status, nativeBody]).toEqual([path, ts.status, await ts.json()]);
    }

    // A complete spawn runs the production handler as far as the runtime preflight. The
    // native child has no Codex auth (scrubbed above), so it refuses there and starts
    // nothing; the TS side is not called, so this test never spawns a worker.
    const spawn = await fetch(`${origin}/api/orchestrator/spawn-prompt`, { method: 'POST', headers: operator,
      body: JSON.stringify({ repoPath: directory, task: 'Fixture task', clientMutationId: 'fixture-spawn-native', runtime: 'codex' }) });
    expect(spawn.status).toBe(400);
    expect((await spawn.json()).error.code).toBe('dispatch_cli_auth_unavailable');
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
