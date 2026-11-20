import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn as previousVersionSpawn } from 'node:child_process';

const state = vi.hoisted(() => ({ home: '', data: '', index: 0 }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.data }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
const root = mkdtempSync(join(tmpdir(), 'o8-file-billing-split-'));
const key = 'fixture-previous-version-api-credential';

beforeEach(async () => {
  vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  state.home = join(root, String(++state.index)); state.data = join(state.home, 'data');
  mkdirSync(state.data, { recursive: true });
  vi.stubEnv('HOME', state.home); vi.stubEnv('HERMES_HOME', '');
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 107).toString('base64url'));
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  mutateProviderKey('OPENAI_API_KEY', { key });
});
afterAll(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each(['hermes', 'openclaw', 'acp'])('billing policy refuses file/unknown-contract API billing for %s', async runtimeId => {
  const billing = await import('@/lib/providers/runtime-billing');
  expect(() => billing.saveRuntimeBillingMode(runtimeId, 'api')).toThrow();
});

it('an environment-based runtime still receives its saved API key through an actual child', async () => {
  const billing = await import('@/lib/providers/runtime-billing');
  expect(() => billing.saveRuntimeBillingMode('claude-code', 'api')).not.toThrow();
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync } = await import('@/lib/providers/child-process');
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({key:!!process.env.OPENAI_API_KEY,service:process.env.BRAVE_API_KEY}))'], {
    encoding: 'utf8', env: childEnvironment({ runtimeId: 'claude-code', env: { BRAVE_API_KEY: 'fixture-search' } }),
  });
  expect(JSON.parse(output)).toEqual({ key: true, service: 'fixture-search' });
});

async function legacyHermesFile() {
  const home = join(state.data, 'hermes-o8'); const file = join(home, '.hermes', 'auth.json');
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: key }));
  const { encryptValueSync } = await import('@/lib/db/master-key');
  const encrypted = encryptValueSync(JSON.stringify({ path: realpathSync(file), runtime: 'hermes', owner: 'o8', contents: '{}' }));
  writeFileSync(join(state.data, 'owned-credential-artifacts.json'), JSON.stringify([{ path: realpathSync(file), runtime: 'hermes', owner: 'o8', replacement: `enc:${encrypted.iv}:${encrypted.ciphertext}` }]));
  return { home, file };
}

it.each([undefined, 'acp', 'hermes'] as const)('a subscription ACP child with identity %s cannot consume a legacy file while an older API child keeps rewriting it', async runtimeId => {
  const { home, file } = await legacyHermesFile();
  const writer = join(state.home, 'previous-version.cjs');
  writeFileSync(writer, `const fs=require('node:fs');let count=0;const write=()=>{fs.writeFileSync(${JSON.stringify(file)}+'.older',JSON.stringify({OPENAI_API_KEY:process.env.OPENAI_API_KEY,count:++count}));fs.renameSync(${JSON.stringify(file)}+'.older',${JSON.stringify(file)});};write();console.log('ready');const timer=setInterval(write,2);process.stdin.on('end',()=>{clearInterval(timer);process.exit(0)});process.stdin.resume();`);
  // Emulate an already-running binary from before the policy upgrade.
  const older = previousVersionSpawn(process.execPath, [writer], { env: { NODE_ENV: 'test', OPENAI_API_KEY: key }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: older.stdout })[Symbol.asyncIterator]();
  const marker = join(state.home, 'new-child-started');
  try {
    expect((await lines.next()).value).toBe('ready');
    const peer = join(state.home, 'subscriber.cjs');
    writeFileSync(peer, `const fs=require('node:fs'),p=require('node:path');fs.writeFileSync(${JSON.stringify(marker)},'started');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);setTimeout(()=>{let auth;try{auth=JSON.parse(fs.readFileSync(p.join(process.env.HOME,'.hermes','auth.json'),'utf8'))}catch{auth={}};if(m.id)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1}:m.method==='session/new'?{sessionId:'fixture',configOptions:[{id:'key',currentValue:String(!!auth.OPENAI_API_KEY||!!process.env.OPENAI_API_KEY)}]}:{}}));},30)});`);
    const { AcpClient } = await import('@/lib/acp/client');
    let client: InstanceType<typeof AcpClient> | undefined; let refused = false; let observedKey = false;
    try {
      client = new AcpClient({ runtimeId: runtimeId as string, command: process.execPath, args: [peer], env: { HOME: home } });
      await client.initialize(); observedKey = (await client.newSession(state.home, [])).configOptions[0].currentValue === 'true';
    } catch (error) {
      refused = error instanceof Error && error.message.includes('#4340');
    } finally { client?.kill(); }
    expect({ refused, admitted: existsSync(marker), observedKey }).toEqual({ refused: true, admitted: false, observedKey: false });
    expect(readFileSync(file, 'utf8')).toContain(key);
  } finally { older.kill(); }
});

