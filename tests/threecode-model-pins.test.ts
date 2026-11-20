import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(path.join(os.homedir(), '.o8-threecode-pins-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
const fixture = path.join(root, 'threecode-fixture.mjs');
const xdgConfig = path.join(root, 'xdg-config');
const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_3CODE_BIN: process.env.O8_3CODE_BIN,
  O8_OWNED_3CODE_ROOT: process.env.O8_OWNED_3CODE_ROOT,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_3CODE_BIN = fixture;
process.env.O8_OWNED_3CODE_ROOT = path.join(root, 'owned');
process.env.XDG_CONFIG_HOME = xdgConfig;

const readinessMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>()),
  ensureDispatchBackendReady: readinessMock,
}));

let defaultsRoute: typeof import('@/app/api/panel/operator-defaults/route');
let getOperatorDefaultsTomlState: typeof import('@/lib/operator/defaults').getOperatorDefaultsTomlState;
let runtime: import('@/lib/runtimes/types').AgentRuntime;
let assertRuntimeDispatchable: typeof import('@/lib/runtimes/shared/auth-detect').assertRuntimeDispatchable;
let parseThreecodeConfiguredProviders: typeof import('@/lib/runtimes/threecode-model-catalogue').parseThreecodeConfiguredProviders;

function post(body: unknown): Request {
  return new Request('http://localhost:3001/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForExit(sessionKey: string, mode: 'launch' | 'resume'): Promise<Record<string, unknown>> {
  const sessionFile = path.join(process.env.O8_OWNED_3CODE_ROOT!, sessionKey.slice('3code-owned:'.length), 'session.json');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as { recentRuns?: Array<{ mode: string; outcome: string }> };
      if (session.recentRuns?.[0]?.mode === mode && session.recentRuns[0].outcome === 'finished') return session as Record<string, unknown>;
    } catch {
      // The owned session is written before the fixture exits.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for 3code ${mode}.`);
}

beforeAll(async () => {
  mkdirSync(path.join(xdgConfig, '3code'), { recursive: true });
  writeFileSync(path.join(xdgConfig, '3code', 'config'), `[settings]
current = "deepseek"

[provider]
name = "openrouter"
url = "https://provider.invalid/v1"
key = "fixture-credential-never-exposed"
models = "deepseek/deepseek-v4-flash, thinkingmachines/inkling:free experimental-model"
`, 'utf8');
  writeFileSync(fixture, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('3code 0.7.0');
else if (args[0] === 'good') console.log(['known-good provider/variant combos:', '', '  deepseek.deepseek-v4-pro                  deepseek 4.pro', '  openrouter.deepseek/deepseek-v4-flash     deepseek 4.flash', '  openrouter.thinkingmachines/inkling:free     inkling 1.free'].join(String.fromCharCode(10)));
else console.log(JSON.stringify({ args }));
`, 'utf8');
  chmodSync(fixture, 0o755);
  writeFileSync(path.join(root, '.gitkeep'), '');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', repoPath]);
  ({ getOperatorDefaultsTomlState } = await import('@/lib/operator/defaults'));
  defaultsRoute = await import('@/app/api/panel/operator-defaults/route');
  ({ assertRuntimeDispatchable } = await import('@/lib/runtimes/shared/auth-detect'));
  ({ parseThreecodeConfiguredProviders } = await import('@/lib/runtimes/threecode-model-catalogue'));
  const { declarativeWorkerRuntimes } = await import('@/lib/runtimes/declarative-workers');
  runtime = declarativeWorkerRuntimes.find((candidate) => candidate.id === '3code')!;
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('3code configured worker pins', () => {
  it('persists only a configured 3code worker pin through the Settings route', async () => {
    const accepted = await defaultsRoute.POST(post({ threecodeWorkerModel: 'openrouter.deepseek/deepseek-v4-flash' }));
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ values: { threecodeWorkerModel: 'openrouter.deepseek/deepseek-v4-flash' } });

    const rejected = await defaultsRoute.POST(post({ threecodeWorkerModel: 'invented.provider-model' }));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: expect.stringContaining('unavailable') });
    await expect(assertRuntimeDispatchable('3code', 'invented.provider-model', repoPath))
      .rejects.toThrow('unavailable');
  });

  it('rejects an unavailable 3code pin from settings TOML before persistence', async () => {
    const before = await getOperatorDefaultsTomlState();
    const rejected = await defaultsRoute.POST(post({
      settingsToml: '[models]\nthreecode_worker_model = "invented.provider-model"\n',
      settingsTomlRevision: before.revision,
    }));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: expect.stringContaining('unavailable') });
    await expect(getOperatorDefaultsTomlState()).resolves.toMatchObject({
      revision: before.revision,
      text: before.text,
    });
  });

  it('passes a configured pin on launch and resume, but leaves an unset model to 3code defaults', async () => {
    const pinned = await runtime.launch({ cwd: repoPath, prompt: 'pinned launch', model: 'openrouter.deepseek/deepseek-v4-flash' });
    expect(pinned).toMatchObject({ ok: true });
    await waitForExit(pinned.sessionKey!, 'launch');
    await expect(runtime.resume(pinned.sessionKey!, 'pinned resume')).resolves.toMatchObject({ ok: true });
    await waitForExit(pinned.sessionKey!, 'resume');
    const pinnedTranscript = (await runtime.readTranscript(pinned.sessionKey!)).map((entry) => entry.text).join('\n');
    expect(pinnedTranscript).toContain('"--model","openrouter.deepseek/deepseek-v4-flash"');
    expect(pinnedTranscript).toContain('--resume=');

    const unpinned = await runtime.launch({ cwd: repoPath, prompt: 'default launch' });
    await waitForExit(unpinned.sessionKey!, 'launch');
    const defaultTranscript = (await runtime.readTranscript(unpinned.sessionKey!)).map((entry) => entry.text).join('\n');
    expect(defaultTranscript).not.toContain('--model');
  }, 20_000);

  it('never returns CLI stderr from defaults validation failures', async () => {
    const secretMarker = 'never-return-this-config-token';
    writeFileSync(fixture, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('3code 0.7.0');
else if (args[0] === 'good') { console.error('${secretMarker}'); process.exit(1); }
else console.log(JSON.stringify({ args }));
`, 'utf8');
    chmodSync(fixture, 0o755);

    const defaults = await defaultsRoute.POST(post({ threecodeWorkerModel: 'openrouter.deepseek/deepseek-v4-flash' }));
    expect(defaults.status).toBe(400);
    const body = JSON.stringify(await defaults.json());
    expect(body).toContain('The 3code model catalogue is unavailable.');
    expect(body).not.toContain(secretMarker);
  });

  it('projects only repeated provider sections, respecting section boundaries and configured model tokens', () => {
    expect(parseThreecodeConfiguredProviders(`[provider]
name = "first"
key = "do-not-project"
models = "alpha, beta:free openrouter/thinkingmachines/inkling:free"

[settings]
models = "must-not-leak"

[provider]
name = "second"
models = "gamma, delta"
`)).toEqual([
      { name: 'first', models: ['alpha', 'beta:free', 'openrouter/thinkingmachines/inkling:free'] },
      { name: 'second', models: ['gamma', 'delta'] },
    ]);
  });
});
