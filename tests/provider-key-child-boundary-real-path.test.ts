import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-child-boundary-'));
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { childEnvironment, internalBrokerEnvironment } = await import('@/lib/providers/spawn-environment');
const cp = await import('@/lib/providers/child-process');
const { bindDeferredCodexMcpLaunch } = await import('@/lib/providers/deferred-mcp-arguments');
const script = join(state.dir, 'observe.cjs');
const output = join(state.dir, 'observed.json');
writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify([process.env.OPENAI_API_KEY ?? null, process.env.LOGIN_COPY ?? null]));`);
beforeEach(() => {
  vi.stubEnv('HOME', state.dir);
  vi.stubEnv('CODEX_HOME', join(state.dir, '.codex'));
  mkdirSync(join(state.dir, '.codex'), { recursive: true });
  writeFileSync(join(state.dir, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: 'fixture-oauth' } }));
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 99).toString('base64url'));
  vi.stubEnv('OPENAI_API_KEY', 'fixture-boundary-key'); vi.stubEnv('LOGIN_COPY', 'fixture-boundary-key');
  writeFileSync(join(state.dir, '.env.local'), '');
  mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-boundary-key' });
  saveRuntimeBillingMode('gemini', 'subscription');
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });
it.each(['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'promisified', 'fork'])('%s rejects implicit ambient provider credentials', async operation => {
  if (operation === 'spawnSync') expect(cp.spawnSync(process.execPath, [script]).status).toBe(0);
  else if (operation === 'execFileSync') cp.execFileSync(process.execPath, [script]);
  else if (operation === 'execSync') cp.execSync(`"${process.execPath}" "${script}"`);
  else if (operation === 'promisified') await promisify(cp.execFile)(process.execPath, [script]);
  else if (operation === 'execFile') await new Promise<void>((resolve, reject) => cp.execFile(process.execPath, [script], error => error ? reject(error) : resolve()));
  else await new Promise<void>((resolve, reject) => {
    const child = operation === 'fork' ? cp.fork(script) : cp.spawn(process.execPath, [script]);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual([null, null]);
});
it('rejects a prepared API environment after billing changes before the actual spawn', () => {
  saveRuntimeBillingMode('gemini', 'api');
  const env = childEnvironment({ runtimeId: 'gemini' });
  saveRuntimeBillingMode('gemini', 'subscription');
  expect(() => cp.spawnSync(process.execPath, [script], { env })).toThrow(/changed during child preparation/);
});
it('rejects historical credential values retained in prepared arguments after a restart', async () => {
  mutateProviderKey('OPENAI_API_KEY', { key: null });
  vi.resetModules();
  const fresh = await import('@/lib/providers/child-process');
  expect(() => fresh.spawnSync(process.execPath, [script, '--header=Bearer fixture-boundary-key'])).toThrow(/arguments contain/);
});
it('preserves API mode without copying an unlisted ambient alias at the actual process boundary', () => {
  saveRuntimeBillingMode('gemini', 'api');
  cp.execFileSync(process.execPath, [script], { env: childEnvironment({ runtimeId: 'gemini' }) });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(['fixture-boundary-key', null]);
});
it.each(['api', 'subscription'] as const)('preserves work admission and credential policy in %s', async mode => {
  saveRuntimeBillingMode('gemini', mode);
  const { spawnWithWorkAdmission } = await import('@/lib/app-update/work-launch-admission');
  const { childEnvironment: admittedEnvironment } = await import('@/lib/providers/spawn-environment');
  const child = spawnWithWorkAdmission(process.execPath, [script], mode === 'api' ? { env: admittedEnvironment({ runtimeId: 'gemini' }) } : {});
  const leases = join(state.dir, 'work-launches');
  const records = readdirSync(leases);
  expect(records).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(leases, records[0]!), 'utf8')).pid).toBe(child.pid);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(mode === 'api' ? ['fixture-boundary-key', null] : [null, null]);
  expect(readdirSync(leases)).toEqual([]);
});

it('the real app bridge can reread an override-encrypted store without giving its runtime the master key', async () => {
  saveRuntimeBillingMode('codex', 'subscription');
  const target = join(state.dir, 'fixture-codex');
  writeFileSync(target, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({key:process.env.OPENAI_API_KEY??null,master:process.env.O8_MASTER_KEY??null}));process.exit(0);`);
  chmodSync(target, 0o755);
  const spec = join(state.dir, 'bridge-spec.json');
  writeFileSync(spec, JSON.stringify({ codexBin: target, cwd: state.dir, threadId: null, developerInstructions: null, message: 'Fixture', imagePaths: [], model: 'fixture', effort: 'low', serviceTier: null, sandbox: 'read-only', config: {} }));
  rmSync(output, { force: true });
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'src/lib/codex/app-server-exec-bridge.ts', spec], {
      env: internalBrokerEnvironment(childEnvironment({ runtimeId: 'codex', env: { O8_DATA_DIR: state.dir } })),
    });
    let stderr = '';
    child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', () => stderr.includes('Credential store unavailable') ? reject(new Error(stderr)) : resolve());
  });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ key: null, master: null });
}, 20_000);
it.each(['subscription', 'remove'])('strips embedded provider copies from auxiliary env after %s', async mode => {
  if (mode === 'remove') mutateProviderKey('OPENAI_API_KEY', { key: null });
  vi.resetModules();
  const fresh = await import('@/lib/providers/child-process');
  const result = fresh.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.AUTHORIZATION??null,process.env.JSON_AUTH??null]))'], {
    encoding: 'utf8', env: { NODE_ENV: 'test', AUTHORIZATION: 'Bearer fixture-boundary-key', JSON_AUTH: '{"key":"prefix-fixture-boundary-key-suffix"}' },
  });
  expect(JSON.parse(result)).toEqual([null, null]);
});
it.each(['subscription', 'api'] as const)('keeps nested encoded credentials out of auxiliary fields in %s billing', mode => {
  saveRuntimeBillingMode('gemini', mode);
  const hidden = JSON.stringify({ outer: JSON.stringify({ auth: Buffer.from('fixture-boundary-key').toString('base64url') }) });
  const benign = JSON.stringify({ auth: Buffer.from('fixture-service').toString('base64'), region: 'fixture-region', endpoint: 'https://example.invalid/mcp' });
  const result = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({key:!!process.env.OPENAI_API_KEY,hidden:!!process.env.SERVICE_AUTH_CONFIG,benign:process.env.UNRELATED_SERVICE_CONFIG}))'], {
    encoding: 'utf8', env: childEnvironment({ runtimeId: 'gemini', env: { SERVICE_AUTH_CONFIG: hidden, UNRELATED_SERVICE_CONFIG: benign } }),
  });
  expect(JSON.parse(result)).toEqual({ key: mode === 'api', hidden: false, benign });
});
it('inspects ordered query values independently of query names before child launch', () => {
  const value = 'fixture-boundary-key';
  const hidden = 'https://example.invalid/?first=' + encodeURIComponent(value.slice(0, 11)) + '&second=' + encodeURIComponent(value.slice(11));
  const result = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(String(!!process.env.SERVICE_AUTH_CONFIG))'], {
    encoding: 'utf8', env: { NODE_ENV: 'test', SERVICE_AUTH_CONFIG: hidden },
  });
  expect(result).toBe('false');
});
it.each(['depth', 'bytes', 'nodes'])('drops an opaque field exceeding the %s inspection budget before actual launch', limit => {
  let value = 'fixture-service';
  if (limit === 'depth') {
    let nested: unknown = value;
    for (let i = 0; i < 24; i++) nested = { nested };
    value = JSON.stringify(nested);
  }
  else if (limit === 'bytes') value = 'x'.repeat(256 * 1024 + 1);
  else value = JSON.stringify(Array.from({ length: 1025 }, (_, index) => String(index)));
  const result = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({opaque:!!process.env.SERVICE_AUTH_CONFIG,service:process.env.SERVICE_AUTH}))'], {
    encoding: 'utf8', env: childEnvironment({ runtimeId: 'gemini', env: { SERVICE_AUTH_CONFIG: value, SERVICE_AUTH: 'fixture-service' } }),
  });
  expect(JSON.parse(result)).toEqual({ opaque: false, service: 'fixture-service' });
});
it('rechecks encoded subscription transport values at the actual child boundary', async () => {
  const { retainChildTransportCredentials } = await import('@/lib/providers/spawn-environment');
  const env = childEnvironment({ runtimeId: 'gemini' });
  env.ANTHROPIC_AUTH_TOKEN = Buffer.from('fixture-boundary-key').toString('base64');
  retainChildTransportCredentials(env, ['ANTHROPIC_AUTH_TOKEN']);
  const result = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(String(!!process.env.ANTHROPIC_AUTH_TOKEN))'], { encoding: 'utf8', env });
  expect(result).toBe('false');
});
it('does not restore an encoded credential name with an empty value at raw spawn', () => {
  const name = Buffer.from('fixture-boundary-key').toString('base64url');
  const result = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(String(Object.keys(process.env).some(name=>name!=="NODE_ENV")))'], {
    encoding: 'utf8', env: { NODE_ENV: 'test', [name]: '' },
  });
  expect(result).toBe('false');
});

