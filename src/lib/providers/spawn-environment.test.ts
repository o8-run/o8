import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-spawn-authority-'));
const { providerSpawnEnvironment, refreshChildEnvironment } = await import('./spawn-environment');
const { saveRuntimeBillingMode } = await import('./runtime-billing');
const { mutateProviderKey } = await import('./key-store');
const { ownedSpawnEnvironment } = await import('@/lib/runtimes/shared/owned-session/restricted-spawn-env');
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 61).toString('base64url'));
  writeFileSync(join(state.dir, '.env.local'), '');
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });
it('injects saved canonical credentials and their aliases instead of inherited overrides', () => {
  mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-saved-gemini' });
  saveRuntimeBillingMode('opencode', 'api');
  const env = providerSpawnEnvironment({ GEMINI_API_KEY: 'fixture-stale', GOOGLE_API_KEY: 'fixture-stale-alias' }, { runtimeId: 'opencode' });
  expect(env.GEMINI_API_KEY).toBe('fixture-saved-gemini'); expect(env.GOOGLE_API_KEY).toBe('fixture-saved-gemini');
});
it('keeps restricted workers credential-free despite a saved provider key', () => {
  mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-saved-gemini' });
  const env = ownedSpawnEnvironment({ executionPolicy: { mode: 'single-attempt' } } as unknown as OwnedSessionRecord, {});
  expect(env.GEMINI_API_KEY).toBeUndefined(); expect(env.GOOGLE_API_KEY).toBeUndefined();
});
it('preserves an adapter native-auth suppression without re-injecting OpenRouter', () => {
  mutateProviderKey('OPENROUTER_API_KEY', { key: 'fixture-saved-router' });
  expect(ownedSpawnEnvironment({} as OwnedSessionRecord, { OPENROUTER_API_KEY: '' }).OPENROUTER_API_KEY).toBe('');
});
it.each(['openrouter', 'codex-subscription'])('preserves explicit %s gateway transport credentials', source => {
  if (source === 'openrouter') mutateProviderKey('OPENROUTER_API_KEY', { key: 'fixture-router' });
  saveRuntimeBillingMode('claude-code', source === 'openrouter' ? 'api' : 'subscription');
  mutateProviderKey('ANTHROPIC_API_KEY', { key: 'fixture-other-anthropic' });
  const env = ownedSpawnEnvironment({ surfaceId: 'claude-code-owned:fixture', runtimeConfig: { modelSource: source } } as unknown as OwnedSessionRecord, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1/fixture-gateway-token', ANTHROPIC_AUTH_TOKEN: 'fixture-gateway-token', ANTHROPIC_API_KEY: '',
  });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-gateway-token'); expect(env.ANTHROPIC_API_KEY).toBe('');
  expect(refreshChildEnvironment(env).ANTHROPIC_AUTH_TOKEN).toBe('fixture-gateway-token');
  expect(refreshChildEnvironment(env).ANTHROPIC_API_KEY).toBe('');
  expect(refreshChildEnvironment(env).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1/fixture-gateway-token');
});

it.each(['', 'fixture-ambient-xai'])('preserves an explicit unmanaged key through the resolver when ambient is %s', ambient => {
  vi.stubEnv('XAI_API_KEY', ambient);
  saveRuntimeBillingMode('opencode', 'api');
  expect(providerSpawnEnvironment({ XAI_API_KEY: 'fixture-explicit-xai' }, { runtimeId: 'opencode' }).XAI_API_KEY).toBe('fixture-explicit-xai');
});

it.each(['enabled', 'disabled', 'removed'])('preserves a freshly authorized OpenRouter carrier when Anthropic is %s', state => {
  mutateProviderKey('OPENROUTER_API_KEY', { key: 'fixture-router' });
  mutateProviderKey('ANTHROPIC_API_KEY', { key: 'fixture-anthropic' });
  if (state === 'disabled') mutateProviderKey('ANTHROPIC_API_KEY', { enabled: false });
  if (state === 'removed') mutateProviderKey('ANTHROPIC_API_KEY', { key: null });
  saveRuntimeBillingMode('claude-code', 'api');
  const env = ownedSpawnEnvironment({ surfaceId: 'claude-code-owned:fixture', runtimeConfig: { modelSource: 'openrouter' } } as unknown as OwnedSessionRecord, {
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'fixture-router', ANTHROPIC_API_KEY: '',
  });
  expect(refreshChildEnvironment(env).ANTHROPIC_AUTH_TOKEN).toBe('fixture-router');
  expect(refreshChildEnvironment(env).ANTHROPIC_API_KEY).toBe('');
});
