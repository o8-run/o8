import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const cliFixture = vi.hoisted(() => ({ claudeBinary: '' }));

vi.mock('@/lib/runtimes/shared/cli-locate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/cli-locate')>(),
  scanAndLink: vi.fn((binaryName: string) => (
    binaryName === 'claude' ? cliFixture.claudeBinary : null
  )),
}));

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-auth-preflight-'));
const fixtureHome = path.join(fixtureRoot, 'home');
const fixtureBinDir = path.join(fixtureHome, '.local', 'bin');
const fixtureDataDir = path.join(fixtureRoot, 'data');
const fixtureClaudeConfigDir = path.join(fixtureRoot, 'claude-config');
const retryCountPath = path.join(fixtureRoot, 'retry-count');
const controlledEnvKeys = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CORTEX_IDE_DATA_DIR',
  'HOME',
  'O8_DATA_DIR',
  'O8_TEST_CLAUDE_MODE',
  'O8_TEST_CLAUDE_RETRY_COUNT',
  'O8_WORKER_ENV_ALLOW',
  'PATH',
] as const;
const priorEnv = Object.fromEntries(
  controlledEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof controlledEnvKeys)[number], string | undefined>;

let authDetect: typeof import('@/lib/runtimes/shared/auth-detect');

function writeAccountEvidence(emailAddress = 'operator@example.test') {
  writeFileSync(
    path.join(fixtureHome, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress } }),
  );
}

function clearStoredEvidence() {
  rmSync(path.join(fixtureHome, '.claude.json'), { force: true });
  rmSync(path.join(fixtureClaudeConfigDir, '.credentials.json'), { force: true });
}

beforeAll(async () => {
  mkdirSync(fixtureBinDir, { recursive: true });
  mkdirSync(fixtureDataDir, { recursive: true });
  mkdirSync(fixtureClaudeConfigDir, { recursive: true });
  cliFixture.claudeBinary = path.join(fixtureBinDir, 'claude');
  writeFileSync(cliFixture.claudeBinary, [
    '#!/bin/sh',
    'case "${O8_TEST_CLAUDE_MODE:-logged_out}" in',
    '  slow_logged_in) /bin/sleep 2; printf \'%s\\n\' \'{"loggedIn":true}\' ;;',
    '  logged_in) printf \'%s\\n\' \'{"loggedIn":true}\' ;;',
    '  logged_out) printf \'%s\\n\' \'{"loggedIn":false}\' ;;',
    '  malformed) printf \'%s\\n\' \'not-json\' ;;',
    '  timeout) exec /bin/sleep 20 ;;',
    '  timeout_once)',
    '    count=0',
    '    if [ -f "$O8_TEST_CLAUDE_RETRY_COUNT" ]; then IFS= read -r count < "$O8_TEST_CLAUDE_RETRY_COUNT"; fi',
    '    count=$((count + 1))',
    '    printf \'%s\\n\' "$count" > "$O8_TEST_CLAUDE_RETRY_COUNT"',
    '    if [ "$count" -eq 1 ]; then exec /bin/sleep 20; fi',
    '    printf \'%s\\n\' \'{"loggedIn":true}\'',
    '    ;;',
    'esac',
  ].join('\n'));
  chmodSync(cliFixture.claudeBinary, 0o755);

  process.env.HOME = fixtureHome;
  process.env.CLAUDE_CONFIG_DIR = fixtureClaudeConfigDir;
  process.env.CORTEX_IDE_DATA_DIR = fixtureDataDir;
  process.env.O8_DATA_DIR = fixtureDataDir;
  process.env.PATH = `${fixtureBinDir}${path.delimiter}${priorEnv.PATH ?? ''}`;
  process.env.ANTHROPIC_API_KEY = '';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
  process.env.O8_TEST_CLAUDE_RETRY_COUNT = retryCountPath;
  // Worker children inherit only allowlisted names; the stand-in CLI reads these test knobs.
  process.env.O8_WORKER_ENV_ALLOW = 'O8_TEST_CLAUDE_MODE,O8_TEST_CLAUDE_RETRY_COUNT';

  authDetect = await import('@/lib/runtimes/shared/auth-detect');
});

beforeEach(() => {
  clearStoredEvidence();
  rmSync(retryCountPath, { force: true });
  process.env.O8_TEST_CLAUDE_MODE = 'logged_out';
  authDetect.invalidateRuntimeAuthCache();
});

afterEach(() => {
  vi.useRealTimers();
  authDetect.invalidateRuntimeAuthCache();
});

afterAll(() => {
  for (const key of controlledEnvKeys) {
    const prior = priorEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Claude auth dispatch preflight real path', () => {
  it('allows a cold CLI probe that answers within five seconds', async () => {
    process.env.O8_TEST_CLAUDE_MODE = 'slow_logged_in';

    await expect(authDetect.assertRuntimeDispatchable('claude-code')).resolves.toBeUndefined();
  }, 15_000);

  it('allows file-based account evidence when both probe attempts time out', async () => {
    process.env.O8_TEST_CLAUDE_MODE = 'timeout';
    writeAccountEvidence();

    await expect(authDetect.assertRuntimeDispatchable('claude-code')).resolves.toBeUndefined();
  }, 20_000);

  it('fails closed when the probe times out without file-based evidence', async () => {
    process.env.O8_TEST_CLAUDE_MODE = 'timeout';

    const rejection = await authDetect.assertRuntimeDispatchable('claude-code').catch((error) => error);
    expect(rejection).toBeInstanceOf(authDetect.DispatchPreflightError);
    expect(rejection).toMatchObject({
      code: 'dispatch_cli_auth_unavailable',
      status: {
        authenticated: false,
        unavailableReason: 'needs_auth',
        detail: 'Claude Code CLI is installed but its sign-in state could not be verified.',
      },
    });
  }, 20_000);

  it('keeps explicit sign-out decisive when file-based account evidence exists', async () => {
    process.env.O8_TEST_CLAUDE_MODE = 'logged_out';
    writeAccountEvidence();

    await expect(authDetect.assertRuntimeDispatchable('claude-code')).rejects.toMatchObject({
      code: 'dispatch_cli_auth_unavailable',
      status: {
        authenticated: false,
        unavailableReason: 'needs_auth',
        detail: 'Claude Code CLI is installed but not signed in.',
      },
    });
  });

  it('refreshes an unknown verdict after its five-second cache lifetime', async () => {
    process.env.O8_TEST_CLAUDE_MODE = 'malformed';
    await expect(authDetect.assertRuntimeDispatchable('claude-code')).rejects.toMatchObject({
      status: { nativeLoginState: 'unknown', unavailableReason: 'needs_auth' },
    });

    const refreshedAt = Date.now() + 5_001;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(refreshedAt);
    process.env.O8_TEST_CLAUDE_MODE = 'logged_in';

    await expect(authDetect.assertRuntimeDispatchable('claude-code')).resolves.toBeUndefined();
  });

  it('retries once when the first probe attempt times out', async () => {
    process.env.O8_TEST_CLAUDE_MODE = 'timeout_once';

    await expect(authDetect.assertRuntimeDispatchable('claude-code')).resolves.toBeUndefined();
    expect(existsSync(retryCountPath)).toBe(true);
    expect(readFileSync(retryCountPath, 'utf-8').trim()).toBe('2');
  }, 15_000);
});
