// @vitest-environment jsdom

import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { readStoredOrchestratorModel, writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { ComposerArea } from '../chat-panel/ComposerArea';
import { composerModeStorageKey, writeStoredComposerMode } from '../composer-mode-storage';
import { readComposerEffortMaps, writeComposerModelEffort, type ComposerSelectorMode } from './state';
import { useComposerSelectorState } from './useComposerSelectorState';
import { useOrchestratorModelState } from './useOrchestratorModelState';
import type { OrchestratorBackendSetting } from '../operator-defaults';

vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: vi.fn() }));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const STORED_MODEL_TAB_ID = 'stored-model-tab';

function StoredModelRestoreHarness({ repoPath, isolated = false, threadId = 'stored-model-thread' }: { repoPath: string; isolated?: boolean; threadId?: string }) {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState<ComposerSelectorMode>('fusion');
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const [model, setModel] = useState('gpt-5.6-sol');
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'stored-model-mode' }, mode),
    createElement('span', { 'data-testid': 'stored-model-value' }, model),
    createElement(ComposerArea, {
      activeComposer: true,
      input,
      onInputChange: setInput,
      isOrchestratorMode: true,
      displayWaiting: false,
      chatMessages: [],
      activeTargetLabel: 'Orchestrator',
      targetAgentExists: true,
      thoughtsBodyBackground: 'var(--t-chat-surface-bg)',
      enhancing: false,
      preEnhanceInput: null,
      onEnhance: () => {},
      onUndoEnhance: () => {},
      onSubmit: () => {},
      onSlashCommand: () => {},
      modelLabel: model,
      modelId: model,
      isolatedModelSelection: isolated,
      onModelRestore: setModel,
      onModelChange: (nextModel) => {
        setMode('solo');
        setModel(nextModel);
      },
      activeBackend: 'codex',
      effort,
      operatorDefaultEffort: 'high',
      onEffortChange: setEffort,
      adaptiveEnabled: true,
      displayMessagesCount: 0,
      hasAssistantActivity: false,
      composerMode: mode,
      onComposerModeChange: setMode,
      composerModeStorageId: STORED_MODEL_TAB_ID,
      sessionRulesThreadId: threadId,
      repoPath,
    }),
  );
}

let isolatedControls: ReturnType<typeof useComposerSelectorState>;
function LeadModelHarness({ operatorDefaultModel }: { operatorDefaultModel: string }) {
  const { model } = useOrchestratorModelState({ repoPath: '/repo/alpha', operatorDefaultModel });
  return createElement('output', null, model);
}
function IsolatedSelector({ threadId = null }: { threadId?: string | null }) {
  const [model, setModel] = useState('gpt-6-luna');
  const [effort, setEffort] = useState<ThinkingEffort>('low');
  const controls = useComposerSelectorState({ enabled: true, isolated: true, mode: 'solo', modelId: model, modelLabel: model,
    backend: 'codex', effort, operatorDefaultEffort: 'low', adaptiveEnabled: false, threadId, repoPath: '/repo/alpha',
    onModelRestore: setModel, onModelChange: setModel, onEffortChange: setEffort });
  useEffect(() => { isolatedControls = controls; }, [controls]);
  return createElement('output', null, `${model}:${effort}`);
}

function EffortRestoreHarness({ backend, model }: { backend: OrchestratorBackendSetting; model: string }) {
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const controls = useComposerSelectorState({ enabled: true, mode: 'solo', modelId: model, modelLabel: model,
    backend, effort, operatorDefaultEffort: 'high', adaptiveEnabled: true, threadId: 'effort-restore', repoPath: '/repo/fixture',
    onEffortChange: setEffort });
  return createElement('output', null, controls.state.effort);
}

