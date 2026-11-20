import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ dir: '', envs: [] as NodeJS.ProcessEnv[], spawn: vi.fn() }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: process.execPath }), CliNotFoundError: class extends Error {} }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: state.spawn }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: state.spawn }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-key-chat-routes-'));
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/lib/providers/runtime-billing');
const codexSend = await import('@/app/api/codex/send/route');
const proxy = await import('@/app/api/v2/proxy/cli/route');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
const targets = [
  ['workspace-codex', 'codex', 'openai', 'OPENAI_API_KEY'],
  ['proxy-codex', 'codex', 'openai', 'OPENAI_API_KEY'],
  ['proxy-gemini', 'gemini', 'gemini', 'GEMINI_API_KEY'],
  ['proxy-opencode', 'opencode', 'openai', 'OPENAI_API_KEY'],
] as const;
const names = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_AI_API_KEY'];
beforeEach(() => {
  state.envs.length = 0;
  writeFileSync(join(state.dir, '.env.local'), '');
  writeFileSync(join(state.dir, 'repos.json'), JSON.stringify([{ id: 'fixture', name: 'fixture', localPath: state.dir }]));
  rmSync(join(state.dir, 'runtime-billing'), { recursive: true, force: true });
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 81).toString('base64url'));
  for (const name of names) vi.stubEnv(name, '');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  state.spawn.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    state.envs.push(options.env);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {} }, kill() {} });
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"fixture"}}\n')); child.emit('close', 0); });
    return child;
  });
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { recursive: true, force: true }); });
async function save(provider: string) { if (provider === 'gemini') { mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-saved-chat-key' }); return; } expect((await keys.POST(request('v2/keys', { provider, key: 'fixture-saved-chat-key' }))).status).toBe(200); }
async function chat(target: string, runtime: string) {
  const response = target === 'workspace-codex'
    ? await codexSend.POST(request('codex/send', { message: 'fixture' }))
    : await proxy.POST(request('v2/proxy/cli', { runtime, model: 'fixture', repoPath: state.dir, messages: [{ role: 'user', content: 'fixture' }] }));
  expect(response.status).toBe(200); await response.text(); expect(state.envs.length).toBeGreaterThan(0);
}
it('preserves deferred save-to-ambient behavior while the real ordinary chat stays subscription billed', async () => {
  await save('openai');
  expect((await keys.GET(new NextRequest('http://localhost/api/v2/keys', { headers: { host: 'localhost' } }))).status).toBe(200);
  expect(process.env.OPENAI_API_KEY).toBe('fixture-saved-chat-key'); expect(process.env.CODEX_API_KEY).toBe('');
  await chat('workspace-codex', 'codex');
  expect(state.envs.at(-1)?.OPENAI_API_KEY || null).toBeNull();
});
it.each(targets.flatMap(target => (['subscription', 'api'] as const).map(mode => [...target, mode] as const)))('%s (%s, %s, %s) applies %s billing at the real chat spawn', async (target, runtime, provider, canonical, mode) => {
  if (runtime === 'codex' && mode === 'api') expect(() => billing.saveRuntimeBillingMode(runtime, mode)).toThrow(); else expect(() => billing.saveRuntimeBillingMode(runtime, mode)).not.toThrow();
  await save(provider); await chat(target, runtime);
  expect(state.envs.at(-1)?.[canonical] || null).toBe(runtime !== 'codex' && mode === 'api' ? 'fixture-saved-chat-key' : null);
});
it.each(targets.flatMap(target => ['disable', 'remove'].map(action => [...target, action] as const)))('%s (%s, %s, %s) strips keys after API %s', async (target, runtime, provider, _canonical, action) => {
  if (runtime === 'codex') expect(() => billing.saveRuntimeBillingMode(runtime, 'api')).toThrow(); else expect(() => billing.saveRuntimeBillingMode(runtime, 'api')).not.toThrow();
  await save(provider);
  for (const name of names) vi.stubEnv(name, 'fixture-stale-alias');
  if (provider === 'gemini') mutateProviderKey('GEMINI_API_KEY', action === 'disable' ? { enabled: false } : { key: null });
  else expect((await (action === 'disable' ? keys.PATCH(request('v2/keys', { provider, enabled: false }, 'PATCH')) : keys.DELETE(request('v2/keys', { provider }, 'DELETE')))).status).toBe(200);
  await chat(target, runtime);
  const aliases = provider === 'openai' ? ['OPENAI_API_KEY', 'CODEX_API_KEY'] : ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY'];
  for (const env of state.envs) for (const name of aliases) expect(env[name] || null, name).toBeNull();
});
it('keeps the retired Claude print proxy closed without spawning a process', async () => {
  await save('anthropic');
  const response = await proxy.POST(request('v2/proxy/cli', { runtime: 'claude-code', model: 'fixture', repoPath: state.dir, messages: [{ role: 'user', content: 'fixture' }] }));
  expect(response.status).toBe(410); expect(state.envs).toEqual([]);
});
