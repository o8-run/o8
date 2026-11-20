import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { listDeclarativeRuntimes } from '@/lib/orchestrator/runtime-capabilities';

vi.mock('@/lib/runtimes/shared/owned-session/worker-o8-cli', async load => ({
  ...await load<typeof import('@/lib/runtimes/shared/owned-session/worker-o8-cli')>(),
  prepareWorkerO8Cli: async () => null,
}));

const state = vi.hoisted(() => ({ dir: '', runtime: '', envs: [] as NodeJS.ProcessEnv[], children: [] as EventEmitter[], args: [] as string[][], bridges: 0, mcp: false, mcpKey: 'fixture-stale-mcp', prepareGate: async () => {} }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtimes/shared/cli-resolver', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/cli-resolver')>(), resolveCli: vi.fn(async () => ({ path: process.execPath })) }));
vi.mock('@/lib/runtimes/shared/cli-locate', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/cli-locate')>(), resolveClaudeBinary: () => process.execPath }));
vi.mock('@/lib/runtimes/shared/owned-session/workspace-spawn-guard', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/owned-session/workspace-spawn-guard')>(), assertOwnedWorkspaceSpawnAvailable: vi.fn(async () => ({ status: 'available' })) }));
vi.mock('@/lib/hermes/runtime-resolution', () => ({ resolveHermesBinary: () => process.execPath }));
vi.mock('@/lib/deepseek-harness/runtime-resolution', () => ({ resolveDeepSeekHarnessLaunch: async () => ({ command: process.execPath, args: [] }) }));
vi.mock('@/lib/claude-code/codex-subscription-proxy', () => ({ ClaudeCodeWorkerAuthenticationError: class extends Error {}, prepareClaudeCodeWorkerConfig: async () => { await state.prepareGate(); return { configDir: join(state.dir, 'claude-config'), credentialEnv: {} }; } }));
vi.mock('@/lib/mcp/worker-injection', async original => ({ ...await original<typeof import('@/lib/mcp/worker-injection')>(), resolveWorkerMcpInjection: async () => ({ servers: state.mcp ? [{ id: 'fixture', name: 'fixture', command: process.execPath, args: [], env: { OPENAI_API_KEY: state.mcpKey, LLM_API_KEY: state.mcpKey, MCP_SERVICE_TOKEN: 'fixture-non-provider' } }] : [], skipped: [] }) }));
vi.mock('@/lib/pi/managed-usage', () => ({ createPiManagedUsageTransport: () => ({ stream: async function* () {} }) }));
vi.mock('@/lib/pi/sdk/scripts', () => ({ piSdkScriptPath: () => 'fixture-worker.mjs' }));
vi.mock('@/lib/pi/sdk/platform', () => ({ requirePiNode: () => {}, requirePiPlatform: () => {} }));
vi.mock('@/lib/runtime/pty-bridge', () => ({ spawnBridgeTerminalSession: async (payload: { env: Record<string, string>; resolvedEnvironment?: boolean; shellCommand: string }) => {
  state.bridges += 1;
  expect(payload.resolvedEnvironment).toBe(true);
  const { managedCommandLaunch } = await import('@/lib/terminal/managed-command-launch');
  const launch = managedCommandLaunch('/fixture/login-shell', payload.shellCommand, { ...process.env, GOOGLE_API_KEY: 'fixture-daemon-stale' }, payload.env, payload.resolvedEnvironment);
  state.envs.push(launch.env); return { ok: true, sessionName: `fixture-${state.runtime}`, pid: 999999999 };
} }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
  state.envs.push(options.env); state.args.push(_args);
  const child = Object.assign(new EventEmitter(), { pid: 999999999, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null as Writable | null, unref() {}, kill() { return true; } });
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of String(chunk).trim().split('\n')) {
      try {
        const frame = JSON.parse(line);
        if (frame.id && frame.method) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id,
          result: frame.method === 'initialize' ? { protocolVersion: 1, agentInfo: { name: state.runtime === 'deepseek-harness' ? 'deepseek-harness-acp' : state.runtime, version: 'fixture' }, sessionId: 'fixture', sessionFile: join(state.dir, 'session.jsonl'), tools: [] }
            : frame.method === 'session/new' ? { sessionId: 'fixture' } : frame.method === 'prompt' ? { assistantText: '', modelCalls: 0, toolCalls: 0 } : { stopReason: 'end_turn' } })}\n`));
      } catch { /* Generic CLIs may use non-JSON stdin. */ }
    }
    done();
  } });
  state.children.push(child); return child;
} }));
state.dir = realpathSync(mkdtempSync(join(tmpdir(), 'o8-launch-keys-')));
const repo = join(state.dir, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { clearMasterKeyCache } = await import('@/lib/db/master-key');
const routes = await import('./route');
const request = (method: string, provider: string, extra: object = {}) => new NextRequest('http://localhost/api/v2/keys', { method, headers: { host: 'localhost' }, body: JSON.stringify({ provider, ...extra }) });
const providers = ['openrouter', 'openai', 'anthropic', 'deepseek', 'gemini', 'groq', 'elevenlabs', 'google_tts'];
const keys = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY'];
async function changeProvider(provider: string, change: { key?: string | null; enabled?: boolean }): Promise<void> {
  if (['openrouter', 'openai', 'anthropic', 'deepseek'].includes(provider)) {
    const method = 'key' in change ? change.key === null ? 'DELETE' : 'POST' : 'PATCH';
    expect((await routes[method](request(method, provider, change))).status).toBe(200);
  } else {
    // Existing persisted keys remain governed without expanding the public CRUD surface.
    mutateProviderKey(keys[providers.indexOf(provider)], change);
  }
}
const aliases = ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const generic = ['codex', 'claude-code', 'gemini', 'cursor', 'prime-agent', 'muse', 'opencode'];
const acp = ['hermes', 'grok', 'deepseek-harness'];
const declarative = listDeclarativeRuntimes();
const modules: Record<string, { launch: (request: never) => Promise<unknown> }> = {};
beforeAll(async () => {
  const loaders = [
    ['codex', 'Codex', () => import('@/lib/codex/owned')],
    ['claude-code', 'ClaudeCode', () => import('@/lib/claude-code/owned')],
    ['gemini', 'Gemini', () => import('@/lib/gemini/owned')],
    ['cursor', 'Cursor', () => import('@/lib/cursor/owned')],
    ['prime-agent', 'PrimeAgent', () => import('@/lib/prime-agent/owned')],
    ['muse', 'Muse', () => import('@/lib/muse/owned')],
    ['opencode', 'Opencode', () => import('@/lib/opencode/owned')],
    ['hermes', 'Hermes', () => import('@/lib/hermes/owned')],
    ['grok', 'Grok', () => import('@/lib/grok/owned')],
    ['deepseek-harness', 'DeepSeekHarness', () => import('@/lib/deepseek-harness/owned')],
    ['pi', 'Pi', () => import('@/lib/pi/owned')],
    ['pi-builtin', 'PiBuiltin', () => import('@/lib/pi-builtin/owned')],
  ] as const;
  for (const [runtime, suffix, load] of loaders) {
    const runtimeModule = await load() as unknown as Record<string, ((request: never) => Promise<unknown>) | { launch: (request: never) => Promise<unknown> }>;
    modules[runtime] = { launch: runtime === 'muse' ? (runtimeModule.museOwnedStore as { launch: (request: never) => Promise<unknown> }).launch : runtimeModule[`launchOwned${suffix}Session`] as (request: never) => Promise<unknown> };
  }
  await import('@/lib/runtimes/declarative-workers');
  const { getDeclarativeOwnedRuntime } = await import('@/lib/runtimes/shared/owned-session');
  for (const runtime of declarative) modules[runtime] = { launch: getDeclarativeOwnedRuntime(runtime)!.store.launch };

});
beforeEach(() => {
  vi.unstubAllEnvs();
  state.envs.length = 0; state.args.length = 0; state.bridges = 0; state.mcp = false; state.mcpKey = 'fixture-stale-mcp'; state.prepareGate = async () => {};
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 61).toString('base64url')); clearMasterKeyCache();
  vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1'); vi.stubEnv('O8_WORKER_SANDBOX', '0');
  for (const name of [...keys, ...aliases]) vi.stubEnv(name, `fixture-ambient-${name}`);
  vi.stubEnv('XAI_API_KEY', 'fixture-unmanaged-xai'); vi.stubEnv('NOUS_API_KEY', 'fixture-unmanaged-nous');
  const hermes = join(state.dir, 'operator-hermes'); mkdirSync(hermes, { recursive: true });
  writeFileSync(join(hermes, 'config.yaml'), 'model:\n  provider: openai\n');
  writeFileSync(join(hermes, '.env'), 'SEARCH_API_KEY=fixture-unrelated-search\n');
  vi.stubEnv('HERMES_HOME', hermes);
  writeFileSync(join(state.dir, '.env.local'), '');
  rmSync(join(state.dir, 'runtime-billing'), { recursive: true, force: true });
  rmSync(join(state.dir, 'providers'), { recursive: true, force: true });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterEach(async () => { for (const child of state.children.splice(0)) child.emit('close', 0, null); await new Promise(resolve => setTimeout(resolve, 20)); });
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearMasterKeyCache(); rmSync(state.dir, { recursive: true, force: true }); });
const cases = [...[...generic, ...declarative].flatMap(runtime => ['direct', 'bridge'].map(mode => [runtime, mode])), ...acp.map(runtime => [runtime, 'acp']), ['pi', 'rpc'], ['pi-builtin', 'sdk']];
it.each(cases.flatMap(([runtime, mode]) => ['enabled', 'disable', 'remove'].map(action => [runtime, mode, action])))('%s %s launch obeys persisted %s for all provider families', async (runtime, mode, action) => {
  state.runtime = runtime;
  const billing = await import('@/lib/providers/runtime-billing');
  if (['codex', 'hermes'].includes(runtime)) expect(() => billing.saveRuntimeBillingMode(runtime, 'api')).toThrow(); else expect(() => billing.saveRuntimeBillingMode(runtime, 'api')).not.toThrow();
  vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', mode === 'bridge' ? '0' : '1');
  for (const provider of providers) {
    await changeProvider(provider, { key: `fixture-saved-${provider}` });
    if (action !== 'enabled') await changeProvider(provider, action === 'disable' ? { enabled: false } : { key: null });
  }
  const result = await modules[runtime].launch({ cwd: repo, prompt: 'fixture', runtimeConfig: { museConfigRoot: join(state.dir, 'muse-config'), museDataRoot: join(state.dir, 'muse-data') } } as never);
  expect(result).toMatchObject({ ok: true });
  expect(state.envs.length).toBeGreaterThan(0);
  for (const env of state.envs) {
    for (const [index, key] of keys.entries()) {
      const enabled = !['codex', 'hermes'].includes(runtime) && action === 'enabled' && mode !== 'sdk' && !(runtime === 'muse' && key === 'OPENROUTER_API_KEY');
      expect(env[key] || null, `${runtime} ${mode} ${key}`).toBe(enabled ? `fixture-saved-${providers[index]}` : null);
    }
    for (const key of aliases) {
      const provider = key === 'CODEX_API_KEY' ? 'openai' : key === 'ANTHROPIC_AUTH_TOKEN' ? 'anthropic' : 'gemini';
      expect(env[key] || null, `${runtime} ${mode} ${key}`).toBe(!['codex', 'hermes'].includes(runtime) && action === 'enabled' && mode !== 'sdk' ? `fixture-saved-${provider}` : null);
    }
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.NOUS_API_KEY).toBeUndefined();
  }
});

it('Windows owned launch uses direct spawn when the POSIX bridge is enabled', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(await modules['prime-agent'].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
    expect(state.envs.length).toBeGreaterThan(0); expect(state.bridges).toBe(0);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
it('ACP launch retains an explicit unmanaged provider override instead of an ambient key', async () => {
  const { AcpClient } = await import('@/lib/acp/client');
  vi.stubEnv('HERMES_HOME', '');
  const client = new AcpClient({ runtimeId: 'grok', command: process.execPath, args: [], env: { XAI_API_KEY: 'fixture-explicit-xai' } });
  expect(state.envs.at(-1)?.XAI_API_KEY).toBe('fixture-explicit-xai');
  client.kill();
});

it.each(['codex', 'claude-code'])('%s subscription default never changes payer through saved keys', async runtime => {
  state.runtime = runtime;
  for (const provider of ['openai', 'anthropic']) await changeProvider(provider, { key: `fixture-saved-${provider}` });
  expect(await modules[runtime].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  expect(state.envs.length).toBeGreaterThan(0);
  for (const env of state.envs) for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) expect(env[name] || null, name).toBeNull();
});
it.each(['disable', 'remove'])('generic aliases obey real API %s in owned spawn', async action => {
  state.runtime = 'goose';
  const billing = await import('@/lib/providers/runtime-billing');
  expect(() => billing.saveRuntimeBillingMode('goose', 'api')).not.toThrow();
  for (const name of ['LLM_PROVIDER', 'GOOSE_PROVIDER', 'COPILOT_PROVIDER_TYPE']) vi.stubEnv(name, 'openai');
  for (const alias of ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN']) vi.stubEnv(alias, 'fixture-stale-alias');
  expect((await routes.POST(request('POST', 'openai', { key: 'fixture-openai' }))).status).toBe(200);
  expect((await (action === 'disable' ? routes.PATCH(request('PATCH', 'openai', { enabled: false })) : routes.DELETE(request('DELETE', 'openai')))).status).toBe(200);
  expect(await modules.goose.launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  for (const env of state.envs) for (const name of ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN']) expect(env[name] || null, name).toBeNull();
});

it.each(['codex', 'claude-code'])('%s API billing requests preserve the supported mode across a fresh read', async runtime => {
  state.runtime = runtime;
  const billing = await import('@/lib/providers/runtime-billing');
  if (['codex', 'hermes'].includes(runtime)) expect(() => billing.saveRuntimeBillingMode(runtime, 'api')).toThrow(); else expect(() => billing.saveRuntimeBillingMode(runtime, 'api')).not.toThrow();
  expect(billing.runtimeBillingMode(runtime)).toBe(runtime === 'codex' ? 'subscription' : 'api');
  expect((await routes.POST(request('POST', runtime === 'codex' ? 'openai' : 'anthropic', { key: 'fixture-billed-api' }))).status).toBe(200);
  expect(await modules[runtime].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  expect(state.envs.at(-1)?.[runtime === 'codex' ? 'CODEX_API_KEY' : 'ANTHROPIC_API_KEY'] || null).toBe(runtime === 'codex' ? null : 'fixture-billed-api');
});

it('Copilot aliases use its provider selector when the generic LLM selector differs', async () => {
  state.runtime = 'copilot-cli';
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing'); saveRuntimeBillingMode('copilot-cli', 'api');
  vi.stubEnv('COPILOT_PROVIDER_TYPE', 'gemini'); vi.stubEnv('LLM_PROVIDER', 'openai');
  vi.stubEnv('COPILOT_PROVIDER_API_KEY', 'fixture-stale-copilot'); vi.stubEnv('COPILOT_PROVIDER_BEARER_TOKEN', 'fixture-stale-copilot');
  for (const provider of ['openai', 'gemini']) await changeProvider(provider, { key: `fixture-${provider}` });
  expect(await modules['copilot-cli'].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  expect(state.envs.at(-1)?.COPILOT_PROVIDER_API_KEY).toBe('fixture-gemini'); expect(state.envs.at(-1)?.COPILOT_PROVIDER_BEARER_TOKEN).toBe('fixture-gemini');
  state.children.at(-1)?.emit('close', 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  await changeProvider('gemini', { key: null });
  const afterRemoval = await modules['copilot-cli'].launch({ cwd: repo, prompt: 'fixture' } as never);
  expect(afterRemoval, JSON.stringify(afterRemoval)).toMatchObject({ ok: true });
  expect(state.envs.at(-1)?.COPILOT_PROVIDER_API_KEY || null).toBeNull(); expect(state.envs.at(-1)?.COPILOT_PROVIDER_BEARER_TOKEN || null).toBeNull();
});

it.each(['disable', 'remove'])('worker launch rejects API %s during asynchronous credential preparation', async action => {
  state.runtime = 'claude-code';
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
  saveRuntimeBillingMode('claude-code', 'api');
  expect((await routes.POST(request('POST', 'anthropic', { key: 'fixture-race-provider' }))).status).toBe(200);
  state.prepareGate = async () => {
    state.prepareGate = async () => {};
    const response = action === 'disable' ? await routes.PATCH(request('PATCH', 'anthropic', { enabled: false })) : await routes.DELETE(request('DELETE', 'anthropic'));
    expect(response.status).toBe(200);
  };
  await expect(modules['claude-code'].launch({ cwd: repo, prompt: 'fixture' } as never)).rejects.toThrow(/credentials or billing changed/i);
  expect(state.envs).toEqual([]);
});

it('preserves deferred Codex MCP environment payloads without authorizing the parent provider', async () => {
  state.runtime = 'codex'; state.mcp = true; state.mcpKey = 'fixture-deferred-mcp-provider';
  expect((await routes.POST(request('POST', 'openai', { key: state.mcpKey }))).status).toBe(200);
  const result = await modules.codex.launch({ cwd: repo, prompt: 'fixture', packetId: 'fixture-mcp' } as never);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(state.args.at(-1)?.join(' ')).toContain(state.mcpKey);
  expect(state.envs.at(-1)?.OPENAI_API_KEY || null).toBeNull();
});
