import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ dir: '', envs: [] as (Record<string, string | undefined> | undefined)[] }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.dir }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
vi.mock('@/lib/mcp/tool-spine/emit-claude-desktop', () => ({ toClaudeDesktopJson: () => ({ mcpServers: { o8: { command: process.execPath, args: [], env: {} } } }) }));
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>();
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: async (_command: string, _args: string[], options: { env?: Record<string, string | undefined> }) => { state.envs.push(options.env); return { stdout: 'o8', stderr: '' }; } });
  return { ...real, execFile, execFileSync: () => process.execPath, spawn: (_command: string, _args: string[], options: { env?: Record<string, string | undefined> }) => {
    state.envs.push(options.env);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {}, end() {} }, kill() {} });
    queueMicrotask(() => child.emit('close', 0)); return child;
  } };
});
state.dir = mkdtempSync(join(tmpdir(), 'o8-runtime-setup-keys-'));
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/lib/providers/runtime-billing');
const setup = await import('@/app/api/setup/external-client/route');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubEnv('HOME', state.dir);
  state.envs.length = 0; writeFileSync(join(state.dir, '.env.local'), ''); rmSync(join(state.dir, 'runtime-billing'), { recursive: true, force: true });
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 85).toString('base64url')); vi.stubEnv('OPENAI_API_KEY', 'fixture-ambient-setup'); vi.stubEnv('CODEX_API_KEY', 'fixture-ambient-setup');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { recursive: true, force: true }); });
const cases = ['hermes', 'openclaw'].flatMap(runtime => ['status', 'install', 'remove'].flatMap(operation => ['subscription', 'api', 'disable', 'remove'].map(action => [runtime, operation, action])));
it.each(cases)('%s %s applies runtime billing and revocation after %s', async (runtime, operation, action) => {
  if (!(action === 'subscription')) expect(() => billing.saveRuntimeBillingMode(runtime, action === 'subscription' ? 'subscription' : 'api')).toThrow(); else expect(() => billing.saveRuntimeBillingMode(runtime, action === 'subscription' ? 'subscription' : 'api')).not.toThrow();
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-saved-setup' }))).status).toBe(200);
  if (action === 'disable') expect((await keys.PATCH(request('v2/keys', { provider: 'openai', enabled: false }, 'PATCH'))).status).toBe(200);
  if (action === 'remove') expect((await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
  const response = operation === 'status'
    ? await setup.GET(new Request(`http://localhost/api/setup/external-client?target=${runtime}`))
    : await setup.POST(request('setup/external-client', { target: runtime, remove: operation === 'remove' }));
  expect(response.status).toBe(200); expect(state.envs.length).toBeGreaterThan(0);
  for (const env of state.envs) for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY']) expect((env ?? process.env)[name] || null).toBe(null);
});