it('leaves earlier o8 files untouched on disable/removal and warns only once per file', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { file } = await legacyHermesFile(); const before = readFileSync(file, 'utf8');
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  mutateProviderKey('OPENAI_API_KEY', { enabled: false });
  mutateProviderKey('OPENAI_API_KEY', { key: null });
  expect(readFileSync(file, 'utf8')).toBe(before);
  const notices = warning.mock.calls.filter(args => args.some(value => String(value).includes('[payer-policy] Legacy o8 runtime config left unchanged.')));
  expect(notices).toHaveLength(1);
  expect(notices.flat().join(' ')).toContain('#4340');
  expect(notices.flat().join(' ')).not.toContain(file);
  expect(notices.flat().join(' ')).not.toContain(key);
});

it('Hermes preparation omits a saved key from its new copy and preserves the operator source', async () => {
  const source = join(state.home, '.hermes'); mkdirSync(source);
  const raw = `model:\n  provider: openai\n  api_key: ${key}\n`;
  writeFileSync(join(source, 'config.yaml'), raw);
  const { prepareHermesWorkerHome } = await import('@/lib/hermes/worker-profile');
  const session = join(state.data, 'session'); mkdirSync(session);
  prepareHermesWorkerHome(session);
  expect(readFileSync(join(source, 'config.yaml'), 'utf8')).toBe(raw);
  expect(readFileSync(join(session, 'hermes-home', 'config.yaml'), 'utf8')).not.toContain(key);
});

it('OpenClaw preparation omits a saved key from its new profile and preserves the operator source', async () => {
  const source = join(state.home, '.openclaw'); mkdirSync(source);
  const raw = JSON.stringify({ agents: { list: [{ id: 'main' }] }, models: { providers: { openai: { apiKey: key } } }, mcp: { servers: { o8: {} } } });
  writeFileSync(join(source, 'openclaw.json'), raw);
  const { prepareOpenclawProfile } = await import('@/lib/lane/orchestrator-backends/openclaw-profile');
  prepareOpenclawProfile(34123);
  expect(readFileSync(join(source, 'openclaw.json'), 'utf8')).toBe(raw);
  expect(readFileSync(join(state.home, '.openclaw-o8', 'openclaw.json'), 'utf8')).not.toContain(key);
});

it.each(['relative', 'symlink'])('refuses a %s alias to an earlier Hermes profile through the actual child boundary', async alias => {
  const { home } = await legacyHermesFile();
  const selected = join(state.home, 'alias');
  symlinkSync(join(home, '.hermes'), selected);
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync } = await import('@/lib/providers/child-process');
  expect(() => execFileSync(process.execPath, ['-e', 'process.stdout.write("started")'], { env: childEnvironment({ runtimeId: 'acp', env: { HERMES_HOME: alias === 'relative' ? relative(process.cwd(), selected) : selected } }) })).toThrow(/#4340/);
});
it('permits operator-auth changes to an unregistered freshly seeded Hermes profile without rewriting them', async () => {
  const source = join(state.home, '.hermes'); mkdirSync(source);
  writeFileSync(join(source, 'config.yaml'), 'model: {provider: openai}');
  const { prepareHermesWorkerHome } = await import('@/lib/hermes/worker-profile');
  const { hermesHome } = prepareHermesWorkerHome(join(state.data, 'session'));
  const file = join(hermesHome, 'auth.json'); writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: key }));
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync } = await import('@/lib/providers/child-process');
  expect(execFileSync(process.execPath, ['-e', 'process.stdout.write("started")'], { encoding: 'utf8', env: childEnvironment({ runtimeId: 'hermes', env: { HERMES_HOME: hermesHome } }) })).toBe('started');
  expect(readFileSync(file, 'utf8')).toContain(key);
});

