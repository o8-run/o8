import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
const sdkFixture = vi.hoisted(() => ({ worker: '' }));
vi.mock('@/lib/pi/sdk/scripts', async (original) => ({
  ...await original<typeof import('@/lib/pi/sdk/scripts')>(),
  piSdkScriptPath: (name: string) => {
    if (name !== 'worker.mjs') throw new Error('Unexpected SDK script');
    return sdkFixture.worker;
  },
}));

const root = mkdtempSync(path.join(tmpdir(), 'o8-worker-environment-'));
const repo = path.join(root, 'repo');
const home = path.join(root, 'fixture-home');
mkdirSync(home);
execFileSync('git', ['init', '-q', repo]);
const runtimes = listDispatchableRuntimes();
const prior = new Map<string, string | undefined>();
function set(name: string, value: string) {
  if (!prior.has(name)) prior.set(name, process.env[name]);
  process.env[name] = value;
}
set('O8_DATA_DIR', root);
set('CORTEX_IDE_DATA_DIR', root);
set('HOME', home);
set('USERPROFILE', home);
set('XDG_CONFIG_HOME', path.join(home, 'config'));
set('XDG_DATA_HOME', path.join(home, 'data'));
set('LANG', 'C.UTF-8');
set('LC_MESSAGES', 'C');
set('TERM', 'xterm-256color');
set('HTTPS_PROXY', 'http://proxy.invalid:8080');
set('https_proxy', 'http://proxy.invalid:8080');
set('NODE_EXTRA_CA_CERTS', path.join(root, 'fixture-ca.pem'));
writeFileSync(process.env.NODE_EXTRA_CA_CERTS!, '');
set('O8_UNRELATED_EXPORTED_SECRET', 'fake-secret-for-4513');
set('O8_OPERATOR_EXTRA', 'fixture-extra');
set('NODE_OPTIONS', '--no-warnings');
set('O8_WORKER_ENV_ALLOW', '');
set('O8_WORKER_ENV_INHERIT', '0');
set('O8_CRASH_SURVIVABLE_WORKERS', '0');
set('CLAUDE_CODE_OAUTH_TOKEN', 'fixture-worker-oauth');
set('COPILOT_GITHUB_TOKEN', 'fixture-native-auth');
set('CURSOR_API_KEY', 'fixture-native-auth');
for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENHANDS_API_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY',
  'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'HYPER_API_KEY']) set(name, 'fixture-native-auth');
set('GROK_CODE_XAI_API_KEY', 'fixture-native-auth');
set('LLM_PROVIDER', 'openai');
set('LLM_MODEL', 'fixture-model');
set('LLM_BASE_URL', 'https://provider.invalid');
set('LLM_API_KEY', 'fixture-provider-key');
set('COPILOT_PROVIDER_TYPE', 'openai');
set('COPILOT_PROVIDER_BASE_URL', 'https://provider.invalid');
set('COPILOT_PROVIDER_API_KEY', 'fixture-provider-key');
set('CODEX_HOME', path.join(home, 'codex'));
set('CLAUDE_CONFIG_DIR', path.join(home, 'claude'));
set('GEMINI_CLI_HOME', path.join(home, 'gemini'));
set('OPENCODE_CONFIG_DIR', path.join(home, 'opencode'));
set('PI_CODING_AGENT_DIR', path.join(home, 'pi'));
set('HERMES_HOME', path.join(home, 'hermes'));
mkdirSync(process.env.HERMES_HOME!, { recursive: true });
writeFileSync(path.join(process.env.HERMES_HOME!, 'config.yaml'), 'model: fixture\n');

