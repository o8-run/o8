import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { previewBuiltInAgent } from '@/app/preview/first-run/built-in-agent-fixture';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-onboarding-runtime-picker-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const fullInventory = [
  {
    id: 'codex',
    label: 'Codex',
    available: true,
    unavailableReason: null,
    detail: 'Codex is installed and signed in.',
    fix: '',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    available: true,
    unavailableReason: null,
    detail: 'Claude Code is installed and signed in.',
    fix: '',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    available: false,
    unavailableReason: 'needs_auth',
    detail: 'Gemini CLI is installed but not signed in.',
    fix: 'Run `gemini` once to sign in.',
  },
] satisfies SetupRuntime[];
let inventory: SetupRuntime[] = fullInventory.map((runtime) => ({ ...runtime }));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({
    statuses: {},
    suggestedSubscriptionProfile: { profile: null, detail: null },
  })),
  getDispatchableRuntimeAvailability: vi.fn(async () => inventory),
}));

vi.mock('@/lib/setup/runtime-activity', () => ({
  readRuntimeActivity: vi.fn(async () => ({ codex: 8, claude: 3, complete: true })),
  readLocalLeadModels: vi.fn(async () => ({})),
}));

const route = await import('@/app/api/panel/operator-defaults/route');
const {
  loadOnboardingRuntimeSelection,
  persistOnboardingRuntimeSelection,
  toggleOnboardingWorkerRuntime,
  onboardingSetupIsReady,
} = await import('@/components/desktop/onboarding/onboarding-runtime-selection');

async function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString();
  if (init?.method === 'POST') {
    return route.POST(new Request(`http://127.0.0.1${url}`, init));
  }
  return route.GET(new Request(`http://127.0.0.1${url}`, init));
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('onboarding runtime picker — real operator-defaults path', () => {
  it('selects a registered built-in agent when no CLI is ready, through the setup route', async () => {
    const builtIn = previewBuiltInAgent();
    inventory = [builtIn, ...fullInventory.map((item) => ({ ...item, available: false }))];
    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.orchestratorRuntime).toBe('o8');
    expect(loaded.workerRuntimes).toEqual([builtIn.id]);
    expect(loaded.recommendation.preserved).toBe(false);
    expect(loaded.recommendation.workerModel).toBe('');
    expect(onboardingSetupIsReady(loaded)).toBe(true);
  });

  it('keeps the detected CLI recommendation with a built-in choice available', async () => {
    const builtIn = previewBuiltInAgent('pro');
    inventory = [builtIn, ...fullInventory.map((item) => ({ ...item }))];
    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.orchestratorRuntime).toBe('codex');
    expect(loaded.workerRuntimes).toEqual(['codex']);
    expect(loaded.inventory.some((item) => item.id === builtIn.id)).toBe(true);
  });

  it('does not default to the unavailable built-in agent on Windows', async () => {
    inventory = [previewBuiltInAgent('free', 'win32')];
    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.recommendation.backend).toBeNull();
    expect(loaded.workerRuntimes).toEqual([]);
    expect(onboardingSetupIsReady(loaded)).toBe(false);
  });

  it('keeps production off without scanning a CLI for built-in readiness', async () => {
    const { getRuntimeAuthSnapshot } = await import('@/lib/runtimes/shared/auth-detect');
    const calls = vi.mocked(getRuntimeAuthSnapshot).mock.calls.length;
    const response = await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults?include=setup-built-in'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ builtInAgent: null });
    expect(vi.mocked(getRuntimeAuthSnapshot).mock.calls.length).toBe(calls);
  });

  it('reads discovery, blocks unavailable choices, and persists the orchestrator and worker pool', async () => {
    inventory = fullInventory.map((runtime) => runtime.id === 'codex'
      ? {
          ...runtime,
          available: false,
          unavailableReason: 'not_installed' as const,
          detail: 'Codex CLI is not installed.',
          fix: 'Install Codex, then run `codex login`.',
        }
      : { ...runtime });
    const singleRuntime = await loadOnboardingRuntimeSelection(routeFetch);
    expect(singleRuntime.orchestratorRuntime).toBe('claude-code');
    expect(singleRuntime.workerRuntimes).toEqual(['claude-code']);

    inventory = fullInventory.map((runtime) => ({ ...runtime }));
    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.inventory).toEqual(inventory);
    expect(loaded.orchestratorRuntime).toBe('codex');
    expect(loaded.workerRuntimes).toEqual(['codex']);

    const afterUnavailableToggle = toggleOnboardingWorkerRuntime(
      loaded.workerRuntimes,
      'gemini',
      loaded.inventory,
    );
    expect(afterUnavailableToggle).toEqual(['codex']);

    await persistOnboardingRuntimeSelection({
      orchestratorRuntime: 'claude-code',
      workerRuntimes: ['claude-code', 'codex'],
      leadModel: MODEL_IDS.orchestratorDefault,
      workerModel: MODEL_IDS.claudeWorkerDefault,
    }, routeFetch);

    const response = await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    const persisted = await response.json();
    expect(persisted.values.orchestratorBackend).toBe('claude');
    expect(persisted.values.defaultDispatchRuntime).toBe('claude-code');
    expect(persisted.values.workerRuntimes).toEqual(['claude-code', 'codex']);
    expect(persisted.sources.workerRuntimes).toBe('file');
    expect(persisted.values.orchestratorModel).toBe(MODEL_IDS.orchestratorDefault);
    expect(persisted.values.defaultDispatchModel).toBe(MODEL_IDS.claudeWorkerDefault);
    const { resolveOrchestratorBackendId, resolveReviewerBackendId } = await import('@/lib/lane/orchestrator-backends/active-backend');
    expect(resolveOrchestratorBackendId()).toBe('claude');
    expect(resolveReviewerBackendId()).toBe('claude');

    inventory = [
      {
        id: 'gemini',
        label: 'Gemini CLI',
        available: true,
        unavailableReason: null,
        detail: 'Gemini CLI is installed and signed in.',
        fix: '',
      },
      ...inventory.filter((runtime) => runtime.id !== 'gemini'),
    ];

    const afterLaterInstall = await loadOnboardingRuntimeSelection(routeFetch);
    expect(afterLaterInstall.orchestratorRuntime).toBe('claude-code');
    expect(afterLaterInstall.workerRuntimes).toEqual(['claude-code', 'codex']);

    const afterLaterInstallResponse = await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    await expect(afterLaterInstallResponse.json()).resolves.toMatchObject({
      values: {
        orchestratorBackend: 'claude',
        defaultDispatchRuntime: 'claude-code',
        workerRuntimes: ['claude-code', 'codex'],
      },
    });
  });

  it('retains saved choices as unavailable when tools disappear, without silently rerouting', async () => {
    inventory = [
      {
        id: 'codex',
        label: 'Codex',
        available: false,
        unavailableReason: 'not_installed',
        detail: 'Codex CLI is not installed.',
        fix: 'Install Codex, then run `codex login`.',
      },
      {
        id: 'claude-code',
        label: 'Claude Code',
        available: false,
        unavailableReason: 'not_installed',
        detail: 'Claude Code CLI is not installed.',
        fix: 'Install Claude Code, then run `claude` once to sign in.',
      },
    ];

    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.inventory.every((runtime) => !runtime.available)).toBe(true);
    expect(loaded.orchestratorRuntime).toBe('claude-code');
    expect(loaded.workerRuntimes).toEqual(['claude-code', 'codex']);
    expect(loaded.recommendation.preserved).toBe(true);
    expect(toggleOnboardingWorkerRuntime([], 'codex', loaded.inventory)).toEqual([]);
  });

  it('preserves the persisted CLI choice when the built-in agent becomes available later', async () => {
    inventory.unshift(previewBuiltInAgent());
    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.orchestratorRuntime).toBe('claude-code');
    expect(loaded.workerRuntimes).toEqual(['claude-code', 'codex']);
    expect(loaded.recommendation.preserved).toBe(true);
    expect(onboardingSetupIsReady(loaded)).toBe(false);
  });
});