it('preserves policy and options with an explicitly omitted child argument array', async () => {
  saveRuntimeBillingMode('gemini', 'api');
  const env = childEnvironment({ runtimeId: 'gemini' });
  const sync = cp.spawnSync(process.execPath, undefined, { env, input: 'process.stdout.write(process.env.OPENAI_API_KEY)', encoding: 'utf8' });
  expect(sync.stdout).toBe('fixture-boundary-key');
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = cp.execFile(process.execPath, undefined, { env }, (error, result) => error ? reject(error) : resolve(result));
    child.stdin!.end('process.stdout.write(process.env.OPENAI_API_KEY)');
  });
  expect(stdout).toBe('fixture-boundary-key');
});

it.each(['subscription', 'api'] as const)('preserves unrelated service credentials at the real %s child boundary', mode => {
  saveRuntimeBillingMode('gemini', mode);
  const result = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.BRAVE_API_KEY,process.env.GITHUB_TOKEN,process.env.SEARCH_API_KEY,process.env.MCP_API_KEY]))'], {
    encoding: 'utf8', env: childEnvironment({ runtimeId: 'gemini', env: { BRAVE_API_KEY: 'fixture-brave', GITHUB_TOKEN: 'fixture-github', SEARCH_API_KEY: 'fixture-search', MCP_API_KEY: 'fixture-mcp' } }),
  });
  expect(JSON.parse(result)).toEqual(['fixture-brave', 'fixture-github', 'fixture-search', 'fixture-mcp']);
});

