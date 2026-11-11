import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let selection: { id: string; fingerprint: string };
const device = 'acp-prepare-fixture-device';
const worker = 'acp-prepare-fixture-worker';
beforeAll(async () => {
  const target = join(process.cwd(), 'crates/o8d/target');
  if (!existsSync(join(target, 'debug/o8-pi-write'))) await promisify(execFile)('cargo', [
    'build', '--locked', '--manifest-path', 'src-tauri/sidecars/pi-write/Cargo.toml', '--target-dir', target,
  ]);
  server = await startParityReference({ o8d: true, nativeHttp: true, preload: './tests/fixtures/ws-parity-acp-prepare.cjs' });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  const catalog = await fetch(`${origin}/api/runtime/acp-registry`, { headers: { authorization: `Bearer ${server.token}` } });
  const { agents } = await catalog.json();
  selection = { id: agents[0].id, fingerprint: agents[0].fingerprint };
}, 180_000);
afterAll(async () => { await server?.stop(); });
const post = (token = server.token) => fetch(`${origin}/api/runtime/acp-registry/prepare`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-o8-client-addr': '127.0.0.1' }, body: JSON.stringify(selection),
});
const assertClean = () => {
  expect(readdirSync(join(server.directory, 'acp-agents')).filter(name => name.startsWith('.prepare-'))).toEqual([]);
  for (const file of ['fixture-installer-pid', 'fixture-supervisor-pid']) {
    const pid = Number(readFileSync(join(server.directory, file), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }
};
it('refuses lesser principals before starting an installer', async () => {
  for (const [token, status] of [['', 401], ['wrong', 401], ['o8ro_fixture', 403], [device, 403], [worker, 403]] as const) {
    expect((await post(token)).status).toBe(status);
  }
  expect(existsSync(join(server.directory, 'fixture-installer-pid'))).toBe(false);
});
it('cleans a failed supervised preparation then completes and caches it through o8d with Next stopped', async () => {
  const failed = join(server.directory, 'fixture-fail');
  writeFileSync(failed, 'fail');
  const refusal = await post();
  expect(refusal.status).toBe(400);
  expect((await refusal.json()).error).toContain('could not be prepared');
  assertClean();
  unlinkSync(failed);
  const response = await post();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.connection.name).toBe('Fixture agent');
  const prefix = join(server.directory, 'acp-agents', selection.id, selection.fingerprint);
  expect(JSON.parse(readFileSync(join(prefix, 'o8-prepared.json'), 'utf8'))).toMatchObject(selection);
  expect(body.connection.args[0]).toBe(join(prefix, 'node_modules/fixture-agent/agent.js'));
  assertClean();
  const pid = readFileSync(join(server.directory, 'fixture-installer-pid'), 'utf8');
  const cached = await post();
  expect(cached.status).toBe(200);
  expect(await cached.json()).toEqual(body);
  expect(readFileSync(join(server.directory, 'fixture-installer-pid'), 'utf8')).toBe(pid);
});