const runtimeConfig: Record<string, string> = {
  codex: 'CODEX_HOME', 'claude-code': 'CLAUDE_CONFIG_DIR', gemini: 'GEMINI_CLI_HOME',
  opencode: 'OPENCODE_CONFIG_DIR', pi: 'PI_CODING_AGENT_DIR', hermes: 'HERMES_HOME',
};
const nativeAuth: Record<string, string[]> = {
  'copilot-cli': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  cursor: ['CURSOR_API_KEY'], grok: ['GROK_CODE_XAI_API_KEY'], openhands: ['OPENHANDS_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'], kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], crush: ['HYPER_API_KEY'],
};
const fixtureImports: Record<string, string> = {
  grok: 'grok-acp-runtime.mjs', hermes: 'hermes-acp-runtime.mjs',
  'deepseek-harness': 'deepseek-harness-jsonrpc-runtime.mjs',
};
for (const id of runtimes) {
  const token = id.replace(/[^a-z0-9]/g, '_').toUpperCase();
  set(`O8_OWNED_${token}_ROOT`, path.join(root, 'sessions', id));
  const binary = path.join(root, `${id}.mjs`);
  set(`O8_${token}_BIN`, binary);
  const capture = path.join(repo, `${id}.capture.jsonl`);
  const imported = fixtureImports[id];
  const protocol = imported
    ? `await import(${JSON.stringify(pathToFileURL(path.resolve('tests/fixtures', imported)).href)});`
    : `
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (${JSON.stringify(id)} === 'pi' || ${JSON.stringify(id)} === 'pi-builtin') {
  const { createInterface } = await import('node:readline');
  createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {
      sessionFile: frame.params.stateDir + '/fixture.jsonl', sessionId: 'fixture', tools: [], messageCount: 0 } });
    else if (frame.method === 'prompt') {
      send({ jsonrpc: '2.0', method: 'event', params: { event: { type: 'agent_settled' } } });
      send({ jsonrpc: '2.0', id: frame.id, result: { text: 'done', messageCount: 1 } });
    } else if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, result: {} });
    if (frame.type === 'prompt') { send({ type: 'agent_end', messages: [] }); process.exit(0); }
  });
} else {
  send({ type: 'init', session_id: 'fixture', sessionId: 'fixture' });
  send({ type: 'result', result: 'fixture done' });
  process.exit(0);
}`;
  writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  appendFileSync(${JSON.stringify(path.join(repo, `${id}.probe.jsonl`))},
    JSON.stringify({ secretPresent: 'O8_UNRELATED_EXPORTED_SECRET' in process.env }) + '\\n');
  console.log('fixture 1.0.0'); process.exit(0);
}
const keys = ['PATH', 'HOME', 'LANG', 'LC_MESSAGES', 'TERM', 'HTTPS_PROXY', 'https_proxy', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', ${JSON.stringify(runtimeConfig[id] ?? 'HOME')}];
const present = Object.fromEntries(keys.map(key => [key, Boolean(process.env[key])]));
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ present,
  secretPresent: 'O8_UNRELATED_EXPORTED_SECRET' in process.env,
  nodeOptionsPresent: process.env.NODE_OPTIONS === '--no-warnings',
  extraPresent: process.env.O8_OPERATOR_EXTRA === 'fixture-extra',
  nativeAuthPresent: ${JSON.stringify(nativeAuth[id] ?? [])}.every(name => process.env[name] === 'fixture-native-auth'),
  otherRuntimeAuthPresent: ${JSON.stringify(Object.values(nativeAuth).flat().filter(name => !nativeAuth[id]?.includes(name)))}.some(name => name in process.env),
  aliasPresent: process.env[${JSON.stringify(id === 'copilot-cli' ? 'COPILOT_PROVIDER_API_KEY' : 'LLM_API_KEY')}] === 'fixture-provider-key',
  routingPresent: ${JSON.stringify(id)} === 'copilot-cli'
    ? process.env.COPILOT_PROVIDER_TYPE === 'openai' && process.env.COPILOT_PROVIDER_BASE_URL === 'https://provider.invalid'
    : process.env.LLM_PROVIDER === 'openai' && process.env.LLM_MODEL === 'fixture-model' && process.env.LLM_BASE_URL === 'https://provider.invalid',
  oauthPresent: process.env.CLAUDE_CODE_OAUTH_TOKEN === 'fixture-worker-oauth',
  markerPresent: Boolean(process.env.O8_OWNED_RUN_MARKER),
  workerTokenPresent: Boolean(process.env.O8_WORKER_TOKEN) }) + '\\n');