it.each(['argv', 'shell'])('rejects an unsaved ambient provider credential copied into prepared %s', form => {
  writeFileSync(join(state.dir, '.env.local'), '');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-unsaved-provider');
  const env = childEnvironment({ runtimeId: 'gemini' });
  expect(() => form === 'argv'
    ? cp.execFileSync(process.execPath, ['-e', 'process.exit(0)', '--', '--header=Bearer fixture-unsaved-provider'], { env })
    : cp.execSync('echo "Bearer fixture-unsaved-provider"', { env })).toThrow(/arguments contain/);
});

it('rejects an unsaved explicit provider credential retained in prepared argv', () => {
  const env = childEnvironment({ runtimeId: 'gemini', inherit: false, env: { OPENAI_API_KEY: 'fixture-explicit-provider' } });
  expect(() => cp.execFileSync(process.execPath, ['-e', 'process.exit(0)', '--', 'Bearer fixture-explicit-provider'], { env })).toThrow(/arguments contain/);
});
it('preserves explicit local subscription transport at the actual child boundary', async () => {
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', ''); vi.stubEnv('ANTHROPIC_API_KEY', '');
  const { ownedSpawnEnvironment } = await import('@/lib/runtimes/shared/owned-session/restricted-spawn-env');
  const env = ownedSpawnEnvironment({ surfaceId: 'claude-code-owned:fixture', runtimeConfig: { modelSource: 'codex-subscription' } } as never, { ANTHROPIC_BASE_URL: 'http://127.0.0.1/fixture-transport', ANTHROPIC_AUTH_TOKEN: 'fixture-transport', ANTHROPIC_API_KEY: '' });
  const { execFileSync: launch } = await import('@/lib/providers/child-process');
  const result = launch(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.ANTHROPIC_AUTH_TOKEN,process.env.ANTHROPIC_BASE_URL]))'], { encoding: 'utf8', env });
  expect(JSON.parse(result)).toEqual(['fixture-transport', 'http://127.0.0.1/fixture-transport']);
});

it.each([
  'mcp_servers.fixture.env={KEY="fixture-boundary-key"}\nOPENAI_API_KEY="fixture-boundary-key"',
  'mcp_servers.fixture.command="fixture-boundary-key"',
])('does not exempt parent auth or MCP command credentials disguised as config', arg => {
  const env = childEnvironment({ runtimeId: 'codex' });
  expect(() => cp.execFileSync(process.execPath, ['-e', 'process.exit(0)', '--', '-c', arg], { env })).toThrow(/arguments contain/);
});
it('does not grant an unidentified runtime the deferred Codex MCP argument exception', () => {
  const env = childEnvironment();
  expect(() => cp.execFileSync(process.execPath, ['-e', 'process.exit(0)', '--', '-c', 'mcp_servers.fixture.env={KEY="fixture-boundary-key"}'], { env })).toThrow(/arguments contain/);
});

it('rejects a shell command disguised as a deferred Codex MCP environment', () => {
  const target = join(state.dir, 'shell-extracted');
  rmSync(target, { force: true });
  const env = childEnvironment({ runtimeId: 'codex' });
  const arg = `mcp_servers.fixture.env={KEY="$(printf fixture-boundary-key > '${target}')"}`;
  expect(() => cp.spawnSync('/bin/sh', ['-c', arg], { env })).toThrow(/arguments contain/);
  expect(readdirSync(state.dir)).not.toContain('shell-extracted');
});

it.each(['original', 'command', 'arguments', 'copied environment', 'shell option'] as const)('never exempts a registered MCP credential from argv checks: %s', form => {
  const env = childEnvironment({ runtimeId: 'codex' });
  const args = ['-e', 'process.stdout.write(JSON.stringify([process.env.OPENAI_API_KEY??null,process.argv.at(-1)]))', '--', '-c', 'mcp_servers.fixture.env={KEY="fixture-boundary-key"}'];
  const invocation = bindDeferredCodexMcpLaunch(env, args, [{ name: 'fixture', env: { KEY: 'fixture-boundary-key' } }], checked => ({ command: process.execPath, args: checked }));
  const launch = () => cp.execFileSync(form === 'command' ? '/bin/sh' : invocation.command,
    form === 'arguments' ? [...invocation.args, 'changed'] : invocation.args,
    { env: form === 'copied environment' ? { ...env } : env, shell: form === 'shell option', encoding: 'utf8' });
  expect(launch).toThrow(/arguments contain/);
});