it.each(['hermes', 'openclaw', 'acp'])('%s ignores a stale API billing record through a real spawn without credential files', async runtimeId => {
  const billingDir = join(state.data, 'runtime-billing'); mkdirSync(billingDir);
  writeFileSync(join(billingDir, `${runtimeId}.json`), JSON.stringify({ version: 1, mode: 'api' }));
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync } = await import('@/lib/providers/child-process');
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(!!process.env.OPENAI_API_KEY||!!process.env.CODEX_API_KEY||!!process.env.LLM_API_KEY))'], {
    encoding: 'utf8', env: childEnvironment({ runtimeId, env: { LLM_PROVIDER: 'openai', LLM_API_KEY: key } }),
  });
  expect(output).toBe('false');
});
it('permits a generic ACP launch selecting an unregistered operator Claude profile through a symlink', async () => {
  const home = join(state.data, 'owned-claude-code', 'session', 'config'); mkdirSync(home, { recursive: true });
  const file = join(home, 'settings.json'); writeFileSync(file, JSON.stringify({ env: { OPENAI_API_KEY: key } }));
  const alias = join(state.home, 'selected-profile'); symlinkSync(home, alias);
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync } = await import('@/lib/providers/child-process');
  expect(execFileSync(process.execPath, ['-e', 'process.stdout.write("started")'], { encoding: 'utf8', env: childEnvironment({ runtimeId: 'acp', env: { CLAUDE_CONFIG_DIR: alias } }) })).toBe('started');
  expect(readFileSync(file, 'utf8')).toContain(key);
});

it('an environment-based API runtime keeps its ordinary key-free owned config home', async () => {
  const config = join(state.data, 'owned-claude-code', 'session', 'config'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ tools: [] }));
  const billing = await import('@/lib/providers/runtime-billing');
  expect(() => billing.saveRuntimeBillingMode('claude-code', 'api')).not.toThrow();
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync } = await import('@/lib/providers/child-process');
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({key:!!process.env.OPENAI_API_KEY,home:process.env.CLAUDE_CONFIG_DIR}))'], {
    encoding: 'utf8', env: childEnvironment({ runtimeId: 'claude-code', env: { CLAUDE_CONFIG_DIR: config } }),
  });
  expect(JSON.parse(output)).toEqual({ key: true, home: config });
});

it('Claude OAuth seed refuses a saved provider key before copying the source credential file', async () => {
  const source = join(state.home, '.claude'); mkdirSync(source);
  const file = join(source, '.credentials.json');
  const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-account-access', refreshToken: 'fixture-account-refresh' }, OPENAI_API_KEY: key });
  writeFileSync(file, raw);
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  mutateProviderKey('ANTHROPIC_API_KEY', { key: 'fixture-env-native-auth' });
  const billing = await import('@/lib/providers/runtime-billing');
  expect(() => billing.saveRuntimeBillingMode('claude-code', 'api')).not.toThrow();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const session = join(state.data, 'claude-session');
  try {
    const { prepareClaudeCodeWorkerConfig } = await import('@/lib/claude-code/codex-subscription-proxy');
    await expect(prepareClaudeCodeWorkerConfig(session, 'native')).rejects.toThrow(/#4340/);
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(existsSync(join(session, 'claude-code-worker-config', '.credentials.json'))).toBe(false);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