it('keeps the Claude model setting when saving an Astra and Terra setup', async () => {
  const before = await (await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
  await persistOnboardingRuntimeSelection({ orchestratorRuntime: 'codex', workerRuntimes: ['codex'],
    leadModel: 'gpt-6-astra', workerModel: 'gpt-5.6-terra' }, routeFetch);
  const persisted = await (await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
  expect(persisted.values.orchestratorBackend).toBe('codex');
  expect(persisted.values.defaultDispatchModel).toBe('gpt-5.6-terra');
  expect(persisted.values.orchestratorModel).toBe(before.values.orchestratorModel);
  const { resolveOrchestratorBackendId, resolveReviewerBackendId } = await import('@/lib/lane/orchestrator-backends/active-backend');
  expect(resolveOrchestratorBackendId()).toBe('codex');
  expect(resolveReviewerBackendId()).toBe('codex');
});

it.each([
  { runtime: 'codex' as const, model: MODEL_IDS.codexCliDefault },
  { runtime: 'pi' as const, model: 'openrouter/fixture/api-saved-model' },
])('saves $runtime setup with its detected model without changing another runtime model default', async ({ runtime, model }) => {
  const before = await (await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
  await persistOnboardingRuntimeSelection({ orchestratorRuntime: runtime, workerRuntimes: ['codex'], leadModel: model }, routeFetch);
  const persisted = await (await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
  expect(persisted.values.orchestratorBackend).toBe(runtime);
  expect(persisted.values.orchestratorModel).toBe(before.values.orchestratorModel);
});
