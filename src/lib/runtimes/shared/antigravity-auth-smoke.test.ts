import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('./cli-locate', async (importOriginal) => ({
  ...await importOriginal<typeof import('./cli-locate')>(), scanAndLink: () => null,
}));
vi.mock('@/lib/deepseek-harness/runtime-resolution', () => ({
  resolveDeepSeekHarnessLaunch: async () => null,
  deepSeekHarnessInstallGuidance: () => 'Fixture absent',
}));

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-agy-auth-'));
const binary = path.join(root, 'agy');
writeFileSync(binary, `#!/usr/bin/env node
if (process.argv[2] !== 'models') process.exit(1);
if (process.env.O8_TEST_AGY_SIGNED_IN === '1') console.log('gemini-3.8-flash-low Gemini 3.8 Flash (Low)');
else { console.error('Sign in required: private-fixture-marker'); process.exit(1); }
`);
chmodSync(binary, 0o755);
vi.stubEnv('O8_ANTIGRAVITY_BIN', binary);
// Worker children inherit only allowlisted names; the stand-in CLI reads this test knob.
vi.stubEnv('O8_WORKER_ENV_ALLOW', 'O8_TEST_AGY_SIGNED_IN');
const { assertRuntimeDispatchable, detectRuntimeAuthStatus, invalidateRuntimeAuthCache } = await import('./auth-detect');
const { invalidateCliCache } = await import('./cli-resolver');
afterAll(() => {
  invalidateCliCache('antigravity');
  invalidateRuntimeAuthCache();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('worker authentication through the actual executable and dispatch gate', () => {
  it.each([false, true])('reports and enforces signed-in=%s without a paid model call', async (signedIn) => {
    vi.stubEnv('O8_TEST_AGY_SIGNED_IN', signedIn ? '1' : '0');
    invalidateCliCache('antigravity');
    invalidateRuntimeAuthCache();
    const status = await detectRuntimeAuthStatus('antigravity');
    expect(status).toMatchObject({ installed: true, authenticated: signedIn, ready: signedIn, binaryPath: binary });
    expect(JSON.stringify(status)).not.toContain('private-fixture-marker');
    if (signedIn) await expect(assertRuntimeDispatchable('antigravity')).resolves.toBeUndefined();
    else await expect(assertRuntimeDispatchable('antigravity')).rejects.toMatchObject({
      status: { runtime: 'antigravity', ready: false, unavailableReason: 'needs_auth' },
    });
  });
});
