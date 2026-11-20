import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ dir: '', spawned: false, hook: undefined as undefined | (() => Promise<void>), envs: [] as NodeJS.ProcessEnv[], children: [] as Array<EventEmitter & { killed: boolean }> }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.dir }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
vi.mock('node:net', () => ({ createConnection: () => {
  const socket = Object.assign(new EventEmitter(), { destroy() {}, setTimeout() { return socket; } });
  queueMicrotask(async () => {
    if (!state.spawned) { socket.emit('error', new Error('fixture refused')); return; }
    const hook = state.hook; state.hook = undefined; if (hook) await hook(); socket.emit('connect');
  }); return socket;
} }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
  state.spawned = true; state.envs.push(options.env);
  const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.killed = true; state.spawned = false; queueMicrotask(() => { child.emit('close', 0); child.emit('exit', 0); }); return true; } });
  state.children.push(child); return child;
} }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-gateway-policy-'));
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubEnv('HOME', state.dir);
  state.spawned = false; state.hook = undefined; state.envs = []; state.children = [];
  rmSync(join(state.dir, '.env.local'), { force: true }); rmSync(join(state.dir, 'runtime-billing'), { recursive: true, force: true }); rmSync(join(state.dir, 'openclaw-gateway-policy'), { force: true });
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 73).toString('base64url')); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} }))); vi.resetModules();
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { recursive: true, force: true }); });
it.each(['disable', 'remove'])('refuses a gateway whose launch policy changes to %s during readiness', async action => {
  const keys = await import('@/app/api/v2/keys/route'); const billing = await import('@/lib/providers/runtime-billing');
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-gateway-key' }))).status).toBe(200);
  expect(() => billing.saveRuntimeBillingMode('openclaw', 'api')).toThrow();
  state.hook = async () => {
    const response = action === 'disable' ? await keys.PATCH(request('v2/keys', { provider: 'openai', enabled: false }, 'PATCH')) : await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'));
    expect(response.status).toBe(200);
  };
  const { ensureOpenclawGateway } = await import('./openclaw-gateway');
  await expect(ensureOpenclawGateway(34124, 'fixture-gateway')).rejects.toThrow('changed during gateway startup');
  expect(state.envs[0].OPENAI_API_KEY || null).toBeNull(); expect(state.children[0].killed).toBe(true);
  expect(existsSync(join(state.dir, 'openclaw-gateway-policy'))).toBe(false);
  await ensureOpenclawGateway(34124, 'fixture-gateway');
  expect(state.envs[1].OPENAI_API_KEY || null).toBeNull(); expect(existsSync(join(state.dir, 'openclaw-gateway-policy'))).toBe(true);
  state.children.at(-1)!.emit('exit', 0);
});