${protocol}
`, { mode: 0o755 });
  if (id === 'pi-builtin') sdkFixture.worker = binary;
}
set('CORTEX_IDE_OWNED_CODEX_ROOT', process.env.O8_OWNED_CODEX_ROOT!);
set('CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT', process.env.O8_OWNED_CLAUDE_CODE_ROOT!);
const { getRuntime } = await import('@/lib/runtimes');

type Capture = { present: Record<string, boolean>; secretPresent: boolean; nodeOptionsPresent: boolean; extraPresent: boolean;
  nativeAuthPresent: boolean; otherRuntimeAuthPresent: boolean; aliasPresent: boolean; routingPresent: boolean;
  oauthPresent: boolean; markerPresent: boolean; workerTokenPresent: boolean };
async function launch(id: typeof runtimes[number]) {
  const runtime = getRuntime(id)!;
  const capturePath = path.join(repo, `${id}.capture.jsonl`);
  let before = 0;
  try { before = readFileSync(capturePath, 'utf8').trim().split('\n').length; } catch { /* First launch. */ }
  const result = await runtime.launch({ cwd: repo, prompt: 'fixture environment check',
    ...(id === 'claude-code' ? { claudeCodeCarrier: 'native' as const } : {}) });
  expect(result.ok, result.note).toBe(true);
  let capture: Capture | undefined;
  await vi.waitFor(() => {
    const lines = readFileSync(capturePath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(before);
    capture = JSON.parse(lines.at(-1)!) as Capture;
  });
  // Persisted session and successful dispatch precede inspection of the child report.
  expect(result.sessionKey).toBeTruthy();
  await runtime.interrupt(result.sessionKey!);
  const sessionPath = path.join(root, 'sessions', id, result.sessionKey!.split(':')[1], 'session.json');
  await vi.waitFor(() => {
    const record = JSON.parse(readFileSync(sessionPath, 'utf8'));
    expect(record.surfaceId).toBe(result.sessionKey);
    expect(record.activeRun).toBeFalsy();
  });
  return capture!;
}

afterAll(async () => {
  await import('@/lib/db').then(({ closeDb }) => closeDb());
  for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('worker environment through registered dispatch adapters', () => {
  it.each(runtimes)('%s excludes unrelated exports and preserves launch requirements', async (id) => {
    const capture = await launch(id);
    expect.soft(capture.secretPresent, 'unrelated parent export reached worker').toBe(false);
    expect.soft(capture.extraPresent).toBe(false);
    expect.soft(capture.otherRuntimeAuthPresent).toBe(false);
    expect.soft(capture.nodeOptionsPresent).toBe(false);
    if (id === 'pi-builtin') {
      // Bundled Pi already uses a private HOME and brokered model transport.
      expect(capture.present.HOME).toBe(true);
      expect(capture.oauthPresent).toBe(false);
    } else {
      for (const [name, present] of Object.entries(capture.present)) expect.soft(present, name).toBe(true);
      expect(capture.oauthPresent).toBe(id === 'claude-code');
      if (nativeAuth[id]) expect(capture.nativeAuthPresent).toBe(true);
      if (!['pi', 'grok', 'hermes', 'deepseek-harness'].includes(id)) {
        expect(capture.workerTokenPresent).toBe(true);
        expect(capture.markerPresent).toBe(true);
      }
    }
  }, 30_000);

  it('keeps the runtime version probe inside the same environment boundary', () => {
    const probe = JSON.parse(readFileSync(path.join(repo, 'codex.probe.jsonl'), 'utf8').trim().split('\n')[0]);
    expect(probe.secretPresent).toBe(false);
  });

  it.each(['openhands', 'copilot-cli'] as const)('%s retains billing-approved API aliases and routing', async (id) => {
    const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
    saveRuntimeBillingMode(id, 'api');
    try {
      const capture = await launch(id);
      expect(capture.secretPresent).toBe(false);
      expect(capture.aliasPresent).toBe(true);
      expect(capture.routingPresent).toBe(true);
    } finally { saveRuntimeBillingMode(id, 'subscription'); }
  });

  it('allows exact operator additions without wildcard inheritance', async () => {
    set('O8_WORKER_ENV_ALLOW', ' O8_OPERATOR_EXTRA, , NOT_DEFINED , O8_OPERATOR_EXTRA , O8_* ');
    try {
      const capture = await launch('codex');
      expect(capture.extraPresent).toBe(true);
      expect(capture.secretPresent).toBe(false);
    } finally { set('O8_WORKER_ENV_ALLOW', ''); }
  });

  it('restores ambient inheritance only for the explicit debug setting', async () => {
    set('O8_WORKER_ENV_INHERIT', '1');
    try { expect((await launch('codex')).secretPresent).toBe(true); }
    finally { set('O8_WORKER_ENV_INHERIT', '0'); }
  });
});
