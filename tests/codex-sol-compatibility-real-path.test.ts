import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

// Only the provider executable and unrelated readiness/prewarm notifications
// are stubbed. Launchers, argv, process exit, transcript and disk state are real.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, default: { ...os, homedir: () => process.env.O8_SOL_TEST_HOME! },
    homedir: () => process.env.O8_SOL_TEST_HOME! };
});
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: async () => ({ ready: true }),
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));

const root = mkdtempSync(join(getDataDir(), 'sol-compatibility-'));
const home = join(root, 'home');
const ownedRoot = join(root, 'owned');
const binary = join(root, 'codex');
mkdirSync(join(home, '.codex'), { recursive: true });
writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{
  slug: 'gpt-6.1-sol', supported_reasoning_levels: ['none', 'minimal'].map(effort => ({ effort })),
}] }));
vi.stubEnv('O8_SOL_TEST_HOME', home);
vi.stubEnv('CODEX_HOME', join(home, '.codex'));
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
vi.stubEnv('O8_WORKER_SANDBOX', 'off');
writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
const model = args.includes('--model') ? args[args.indexOf('--model') + 1]
  : args.find((arg) => arg.startsWith('model='))?.slice(6).replaceAll('"', '');
appendFileSync(join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args, model }) + '\\n');
if (existsSync(join(process.cwd(), 'reject-all')) || (existsSync(join(process.cwd(), 'reject')) && model === 'gpt-6.1-sol')) {
  if (existsSync(join(process.cwd(), 'partial'))) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Partial answer' } }));
  if (existsSync(join(process.cwd(), 'command-start'))) console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'command-1', command: 'echo started' } }));
  const message = existsSync(join(process.cwd(), 'unrelated')) ? 'Temporary provider failure'
    : "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  console.log(JSON.stringify({ type: 'turn.failed', error: { message } }));
  console.error(message); process.exit(1);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'sol-fixture-thread' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Completed on ' + model } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300000, cached_input_tokens: 20000, output_tokens: 10000 } }));
