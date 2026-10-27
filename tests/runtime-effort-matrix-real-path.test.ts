import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_MODEL_IDS, SUPPORTED_MODEL_IDS } from '@/lib/models';
import { ORCHESTRATOR_RUNTIME_IDS, getRuntimeCapability, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { codexLaunchArgs, codexResumeArgs } from '@/lib/codex/owned';
import { buildClaudeStreamJsonArgs } from '@/lib/claude-code/interactive-session';
import { museWorkerArgs } from '@/lib/muse/owned';
import { workerLaunchPayload } from '@/lib/cloud/worker-payload';
import type { RuntimeLaunchRequest, RuntimeLaunchResult } from '@/lib/runtime/actions';

const h = vi.hoisted(() => ({ launch: vi.fn<(request: RuntimeLaunchRequest) => Promise<RuntimeLaunchResult>>() }));
vi.mock('@/lib/runtime/actions', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(), launchRuntimeSurface: h.launch,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const configHome = join(getDataDir(), 'matrix-codex-home');
mkdirSync(configHome, { recursive: true });
// Isolate discovery from the host and keep the golden legacy contract explicit.
writeFileSync(join(configHome, 'models_cache.json'), JSON.stringify({ models: CODEX_MODEL_IDS.map(slug => ({
  slug, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
})) }));
vi.stubEnv('CODEX_HOME', configHome);
const { POST } = await import('@/app/api/runtime/launch/route');
const { closeDb } = await import('@/lib/db');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
await updateOperatorDefaults({ defaultDispatchModel: '' });

// Golden app-adapter contract. Dynamic model catalogs remain runtime-owned;
// representative unknown ids exercise that boundary, not provider entitlement.
const BASIC: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh'];
const ALL: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'max', 'xhigh', 'ultra'];
const HIGH_END = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']);
const DEFAULT_ONLY: OrchestratorRuntime[] = [
  'gemini', 'antigravity', 'magnitude', 'opencode', 'copilot-cli', 'crush', 'openhands',
  'goose', 'qwen', 'qoder', 'kimi', 'aider', '3code', 'pi', 'pi-builtin', 'cursor',
  'grok', 'prime-agent', 'hermes', 'deepseek-harness',
];
type Row = { runtime: OrchestratorRuntime; model?: string; supported: readonly ThinkingEffort[] };
const rows: Row[] = [
  ...(['codex', 'cloud'] as const).flatMap(runtime => [
    ...CODEX_MODEL_IDS, 'ollama:fixture', 'lmstudio:fixture', 'gpt-future-fixture', undefined,
  ].map(model => ({ runtime, model, supported: model === 'gpt-4o' || model?.includes(':') ? []
    : model && HIGH_END.has(model) ? ALL : model === 'gpt-6-luna' ? [...BASIC, 'max' as const] : BASIC }))),
  ...[undefined, ...SUPPORTED_MODEL_IDS.filter(model => model.startsWith('claude-'))].map(model => ({
    runtime: 'claude-code' as const, model, supported: [...BASIC, 'max' as const],
  })),
  ...DEFAULT_ONLY.flatMap(runtime => [...new Set([
    undefined, getRuntimeCapability(runtime).defaultModel, `${runtime}-configured-fixture`,
    ...SUPPORTED_MODEL_IDS.filter(model => runtime === 'gemini' && model.startsWith('gemini-')),
    ...(runtime === 'opencode' ? ['provider/model', 'provider/model/high'] : []),
  ])].map(model => ({ runtime, model, supported: [] }))),
  ...[undefined, 'muse-catalog-fixture'].map(model => ({ runtime: 'muse' as const, model, supported: ALL })),
];
const vectors = rows.flatMap(row => [undefined, 'adaptive', ...ALL, 'disabled'].map(effort => ({ ...row, effort })));

beforeEach(() => {
  h.launch.mockReset().mockImplementation(async request => ({
    ok: true, runtime: request.runtime, surfaceId: `fixture:${request.clientMutationId}`,
    clientMutationId: request.clientMutationId, note: 'Captured launch boundary.',
    cwd: '', repoPath: '', worktree: null, laneId: null,
  }));
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(configHome, { recursive: true, force: true }); });

describe('runtime and selectable-model effort matrix through the actual launch POST', () => {
  it('requires an explicit audit row for every canonical runtime', () => {
    expect([...new Set(rows.map(row => row.runtime))].sort()).toEqual([...ORCHESTRATOR_RUNTIME_IDS].sort());
  });
  it.each(vectors)('$runtime / $model / $effort', async ({ runtime, model, effort, supported }) => {
    const accepted = effort === undefined || effort === 'adaptive' || supported.includes(effort as ThinkingEffort);
    const id = `matrix-${runtime}-${model ?? 'default'}-${effort ?? 'omitted'}`;
    const request = { runtime, model, effort, prompt: 'fixture', cwd: '/fixture', clientMutationId: id };
    const invoke = () => POST(new NextRequest('http://localhost/api/runtime/launch', { method: 'POST', body: JSON.stringify(request) }));
    const response = await invoke();
    expect(response.status).toBe(accepted ? 200 : 400);
    if (!accepted) {
      expect(h.launch).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ code: expect.stringMatching(/^invalid_effort$|^effort_/) });
      return;
    }
    expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runtime, model, effort }));
    closeDb();
    expect((await invoke()).headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(h.launch).toHaveBeenCalledTimes(1);
    const concrete = effort && effort !== 'adaptive' ? effort : undefined;
    if (runtime === 'codex' || runtime === 'cloud') {
      const args = { cwd: '/fixture', sessionDir: '/fixture/session', prompt: 'fixture', model, effort: effort as ThinkingEffort | undefined };
      const launch = runtime === 'cloud' ? workerLaunchPayload({ ...args }) : args;
      expect(launch.effort).toBe(effort);
      for (const argv of [codexLaunchArgs(args), codexResumeArgs({ ...args, threadId: 'fixture-thread' })]) {
        expect(argv.filter(arg => arg.startsWith('model_reasoning_effort='))).toEqual(concrete ? [`model_reasoning_effort=${concrete}`] : []);
      }
    } else if (runtime === 'claude-code') {
      for (const thread of [null, '12345678-1234-1234-1234-123456789abc']) {
        const argv = buildClaudeStreamJsonArgs(model ?? null, 'bypassPermissions', thread, effort as ThinkingEffort | undefined);
        expect(argv.includes('--effort')).toBe(Boolean(concrete));
        if (concrete) expect(argv[argv.indexOf('--effort') + 1]).toBe(concrete);
      }
    } else if (runtime === 'muse') {
      const argv = museWorkerArgs({ prompt: 'fixture', model, effort });
      expect(argv.includes('--reasoning-effort')).toBe(Boolean(concrete));
      if (concrete) expect(argv[argv.indexOf('--reasoning-effort') + 1]).toBe(concrete);
    }
  });
});