describe('composer selector model restore', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    invalidateOperatorDefaultsValuesSnapshot();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      values: {
        defaultDispatchRuntime: 'codex',
        defaultDispatchModel: '',
        opencodeWorkerModel: null,
        workerStartMode: 'autonomous',
      },
      sources: {},
    }), { status: 200 })));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    invalidateOperatorDefaultsValuesSnapshot();
    vi.unstubAllGlobals();
  });

  it('restores a per-repo model without treating the restore as a user lead pick', async () => {
    writeStoredComposerMode(STORED_MODEL_TAB_ID, 'fusion');
    writeStoredOrchestratorModel('/repo/alpha', 'gpt-5.6-terra');
    writeStoredOrchestratorModel('/repo/beta', 'gpt-5.6-luna');

    await act(async () => {
      root.render(createElement(StoredModelRestoreHarness, { repoPath: '/repo/alpha' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[data-testid="stored-model-value"]')?.textContent).toBe('gpt-5.6-terra');
    expect(container.querySelector('[data-testid="stored-model-mode"]')?.textContent).toBe('fusion');
    expect(localStorage.getItem(composerModeStorageKey(STORED_MODEL_TAB_ID))).toBe('fusion');

    await act(async () => {
      root.render(createElement(StoredModelRestoreHarness, { repoPath: '/repo/beta' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[data-testid="stored-model-value"]')?.textContent).toBe('gpt-5.6-luna');
    expect(container.querySelector('[data-testid="stored-model-mode"]')?.textContent).toBe('fusion');
    expect(localStorage.getItem(composerModeStorageKey(STORED_MODEL_TAB_ID))).toBe('fusion');
  });
  it('keeps a stored agent-default choice when operator defaults refresh', async () => {
    writeStoredOrchestratorModel('/repo/alpha', '');
    await act(async () => root.render(createElement(LeadModelHarness, { operatorDefaultModel: 'model-a' })));
    expect(container.querySelector('output')?.textContent).toBe('');
    await act(async () => root.render(createElement(LeadModelHarness, { operatorDefaultModel: 'model-b' })));
    expect(container.querySelector('output')?.textContent).toBe('');
  });

  it('restores an empty agent-default choice without resetting the composer mode', async () => {
    writeStoredComposerMode(STORED_MODEL_TAB_ID, 'fusion');
    writeStoredOrchestratorModel('/repo/alpha', '');
    await act(async () => root.render(createElement(StoredModelRestoreHarness, { repoPath: '/repo/alpha' })));
    expect(container.querySelector('[data-testid="stored-model-value"]')?.textContent).toBe('');
    expect(container.querySelector('[data-testid="stored-model-mode"]')?.textContent).toBe('fusion');
  });
  it('keeps a reply model isolated when its conversation acquires a thread id', async () => {
    writeStoredOrchestratorModel('/repo/alpha', 'gpt-6-astra');
    await act(async () => root.render(createElement(StoredModelRestoreHarness, { repoPath: '/repo/alpha', isolated: true, threadId: '' })));
    expect(container.querySelector('[data-testid="stored-model-value"]')?.textContent).toBe('gpt-5.6-sol');
    await act(async () => root.render(createElement(StoredModelRestoreHarness, { repoPath: '/repo/alpha', isolated: true, threadId: 'new-reply-thread' })));
    expect(container.querySelector('[data-testid="stored-model-value"]')?.textContent).toBe('gpt-5.6-sol');
  });

  it('does not read or write global lead preferences from the reply selector', async () => {
    writeStoredOrchestratorModel('/repo/alpha', 'gpt-6-astra');
    writeComposerModelEffort('gpt-6-luna', 'high', null);
    const before = readComposerEffortMaps(null, 'gpt-6-luna');
    await act(async () => root.render(createElement(IsolatedSelector, {})));
    expect(container.querySelector('output')?.textContent).toBe('gpt-6-luna:low');
    await act(async () => isolatedControls.onEffortChange('medium'));
    await act(async () => root.render(createElement(IsolatedSelector, { threadId: 'new-reply-thread' })));
    expect(container.querySelector('output')?.textContent).toBe('gpt-6-luna:medium');
    await act(async () => isolatedControls.onModelChange('gpt-6-sol'));
    expect(readStoredOrchestratorModel('/repo/alpha')).toBe('gpt-6-astra');
    expect(readComposerEffortMaps(null, 'gpt-6-luna')).toEqual(before);
  });

  it.each([
    ['codex', 'gpt-4o'], ['codex', 'ollama:fixture'], ['opencode', 'provider/model/high'], ['pi', 'openai/gpt-6-luna'],
  ] as const)('normalizes a stale saved effort on %s/%s and preserves valid choices on return', async (backend, model) => {
    writeComposerModelEffort('gpt-6.1-sol', 'high', 'effort-restore');
    writeComposerModelEffort(model, 'max', 'effort-restore');
    await act(async () => root.render(createElement(EffortRestoreHarness, { backend, model })));
    expect(container.querySelector('output')?.textContent).toBe('adaptive');
    expect(readComposerEffortMaps('effort-restore', model).thread[model]).toBe('adaptive');
    await act(async () => root.render(createElement(EffortRestoreHarness, { backend: 'codex', model: 'gpt-6.1-sol' })));
    expect(container.querySelector('output')?.textContent).toBe('high');
  });

});