`);
chmodSync(binary, 0o700);

const { codexBackend } = await import('@/lib/lane/orchestrator-backends/codex');
const { launchOwnedCodexSession, getOwnedCodexRuntimeTail, getOwnedCodexReviewPacket, interruptOwnedCodexSession } = await import('@/lib/codex/owned');
const { POST } = await import('@/app/api/v2/proxy/cli/route');

function repo(name: string, reject: boolean) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q', cwd]);
  if (reject) writeFileSync(join(cwd, 'reject'), '1');
  return cwd;
}
function calls(cwd: string): Array<{ args: string[]; model: string }> {
  return readFileSync(join(cwd, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}
function saved(surfaceId: string): OwnedSessionRecord {
  return JSON.parse(readFileSync(join(ownedRoot, surfaceId.slice('codex-owned:'.length), 'session.json'), 'utf8'));
}

async function failedBridgeSession(name: string, diagnostic: string) {
  const cwd = repo(name, false);
  const launched = await launchOwnedCodexSession({ cwd, prompt: 'Reply once', model: 'gpt-6.1-sol' });
  await vi.waitFor(() => expect(saved(launched.surfaceId).activeRun).toBeUndefined(), { timeout: 10_000 });
  const session = saved(launched.surfaceId);
  const run = session.recentRuns[0];
  // Restore the persisted state a bridge leaves before lifecycle reconciliation.
  run.detachMode = 'bridge';
  run.outcome = 'failed';
  run.childExit = { code: 1, signal: null, classification: 'nonzero-exit' };
  writeFileSync(run.stdoutPath, JSON.stringify({ type: 'turn.failed', error: { message: diagnostic } }) + '\n');
  writeFileSync(run.stderrPath, diagnostic);
  writeFileSync(join(session.sessionDir, 'session.json'), JSON.stringify(session));
  return { cwd, surfaceId: launched.surfaceId };
}

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('GPT-6.1 Sol real CLI entry points', () => {
  it.each([true, false])('orchestrator rejects=%s, records one notice only on fallback', async (reject) => {
    const cwd = repo(`orchestrator-${reject}`, reject);
    const events: OrchestratorEvent[] = [];
    await codexBackend.sendTurn(cwd, 'Reply once', (event) => events.push(event), {
      model: 'gpt-6.1-sol', thinkingEffort: 'ultra',
    });
    expect(calls(cwd).map((call) => call.model)).toEqual(reject ? ['gpt-6.1-sol', 'gpt-5.6-sol'] : ['gpt-6.1-sol']);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_retry')).toHaveLength(reject ? 1 : 0);
    if (reject) expect(events.find((event) => event.type === 'turn_retry')).toMatchObject({
      notice: expect.stringContaining('Update the Codex CLI'),
    });
    expect(events.filter((event) => event.type === 'turn_receipt').at(-1)).toMatchObject({
      leadModel: reject ? 'gpt-5.6-sol' : 'gpt-6.1-sol', effort: 'ultra',
    });
    if (!reject) expect(events.find((event) => event.type === 'done')).toMatchObject({ cost: 1.274 });
  });

  it.each([true, false])('worker rejects=%s, persists the effective model and notice', async (reject) => {
    const cwd = repo(`worker-${reject}`, reject);
    const result = await launchOwnedCodexSession({ cwd, prompt: 'Reply once', model: 'gpt-6.1-sol', effort: 'ultra' });
    expect(result.ok).toBe(true);
    await vi.waitFor(async () => {
      const tail = await getOwnedCodexRuntimeTail(result.surfaceId);
      const session = saved(result.surfaceId);
      expect(session.activeRun).toBeUndefined();
      expect(session.recentRuns).toHaveLength(reject ? 2 : 1);
      expect(session.recentRuns[0].outcome).toBe('finished');
      expect(session.model).toBe(reject ? 'gpt-5.6-sol' : 'gpt-6.1-sol');
      expect(tail.entries.filter((entry) => entry.text.includes('Update the Codex CLI'))).toHaveLength(reject ? 1 : 0);
    }, { timeout: 12_000, interval: 100 });
    expect(calls(cwd).map((call) => call.model)).toEqual(reject ? ['gpt-6.1-sol', 'gpt-5.6-sol'] : ['gpt-6.1-sol']);
    expect(calls(cwd).every((call) => call.args.includes('model_reasoning_effort=ultra'))).toBe(true);
    const secondTail = await getOwnedCodexRuntimeTail(result.surfaceId);
    expect(secondTail.entries.filter((entry) => entry.text.includes('Update the Codex CLI'))).toHaveLength(reject ? 1 : 0);
    if (reject) expect(saved(result.surfaceId).recentRuns[1].modelFallback).toMatchObject({
      fromModel: 'gpt-6.1-sol', toModel: 'gpt-5.6-sol', notice: expect.stringContaining('Update the Codex CLI'),
    });
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none', 'minimal'])('launches both seats with valid effort for %s', async (effort) => {
    const cwd = repo(`effort-${effort}`, false);
    await codexBackend.sendTurn(cwd, 'Reply once', () => {}, { model: 'gpt-6.1-sol', thinkingEffort: effort as ThinkingEffort });
    const launched = await launchOwnedCodexSession({ cwd, prompt: 'Reply once', model: 'gpt-6.1-sol', effort: effort as ThinkingEffort });
    await vi.waitFor(() => expect(saved(launched.surfaceId).activeRun).toBeUndefined(), { timeout: 10_000 });
    expect(calls(cwd)).toHaveLength(2);
    for (const call of calls(cwd)) {
      expect(call.model).toBe('gpt-6.1-sol');
      expect(call.args).toContain(`model_reasoning_effort=${effort}`);
    }
  });

  it.each(['partial', 'command-start', 'unrelated', 'reject-all'])('bounds retries for %s failures through all entry points', async (mode) => {
    const cwd = repo(`failure-${mode}`, true);
    writeFileSync(join(cwd, mode), '1');
    const events: OrchestratorEvent[] = [];
    await codexBackend.sendTurn(cwd, 'Reply once', (event) => events.push(event), { model: 'gpt-6.1-sol' });
    expect(events.some((event) => event.type === 'error')).toBe(true);
    const attempts = mode === 'reject-all' ? 2 : 1;
    expect(calls(cwd)).toHaveLength(attempts);
    const launched = await launchOwnedCodexSession({ cwd, prompt: 'Reply once', model: 'gpt-6.1-sol' });
    await vi.waitFor(() => {
      expect(saved(launched.surfaceId).activeRun).toBeUndefined();
      expect(saved(launched.surfaceId).recentRuns).toHaveLength(attempts);
    }, { timeout: 10_000 });
    expect(calls(cwd)).toHaveLength(attempts * 2);
    writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify([{ id: 'fixture', name: 'fixture', localPath: cwd }]));
    const response = await POST(new Request('http://localhost/api/v2/proxy/cli', {
      method: 'POST', body: JSON.stringify({ runtime: 'codex', model: 'cli:codex:gpt-6.1-sol',
        repoPath: cwd, messages: [{ role: 'user', content: 'Reply once' }] }),
    }));
    expect(await response.text()).toContain('"type":"error"');
    expect(calls(cwd)).toHaveLength(attempts * 3);
  });

  it.each([true, false])('reconciles a failed bridge review without reacquiring its lock, unsupported=%s', async (unsupported) => {
    const diagnostic = unsupported
      ? "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
      : 'Temporary provider failure';
    const { cwd, surfaceId } = await failedBridgeSession(`bridge-review-${unsupported}`, diagnostic);
    await getOwnedCodexReviewPacket(surfaceId);
    await vi.waitFor(() => expect(saved(surfaceId).activeRun).toBeUndefined(), { timeout: 10_000 });
    expect(calls(cwd).map((call) => call.model)).toEqual(unsupported ? ['gpt-6.1-sol', 'gpt-5.6-sol'] : ['gpt-6.1-sol']);
    expect(saved(surfaceId).recentRuns).toHaveLength(unsupported ? 2 : 1);
  }, 15_000);

  it('stopping a failed bridge run suppresses recovery before and after review', async () => {
    const { cwd, surfaceId } = await failedBridgeSession('bridge-stop',
      "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.");
    await interruptOwnedCodexSession(surfaceId);
    expect(calls(cwd).map((call) => call.model)).toEqual(['gpt-6.1-sol']);
    expect(saved(surfaceId).recentRuns[0].interruptRequestedAt).toBeDefined();
    await getOwnedCodexReviewPacket(surfaceId);
    expect(calls(cwd)).toHaveLength(1);
    expect(saved(surfaceId).model).toBe('gpt-6.1-sol');
  }, 15_000);

  it.each([true, false])('CLI chat POST rejects=%s without hiding the selected model', async (reject) => {
    const cwd = repo(`proxy-${reject}`, reject);
    writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify([{ id: 'fixture', name: 'fixture', localPath: cwd }]));
    const response = await POST(new Request('http://localhost/api/v2/proxy/cli', {
      method: 'POST', body: JSON.stringify({ runtime: 'codex', model: 'cli:codex:gpt-6.1-sol',
        repoPath: cwd, messages: [{ role: 'user', content: 'Reply once' }] }),
    }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(calls(cwd).map((call) => call.model)).toEqual(reject ? ['gpt-6.1-sol', 'gpt-5.6-sol'] : ['gpt-6.1-sol']);
    expect(text).not.toContain('"type":"error"');
    expect(text.match(/Update the Codex CLI/g) ?? []).toHaveLength(reject ? 1 : 0);
    expect(text).toContain('Completed on ' + (reject ? 'gpt-5.6-sol' : 'gpt-6.1-sol'));
  });
});
