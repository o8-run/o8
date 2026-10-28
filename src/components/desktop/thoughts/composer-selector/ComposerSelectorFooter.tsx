'use client';

import type { ReactNode, Ref } from 'react';
import type { WorkerStartMode } from '@/lib/operator/worker-start-mode';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ComposerModelGroup } from '../ModelThinkingChip';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { ComposerPicker } from './ComposerPicker';
import { ModeChip } from './ModeChip';
import { useComposerChipCompact } from '../composer-compact-context';
import type { ResolvedComposerSelectorState } from './state';
import type { ComposerWorkerDefaults, WorkerModelChange } from './worker-settings';

export function ComposerSelectorFooterView({
  state,
  composerModelGroups,
  onModeChange,
  onModelChange,
  onBackendChange,
  onEffortChange,
  saving = false,
  leadingControls,
  permissionControl,
  attachControl,
  meterControl,
  micControl,
  voiceControl,
  sendControl,
  containerRef,
  onRequestTextareaFocus,
}: {
  input: string;
  state: ResolvedComposerSelectorState;
  defaults: ComposerWorkerDefaults;
  composerModelGroups: ComposerModelGroup[];
  onModeChange: (mode: ResolvedComposerSelectorState['mode']) => void;
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
  onRuntimeChange: (runtime: OrchestratorRuntime) => void;
  onWorkerModelChange: WorkerModelChange;
  onWorkerEffortChange?: (effort: ThinkingEffort, runtime: OrchestratorRuntime) => void;
  workerLocks?: { runtime?: boolean; defaultModel: boolean; opencode: boolean; threecode: boolean; codexEffort: boolean; claudeEffort: boolean };
  onWorkerStartModeChange: (mode: WorkerStartMode) => void;
  saving?: boolean;
  leadingControls?: ReactNode;
  permissionControl?: ReactNode;
  attachControl?: ReactNode;
  meterControl?: ReactNode;
  micControl?: ReactNode;
  voiceControl?: ReactNode;
  sendControl?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  onRequestTextareaFocus?: () => void;
}) {
  const compact = useComposerChipCompact();
  return (
    <div
      ref={containerRef}
      data-testid="composer-selector-footer"
      data-composer-footer
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 0 : 6,
        minHeight: 36,
        paddingTop: 4,
        paddingRight: compact ? 0 : 8,
        paddingBottom: 8,
        paddingLeft: compact ? 0 : 8,
      }}
    >
      <ModeChip state={state} onModeChange={onModeChange} />
      {permissionControl}
      <span data-testid="composer-selector-attach" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{attachControl}</span>
      {leadingControls ? (
        <span data-testid="composer-selector-leading-controls" style={{ display: 'inline-flex', alignItems: 'center', gap: compact ? 0 : 6, minWidth: 0, flexShrink: 0 }}>
          {leadingControls}
        </span>
      ) : null}
      <span data-composer-spacer data-testid="composer-selector-spacer" style={{ flex: 1, minWidth: 0 }} />
      {meterControl ? (
        <span data-testid="composer-selector-meter" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {meterControl}
        </span>
      ) : null}
      <ComposerPicker
        state={state}
        composerModelGroups={composerModelGroups}
        onModelChange={onModelChange}
        onBackendChange={onBackendChange}
        onEffortChange={onEffortChange}
        onRequestTextareaFocus={onRequestTextareaFocus}
        saving={saving}
      />
      <span data-testid="composer-selector-mic" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{micControl}</span>
      {voiceControl ? <span data-testid="composer-selector-voice" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{voiceControl}</span> : null}
      <span data-testid="composer-selector-send" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{sendControl}</span>
    </div>
  );
}
