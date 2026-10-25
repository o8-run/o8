import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, expect, it } from 'vitest';

const entry = join(process.cwd(), 'scripts/next/surfaces/registration-probe.surface.ts');
let host: ChildProcess | undefined;
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
  rmSync(entry, { force: true });
});

it('a new surface entry serves through the real host and its authentication gate', async () => {
  writeFileSync(entry, `export default async function register() {
    if (!process.argv.includes('--registration-probe')) return {};
    return { routes: { 'GET /api/panel/registration-probe': async () => Response.json({ surface: 'probe' }) } };
  }\n`);
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--registration-probe'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-registration-token' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  host.stderr!.on('data', chunk => { diagnostics += String(chunk); });
  const lines = createInterface({ input: host.stdout! });
  let origin = '';
  for await (const line of lines) {
    try { origin = JSON.parse(line).origin ?? ''; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin, diagnostics).toBeTruthy();
  const endpoint = origin + '/api/panel/registration-probe';
  const response = await fetch(endpoint, { headers: { authorization: 'Bearer fixture-registration-token' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ surface: 'probe' });
  expect((await fetch(endpoint)).status).toBe(401);
}, 30_000);
