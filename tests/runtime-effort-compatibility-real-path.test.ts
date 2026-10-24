import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const root = join(getDataDir(), 'effort-contract');
const repo = join(root, 'repo');
const sessions = join(root, 'sessions');
const binary = join(root, 'codex-fixture.cjs');
const capture = join(root, 'transport.jsonl');
mkdirSync(repo, { recursive: true });
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', sessions);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_WORKER_SANDBOX', '0');
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true, reason: 'http_200', waitedMs: 0, attempts: 1, lastCheck: {} })),
}));
vi.mock('@/lib/workspace/materialization-guard', () => ({
  inspectOwnedWorkspaceMaterialization: vi.fn(async () => ({ status: 'available', source: 'no-snapshot' })),
}));

const { codexOwnedAdapter } = await import('@/lib/codex/owned');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const store = () => createOwnedSessionStore(codexOwnedAdapter);
function calls(): string[][] {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function records() {
  return existsSync(sessions) ? readdirSync(sessions).map(dir => join(sessions, dir, 'session.json')).filter(existsSync) : [];
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
// Keep the finite transport alive long enough for process-identity admission.
setTimeout(() => {}, 100);
`);
  chmodSync(binary, 0o700);
  writeFileSync(join(root, 'codex'), readFileSync(binary));
  chmodSync(join(root, 'codex'), 0o700);
  vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH}`);
});
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('owned launch and cold resume effort admission with an executable transport', () => {
  it('normalizes an inherited saved default for a new model and records the effective transport effort', async () => {
    const { getOperatorDefaultsSync, updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const original = getOperatorDefaultsSync().values.codexWorkerEffort;
    try {
      await updateOperatorDefaults({ codexWorkerEffort: 'ultra' });
      const { codexRuntime } = await import('@/lib/runtimes/codex');
      const result = await codexRuntime.launch({ cwd: repo, prompt: 'saved default', model: 'gpt-6-luna' });
      expect(result.ok, result.note).toBe(true);
      await vi.waitFor(async () => expect((await store().getRuntimeTail(result.sessionKey!)).surface.lifecycle?.lastOutcome).toBe('finished'));
      const saved = records().map(file => JSON.parse(readFileSync(file, 'utf8'))).find(record => record.surfaceId === result.sessionKey);
      expect(saved).toMatchObject({ model: 'gpt-6-luna', effort: 'xhigh' });
      expect(calls().at(-1)).toContain('model_reasoning_effort=xhigh');
    } finally { await updateOperatorDefaults({ codexWorkerEffort: original }); }
  });
  it.each([
    ['gpt-6-luna', 'ultra'], ['gpt-5.5', 'max'], ['gpt-4o', 'high'],
    ['ollama:fixture', 'high'], ['gpt-6.1-sol', 'disabled'],
  ])('refuses %s/%s before persisting or starting a process', async (model, effort) => {
    const before = calls();
    const saved = records();
    await expect(store().launch({ cwd: repo, prompt: 'inspect', model, effort: effort as ThinkingEffort }))
      .rejects.toMatchObject({ name: 'EffortPinRejectionError' });
    expect(calls()).toEqual(before);
    expect(records()).toEqual(saved);
  });

  it.each([undefined, 'adaptive', 'high', 'max', 'ultra'] as const)(
    'persists %s unchanged and repeats it at the cold resume transport', async effort => {
      const active = store();
      const result = await active.launch({ cwd: repo, prompt: 'inspect', model: 'gpt-6.1-sol', effort });
      expect(result.ok, result.note).toBe(true);
      await vi.waitFor(async () => {
        const tail = await active.getRuntimeTail(result.surfaceId);
        expect(tail.surface.lifecycle?.lastOutcome).toBe('finished');
      });
      const metadata = records().find(file => JSON.parse(readFileSync(file, 'utf8')).surfaceId === result.surfaceId)!;
      await vi.waitFor(() => {
        const saved = JSON.parse(readFileSync(metadata, 'utf8'));
        expect(saved.activeRun).toBeUndefined();
        expect(saved.recentRuns[0].childExit?.code).toBe(0);
      }, { timeout: 5000 });
      expect(JSON.parse(readFileSync(metadata, 'utf8')).effort).toBe(effort);
      const before = calls().length;
      const cold = store();
      expect((await cold.resume(result.surfaceId, 'continue')).ok).toBe(true);
      await vi.waitFor(() => expect(calls()).toHaveLength(before + 1));
      const flags = calls().at(-1)!.filter(arg => arg.startsWith('model_reasoning_effort='));
      expect(flags).toEqual(effort && effort !== 'adaptive' ? [`model_reasoning_effort=${effort}`] : []);
      await vi.waitFor(async () => expect((await cold.getRuntimeTail(result.surfaceId)).surface.lifecycle?.lastOutcome).toBe('finished'));
      await vi.waitFor(() => {
        const saved = JSON.parse(readFileSync(metadata, 'utf8'));
        expect(saved.activeRun).toBeUndefined();
        expect(saved.recentRuns[0].childExit?.code).toBe(0);
      }, { timeout: 5000 });

      // Simulate a saved model switch. The explicit pin cannot silently become xhigh.
      if (effort === 'ultra') {
        const saved = JSON.parse(readFileSync(metadata, 'utf8'));
        writeFileSync(metadata, JSON.stringify({ ...saved, model: 'gpt-6-luna' }));
        const snapshot = readFileSync(metadata, 'utf8');
        await expect(store().resume(result.surfaceId, 'incompatible resume')).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
        expect(readFileSync(metadata, 'utf8')).toBe(snapshot);
        expect(calls()).toHaveLength(before + 1);
      }
    },
  );
});

describe('external worker effort admission at its actual executable entry point', () => {
  it.each(['ollama', 'lmstudio'])('translates the %s model selection without inventing a reasoning pin', async provider => {
    const { startCodex } = await import('../scripts/worker/run-codex');
    const running = await startCodex({ cwd: repo, prompt: 'fixture', model: `${provider}:fixture`, onChunk: async () => {} });
    expect((await running.result).exitCode).toBe(0);
    const args = calls().at(-1)!;
    expect(args).toEqual(expect.arrayContaining(['--oss', '--local-provider', provider, '--model', 'fixture']));
    expect(args).not.toContain(`${provider}:fixture`);
    expect(args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
  });
  it.each([['gpt-6-luna', 'ultra'], ['gpt-5.5', 'max'], ['gpt-4o', 'high']])(
    'refuses delivered %s/%s without starting a process', async (model, effort) => {
      const { startCodex } = await import('../scripts/worker/run-codex');
      const before = calls();
      const result = startCodex({ cwd: repo, prompt: 'fixture', model, effort: effort as ThinkingEffort, onChunk: async () => {} });
      // Drain an unexpected launch too, so the red run cannot leave a process behind.
      await result.then(running => running.result).catch(() => {});
      await expect(result).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
      expect(calls()).toEqual(before);
    },
  );
  it.each([undefined, 'adaptive', 'high', 'max', 'ultra'] as const)('preserves delivered %s at the external worker transport', async effort => {
    const { startCodex } = await import('../scripts/worker/run-codex');
    const running = await startCodex({ cwd: repo, prompt: 'fixture', model: 'gpt-6.1-sol', effort, onChunk: async () => {} });
    expect((await running.result).exitCode).toBe(0);
    expect(calls().at(-1)!.filter(arg => arg.startsWith('model_reasoning_effort=')))
      .toEqual(effort && effort !== 'adaptive' ? [`model_reasoning_effort=${effort}`] : []);
  });
});
