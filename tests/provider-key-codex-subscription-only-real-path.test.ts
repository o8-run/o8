import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ home: '', data: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.data }));
fixture.home = mkdtempSync(join(tmpdir(), 'o8-codex-subscription-'));
fixture.data = join(fixture.home, 'data');
const source = join(fixture.home, '.codex');
mkdirSync(source); mkdirSync(fixture.data);
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const cp = await import('@/lib/providers/child-process');
const billing = await import('@/lib/providers/runtime-billing');
const observer = `const f=require('node:fs'),p=require('node:path'),h=process.env.CODEX_HOME||p.join(process.env.HOME,'.codex');process.stdout.write(JSON.stringify({home:h,explicit:process.env.CODEX_HOME??null,auth:JSON.parse(f.readFileSync(p.join(h,'auth.json'),'utf8')),keys:['OPENAI_API_KEY','CODEX_API_KEY','LLM_API_KEY','GOOSE_API_KEY','COPILOT_PROVIDER_API_KEY','COPILOT_PROVIDER_BEARER_TOKEN'].map(n=>process.env[n]||null),service:process.env.BRAVE_API_KEY}));`;
function forceApi(id: string): void {
  mkdirSync(join(fixture.data, 'runtime-billing'), { recursive: true });
  writeFileSync(join(fixture.data, 'runtime-billing', `${id}.json`), JSON.stringify({ version: 1, mode: 'api' }));
}
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 65).toString('base64url'));
  vi.stubEnv('HOME', fixture.home); vi.stubEnv('CODEX_HOME', undefined);
  vi.stubEnv('OPENAI_API_KEY', 'fixture-codex-saved'); vi.stubEnv('CODEX_API_KEY', 'fixture-codex-saved');
  rmSync(fixture.data, { force: true, recursive: true }); mkdirSync(fixture.data);
  writeFileSync(join(source, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'fixture-operator-account' } }));
  mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-codex-saved' });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(fixture.home, { force: true, recursive: true }); });

it.each([false, true])('forced Codex API billing strips credentials and preserves main home selection (explicit=%s)', explicit => {
  forceApi('codex');
  const selected = explicit ? join(fixture.home, 'selected-account') : source;
  mkdirSync(selected, { recursive: true });
  const raw = JSON.stringify({ tokens: { refresh_token: 'fixture-selected-account' } });
  writeFileSync(join(selected, 'auth.json'), raw);
  const env = childEnvironment({ runtimeId: 'codex', env: {
    ...(explicit ? { CODEX_HOME: selected } : {}), BRAVE_API_KEY: 'fixture-search',
    LLM_API_KEY: 'fixture-codex-saved', LLM_PROVIDER: 'openai', GOOSE_API_KEY: 'fixture-codex-saved', GOOSE_PROVIDER: 'openai',
    COPILOT_PROVIDER_API_KEY: 'fixture-codex-saved', COPILOT_PROVIDER_BEARER_TOKEN: 'fixture-codex-saved', COPILOT_PROVIDER_TYPE: 'openai',
  } });
  const result = JSON.parse(cp.execFileSync(process.execPath, ['-e', observer], { env, encoding: 'utf8' }));
  expect(result.keys).toEqual([null, null, null, null, null, null]);
  expect(result.home).toBe(selected);
  expect(result.explicit).toBe(explicit ? selected : null);
  expect(result.auth.tokens.refresh_token).toBe('fixture-selected-account');
  expect(result.service).toBe('fixture-search');
  expect(readFileSync(join(selected, 'auth.json'), 'utf8')).toBe(raw);
  expect(existsSync(join(fixture.data, 'codex-policy-homes'))).toBe(false);
});
it('refuses Codex API mode through billing policy while ignoring a stale persisted opt-in', async () => {
  forceApi('codex');
  expect(() => billing.saveRuntimeBillingMode('codex', 'api')).toThrow();
  expect(billing.runtimeBillingMode('codex')).toBe('subscription');
});
it('still delivers saved API credentials to a non-Codex runtime opted in through saved billing policy', async () => {
  expect(() => billing.saveRuntimeBillingMode('opencode', 'api')).not.toThrow();
  const result = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY||"missing")'], {
    env: childEnvironment({ runtimeId: 'opencode' }), encoding: 'utf8',
  });
  expect(result).toBe('fixture-codex-saved');
});
