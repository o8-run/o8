import { resolveBackendTurnModel } from '@/lib/orchestrator/turn-model-selection';
import { getRuntimeCapability, isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { validateRuntimeModelSelection } from '@/lib/runtimes/shared/model-compatibility';
import { useCallback, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { formatModelLabel } from '@/lib/format';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { updateOperatorDefaultsValues } from '@/lib/operator/operator-defaults-values-client';
import { readStoredOrchestratorModel, writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import type { PendingBackendSwitch } from './chat-panel/BackendSwitchChoice';
import { fetchFreshThoughtsOperatorDefaults, type OrchestratorBackendSetting, type ThoughtsOperatorDefaults } from './operator-defaults';

export function resolveActiveComposerBackend(defaults: Pick<ThoughtsOperatorDefaults, 'orchestratorBackend' | 'inAppOrchestratorEnabled'>): OrchestratorBackendSetting {
  if (defaults.orchestratorBackend !== 'auto') return defaults.orchestratorBackend;
  return defaults.inAppOrchestratorEnabled ? 'claude' : 'codex';
}

export function formatComposerBackendLabel(backend: OrchestratorBackendSetting, model: string): string {
  const fixed: Partial<Record<OrchestratorBackendSetting, string>> = {
    codex: 'Codex GPT-5.6', fable: 'Fable 5', openclaw: 'OpenClaw', hermes: 'Hermes',
    collide: 'Collide', o8: 'o8', acp: 'Local ACP',
  };
  return fixed[backend] ?? formatModelLabel(model);
}

export function composerBackendTurnOverride(backend: OrchestratorBackendSetting): OrchestratorBackendId | undefined {
  return backend === 'auto' ? undefined : backend;
}

export async function resolveFreshComposerTurnOptions(input: {
  repoPath: string | null;
  backend: OrchestratorBackendSetting;
  localModel?: string;
  backendSourceRef: MutableRefObject<'default' | 'thread' | 'user'>;
  setBackend: Dispatch<SetStateAction<OrchestratorBackendSetting>>;
  setModel: Dispatch<SetStateAction<string>>;
  setOperatorDefaults: Dispatch<SetStateAction<ThoughtsOperatorDefaults>>;
}, signal?: AbortSignal, mode: { collide?: boolean; orchestrationMode?: string } = {}) {
  const effectiveBackend = (backend: OrchestratorBackendSetting) =>
    mode.collide === true && mode.orchestrationMode !== 'single' ? 'collide' : backend;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (input.localModel !== undefined) return { model: resolveBackendTurnModel(effectiveBackend(input.backend), input.localModel)!, backend: composerBackendTurnOverride(input.backend) };
  const defaults = await fetchFreshThoughtsOperatorDefaults(signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const backend = input.backendSourceRef.current === 'default'
    ? resolveActiveComposerBackend(defaults)
    : input.backend;
  const storedModel = readStoredOrchestratorModel(input.repoPath);
  const runtime = backend === 'claude' ? 'claude-code' : backend;
  const inheritedModel = storedModel === null && isOrchestratorRuntime(runtime)
    && validateRuntimeModelSelection(runtime, defaults.orchestratorModel, 'Default') !== null
    ? getRuntimeCapability(runtime).defaultModel ?? ''
    : storedModel ?? defaults.orchestratorModel;
  const model = resolveBackendTurnModel(effectiveBackend(backend), inheritedModel)!;
  input.setOperatorDefaults(defaults);
  input.setModel(model);
  if (input.backendSourceRef.current === 'default') input.setBackend(backend);
  return { model, backend: composerBackendTurnOverride(backend) };
}

export function useBackendSwitchChoice(input: {
  currentModel: string;
  backendSourceRef: MutableRefObject<'default' | 'thread' | 'user'>;
  latestAssistantBackendRef: MutableRefObject<OrchestratorBackendId | null>;
  operatorDefaults: ThoughtsOperatorDefaults;
  repoPath: string | null;
  setActiveThreadAgent: Dispatch<SetStateAction<string | null>>;
  setActiveThreadBackend: Dispatch<SetStateAction<OrchestratorBackendId | null>>;
  setBackend: Dispatch<SetStateAction<OrchestratorBackendSetting>>;
  setModel: (model: string) => void;
  setOperatorDefaults: Dispatch<SetStateAction<ThoughtsOperatorDefaults>>;
  onBeforeApply?: () => void;
  persistSelection?: boolean;
}) {
  const {
    backendSourceRef,
    currentModel,
    latestAssistantBackendRef,
    operatorDefaults,
    repoPath,
    setActiveThreadAgent,
    setActiveThreadBackend,
    setBackend,
    setModel,
    setOperatorDefaults,
    onBeforeApply,
    persistSelection = true,
  } = input;
  const [pending, setPending] = useState<PendingBackendSwitch | null>(null);
  const applyGenerationRef = useRef(0);
  const handoffModeRef = useRef<'handoff' | null>(null);
  const handoffTargetRef = useRef<OrchestratorBackendId | null>(null);
  const apply = useCallback((backend: OrchestratorBackendSetting, model?: string) => {
    const applyGeneration = ++applyGenerationRef.current;
    onBeforeApply?.();
    backendSourceRef.current = 'user';
    setBackend(backend);
    if (model !== undefined) {
      if (persistSelection) writeStoredOrchestratorModel(repoPath, model);
      setModel(model);
    }
    setActiveThreadBackend(composerBackendTurnOverride(backend) ?? null);
    setActiveThreadAgent(null);
    if (!persistSelection) return;
    void updateOperatorDefaultsValues({ orchestratorBackend: backend }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { values?: Partial<ThoughtsOperatorDefaults>; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || 'Failed to persist orchestrator backend.');
      return payload;
    }).then((payload) => {
      if (applyGeneration !== applyGenerationRef.current) return;
      if (!payload?.values) return;
      const defaults = { ...operatorDefaults, ...payload.values };
      setOperatorDefaults(defaults);
      setBackend(resolveActiveComposerBackend(defaults));
    }).catch((error) => {
      if (applyGeneration !== applyGenerationRef.current) return;
      console.log('[thoughts] failed to persist orchestrator backend', error);
      if (model !== undefined) {
        writeStoredOrchestratorModel(repoPath, currentModel);
        setModel(currentModel);
      }
      setBackend(resolveActiveComposerBackend(operatorDefaults));
    });
  }, [backendSourceRef, currentModel, onBeforeApply, operatorDefaults, persistSelection, repoPath, setActiveThreadAgent, setActiveThreadBackend, setBackend, setModel, setOperatorDefaults]);
  const reset = useCallback(() => {
    setPending(null);
    handoffModeRef.current = null;
    handoffTargetRef.current = null;
  }, []);
  const selectModel = useCallback((model: string) => {
    applyGenerationRef.current += 1;
    onBeforeApply?.();
    reset();
    if (persistSelection) writeStoredOrchestratorModel(repoPath, model);
    setModel(model);
  }, [onBeforeApply, persistSelection, repoPath, reset, setModel]);
  const request = useCallback((backend: OrchestratorBackendSetting, model?: string) => {
    reset();
    const destination = composerBackendTurnOverride(backend) ?? backend;
    if (latestAssistantBackendRef.current && latestAssistantBackendRef.current !== destination) {
      setPending({ backend, model, label: formatComposerBackendLabel(backend, model ?? currentModel) });
      return;
    }
    apply(backend, model);
  }, [apply, currentModel, latestAssistantBackendRef, reset]);
  const acceptHandoff = useCallback(() => {
    if (!pending) return;
    handoffModeRef.current = 'handoff';
    handoffTargetRef.current = composerBackendTurnOverride(pending.backend) ?? null;
    apply(pending.backend, pending.model);
    setPending(null);
  }, [apply, pending]);
  const observeLatestBackend = useCallback((backend: OrchestratorBackendId | null) => {
    if (!handoffTargetRef.current || handoffTargetRef.current !== backend) return;
    handoffModeRef.current = null;
    handoffTargetRef.current = null;
  }, []);
  const clearPending = useCallback(() => setPending(null), []);
  return useMemo(() => ({
    acceptHandoff,
    apply,
    clearPending,
    currentHandoffMode: () => handoffModeRef.current,
    observeLatestBackend,
    pending,
    request,
    reset,
    selectModel,
  }), [acceptHandoff, apply, clearPending, observeLatestBackend, pending, request, reset, selectModel]);
}
