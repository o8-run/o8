import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The middleware gate recognizes packet worker credentials from a DB-free hash file. A credential
// the operator revokes must leave that file, so the gate refuses it on every worker read, including
// reads whose handlers would otherwise admit a loopback caller without checking the token again.
const WORKER_READS = ['/api/tasks', '/api/panel/problem-dossiers', '/api/panel/approvals', '/api/lanes', '/api/lanes/fixture-lane'];
const GATE_REFUSAL = /restricted to local o8 clients/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

it('refuses a packet worker at the gate once the operator revokes it', async () => {
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const { getSqlite } = await import('@/lib/db');
  const { panelGateMiddleware } = await import('@/middleware');
  const { POST } = await import('@/app/api/panel/workers/route');
  const token = mintPacketWorkerToken('fixture-revoked-at-gate');
  const gate = (path: string) => panelGateMiddleware(new NextRequest(`http://127.0.0.1:3000${path}`, {
    headers: { host: '127.0.0.1:3000', authorization: `Bearer ${token}`, 'x-o8-client-addr': '127.0.0.1' } }));
  for (const path of WORKER_READS) expect(gate(path).headers.get('x-middleware-next'), path).toBe('1');

  // The operator's revoke action in the Workers panel.
  const { id } = getSqlite().prepare('SELECT id FROM worker_tokens WHERE token_hash = ?').get(sha256(token)) as { id: string };
  const revoked = await POST(new Request('http://127.0.0.1:3000/api/panel/workers', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke_token', id }) }));
  expect(revoked.status).toBe(200);
  for (const path of WORKER_READS) {
    const response = gate(path);
    expect(response.status, path).toBe(401);
    expect((await response.json()).detail, path).toMatch(GATE_REFUSAL);
  }
});

it.skipIf(process.platform === 'win32')('keeps the gate file equal to the active credentials while two processes mint and revoke at once', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-revoked-race-')));
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
    CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') };
  // Each process stands in for one server (the WS process, Next): it mints credentials and
  // revokes every other one through the production revoke path, interleaved with the other.
  const worker = (tag: string) => promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx', '--eval', `
      const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
      const { revokeToken } = require('./src/lib/worker/tokens.ts');
      const { getSqlite, closeDb } = require('./src/lib/db/index.ts');
      for (let index = 0; index < 80; index += 1) {
        mintPacketWorkerToken('${tag}-' + index);
        if (index % 2 === 1) revokeToken(getSqlite().prepare('SELECT id FROM worker_tokens WHERE packet_id = ?').get('${tag}-' + (index - 1)).id);
      }
      closeDb();
    `], { env, timeout: 120_000 });
  try {
    await worker('fixture-race-seed');
    await Promise.all([worker('fixture-race-ws'), worker('fixture-race-next')]);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs',
      '--import=tsx', '--eval', `
        const { getSqlite, closeDb } = require('./src/lib/db/index.ts');
        const rows = getSqlite().prepare("SELECT token_hash, revoked_at FROM worker_tokens WHERE scope = 'local-packet'").all();
        console.log('rows ' + JSON.stringify(rows));
        closeDb();
      `], { env });
    const rows = JSON.parse(stdout.split('\n').find(line => line.startsWith('rows '))!.slice(5)) as Array<{ token_hash: string; revoked_at: string | null }>;
    expect(rows).toHaveLength(240);
    const file = readFileSync(join(directory, 'worker-packet-token-hashes'), 'utf8').split('\n').filter(Boolean);
    expect(file.filter(hash => rows.some(row => row.token_hash === hash && row.revoked_at))).toEqual([]);
    expect(new Set(file)).toEqual(new Set(rows.filter(row => !row.revoked_at).map(row => row.token_hash)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

it.skipIf(process.platform === 'win32')('refuses revoked packet workers at the native gate, including one revoked before startup', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-revoked-gate-')));
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
    CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') };
  const script = (body: string) => promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx', '--eval', body], { env }).then(({ stdout }) => JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!));
  const hashes = () => readFileSync(join(directory, 'worker-packet-token-hashes'), 'utf8');
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    // An install whose revoked credential still sits in the gate's file.
    const { stale } = await script(`
      const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
      const { getSqlite, closeDb } = require('./src/lib/db/index.ts');
      const stale = mintPacketWorkerToken('fixture-revoked-before-start');
      getSqlite().prepare('UPDATE worker_tokens SET revoked_at = ? WHERE packet_id = ?').run(new Date().toISOString(), 'fixture-revoked-before-start');
      closeDb();
      console.log(JSON.stringify({ stale }));
    `);
    expect(hashes()).toContain(sha256(stale));

    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const read = async (path: string, bearer: string) => {
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${bearer}` } });
      return { status: response.status, detail: String((await response.json().catch(() => ({}))).detail ?? '') };
    };
    // Startup rebuilt the file from the database.
    expect(hashes()).not.toContain(sha256(stale));
    for (const path of WORKER_READS) expect(await read(path, stale), path).toMatchObject({ status: 401, detail: expect.stringMatching(GATE_REFUSAL) });

    // A credential revoked through the production path while the server runs.
    const { live } = await script(`
      const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
      const { closeDb } = require('./src/lib/db/index.ts');
      console.log(JSON.stringify({ live: mintPacketWorkerToken('fixture-revoked-live') }));
      closeDb();
    `);
    for (const path of WORKER_READS) expect((await read(path, live)).detail, path).not.toMatch(GATE_REFUSAL);
    await script(`
      const { getSqlite, closeDb } = require('./src/lib/db/index.ts');
      const { revokeToken } = require('./src/lib/worker/tokens.ts');
      const { id } = getSqlite().prepare('SELECT id FROM worker_tokens WHERE packet_id = ?').get('fixture-revoked-live');
      console.log(JSON.stringify({ revoked: revokeToken(id) }));
      closeDb();
    `);
    for (const path of WORKER_READS) expect(await read(path, live), path).toMatchObject({ status: 401, detail: expect.stringMatching(GATE_REFUSAL) });
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
