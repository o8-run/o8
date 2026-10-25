'use client';

import type { RuntimeConnectionEvidence } from '@/lib/runtimes/shared/connection-evidence';

/**
 * Shared types, option constants, and the PickerMenu control for the Dispatch
 * settings tab (OperatorDefaultsTab + DispatchFoundersSection). Split out so
 * the Founders section can live in its own file without circular imports
 * (epic #1450 — settings professionalization).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UpdateAutoApply } from '@/lib/app-update/types';
import { MODEL_IDS } from '@/lib/models';
import {
  getRuntimeCapability,
  listDispatchableRuntimes,
  type OrchestratorRuntime,
  type RuntimeAuthHouse,
} from '@/lib/orchestrator/runtime-capabilities';
import { THINKING_EFFORT_LABELS, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { AgentRoleRoute } from '@/lib/operator/role-routing';
import type { JudgmentProvider } from '@/lib/operator/judgment-default';
import type { JudgmentPath } from '@/lib/judgment/route';
import type { RoleRoutingReceipt } from '@/lib/operator/role-routing-ledger';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_INK_QUIET,
} from './shared';

export type OverlapGateMode = 'advisory' | 'strict';
export type { ThinkingEffort };
export type SettingSource = 'env' | 'file' | 'profile' | 'default';

export type SubscriptionProfile = 'both' | 'claude-only' | 'codex-only';
export type DispatchRuntime = OrchestratorRuntime;
export type ClassAComposer = 'auto' | 'haiku-cli' | 'sonnet-cli' | 'fastest';
export type BrainRoutingMode = 'auto' | 'subscription';
export type WorkersUseBrain = 'off' | 'auto' | 'all';
export type WorkspaceManifestPolicy = 'disabled' | 'one-approval' | 'auto';
// Was a hand-maintained copy that had drifted three backends behind
// (missing fable, o8, opencode) — see lib/operator/backend-setting.ts.
import type { OrchestratorBackendSetting } from '@/lib/operator/backend-setting';

export type { OrchestratorBackendSetting };
export type ReviewerBackendSetting = 'follow' | 'codex' | 'claude';
export type { UpdateAutoApply };
export type CollideAggregator = 'auto' | 'claude' | 'codex';
export type PrLinkDestination = 'in-app' | 'browser';
export type ReviewReadyNotifications = 'off' | 'on';
export type RequireApproval = 'high-risk' | 'surface' | 'always' | 'never';

export interface TargetingTierUI {
  runtime: DispatchRuntime;
  model: string;
  effort: ThinkingEffort;
}

export interface OperatorDefaults {
  subscriptionProfile: SubscriptionProfile;
  parallelCap: number;
  meteredPacketCostCapUsd: number;
  meteredPacketInputTokenCap: number;
  uiLoopMaxIterations: number;
  uiLoopMaxMinutes: number;
  uiLoopMaxDiffBytes: number;
  uiLoopMaxDiffFiles: number;
  uiLoopPreviewTimeoutMs: number;
  overlapGate: OverlapGateMode;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
  reviewContinuation: boolean;
  codexAppThreads: boolean;
  apfsDependencyImages: boolean;
  requireApproval: RequireApproval;
  thinkingEffort: ThinkingEffort;
  promptCachingEnabled: boolean;
  autoTitleInferenceEnabled: boolean;
  orchestratorModel: string;
  /**
   * opencode ACP model pins. Null = unset, meaning the agent's own default.
   * Discovered ids, so there is no fixed option list to type them against —
   * the picker only offers what the local agent reported.
   */
  opencodeOrchestratorModel: string | null;
  opencodeWorkerModel: string | null;
  /** 3code CLI model pin. Null leaves the local 3code configuration in control. */
  threecodeWorkerModel: string | null;
  defaultDispatchRuntime: DispatchRuntime;
  workerExecutionCarrier: 'ori' | null;
  workerRuntimes: DispatchRuntime[];
  codexWorkerEffort: ThinkingEffort;
  claudeWorkerEffort: ThinkingEffort;
  brainCodexModel: string;
  brainCodexEffort: ThinkingEffort;
  brainRoutingMode: BrainRoutingMode;
  defaultDispatchModel: string;
  localInferenceBaseUrl: string;
  localEmbedModel: string;
  localChatModel: string;
  experimentalOpencode: boolean;
  experimentalGemini: boolean;
  experimentalChat: boolean;
  experimentalCanvas: boolean;
  experimentalNext: boolean;
  nativeBrowserView: boolean;
  classAComposer: ClassAComposer;
  inAppOrchestratorEnabled: boolean;
  brainUseClaudeCli: boolean;
  brainWarmupEnabled: boolean;
  workersUseBrain: WorkersUseBrain;
  /** Typed judgment provider (#2434). 'off' sends nothing anywhere. */
  judgmentProvider: JudgmentProvider;
  /** Managed judgment calls per install per day (#2486). Null = not configured. */
  judgmentManagedDailyAllowance: number | null;
  /** Last day of the managed judgment public beta, YYYY-MM-DD (#2486). Null = no expiry. */
  judgmentBetaEndDate: string | null;
  /** Shows Managed in the judgment row (#2485). Off until the hosted endpoint exists. */
  judgmentManagedOptionVisible: boolean;
  workspaceManifestPolicy: WorkspaceManifestPolicy;
  crossHouseWorkerFallback: boolean;
  orchestratorBackend: OrchestratorBackendSetting;
  reviewerBackend: ReviewerBackendSetting;
  packetExplainerEnabled: boolean;
  quizGateEnabled: boolean;
  buyinDocEnabled: boolean;
  targetingTriage: TargetingTierUI;
  targetingAction: TargetingTierUI;
  updateAutoApply: UpdateAutoApply;
  collideAggregator: CollideAggregator;
  productTelemetryEnabled: boolean;
  telemetryConsentAnswered: boolean;
  telemetryOptIn: boolean;
  telemetryIngestUrl: string;
  crashReportsEnabled: boolean;
  branchPrefix: string;
  commitAttributionEnabled: boolean;
  prLinkDestination: PrLinkDestination;
  /** Presentation (quiet) mode — suppresses every non-critical surface (#2147). */
  presentationQuietMode: boolean;
  /** Native "ready for review" banner (#2150). Quiet mode forces it off. */
  notificationsReviewReady: ReviewReadyNotifications;
}

type ProfileControlledSetting = 'orchestratorBackend' | 'reviewerBackend' | 'defaultDispatchRuntime';
export type OperatorDefaultSources = {
  [Key in keyof OperatorDefaults]: Key extends ProfileControlledSetting
    ? SettingSource
    : Exclude<SettingSource, 'profile'>;
};

export interface OperatorDefaultsResponse {
  values: OperatorDefaults;
  sources: OperatorDefaultSources;
  /** The path a judgment call takes right now, from the route resolver (#2485). */
  judgmentPath?: JudgmentPath;
  effectiveOverride: {
    apfsDependencyImages: boolean | null;
  };
  settingsToml?: {
    path: string;
    text: string;
    revision: string;
    error: string | null;
  };
  nextWindowError?: string | null;
  cliAuth?: {
    statuses: Record<RuntimeAuthHouse, {
      installed: boolean;
      /** Usability verdict. `authenticated` below is credential evidence only. */
      ready: boolean;
      authenticated: boolean;
      detail: string;
      fix: string;
    }>;
    suggestedSubscriptionProfile: {
      profile: SubscriptionProfile | null;
      detail: string | null;
    };
  };
  dispatchableRuntimes?: Array<{
    id: DispatchRuntime;
    label: string;
    available: boolean;
    connection?: RuntimeConnectionEvidence;
    unavailableReason: 'not_installed' | 'needs_auth' | 'needs_restart' | 'adapter_unavailable' | null;
    detail: string;
    fix: string;
  }>;
  roleRoutes?: AgentRoleRoute[];
  recentRoleReceipts?: RoleRoutingReceipt[];
}

export const ENV_LOCKED_REASON = 'Locked by an environment variable — unset it to manage from Settings.';

export const REQUIRE_APPROVAL_OPTIONS: Array<{ value: RequireApproval; label: string }> = [
  { value: 'always', label: 'Always' },
  { value: 'surface', label: 'Task owner' },
  { value: 'high-risk', label: 'After review' },
  { value: 'never', label: 'Never' },
];

export const MERGE_APPROVAL_DESCRIPTIONS: Record<RequireApproval, string> = {
  always: 'Ask before agent merges, even after automated review.',
  surface: 'Send changes needing approval to the person or agent that started the task. Routine reviewed changes can merge automatically.',
  'high-risk': 'Allow reviewed changes to merge automatically; other merges require approval.',
  never: 'Skip routine merge approval. Required checks and blocking safeguards still apply.',
};

export const SUBSCRIPTION_PROFILE_OPTIONS: Array<{ value: SubscriptionProfile; label: string; detail: string }> = [
  { value: 'both', label: 'All available', detail: 'Allow any connected tool to run tasks. Choose the default worker below.' },
  { value: 'claude-only', label: 'Claude only', detail: 'Everything runs on your Claude subscription — Opus orchestrates, Sonnet works, escalates only when needed.' },
  { value: 'codex-only', label: 'Codex / OpenAI only', detail: 'Use connected Codex / OpenAI models for orchestration and workers. Choose their defaults below.' },
];

const SETTINGS_THINKING_EFFORTS: readonly ThinkingEffort[] = [
  'adaptive', 'low', 'medium', 'high', 'max', 'xhigh',
];

export const THINKING_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string; detail: string }> = SETTINGS_THINKING_EFFORTS.map((value) => ({
  value,
  label: THINKING_EFFORT_LABELS[value].long,
  detail: THINKING_EFFORT_LABELS[value].detail,
}));

export const CODEX_WORKER_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string; detail: string }> = [
  { value: 'adaptive', label: 'Runtime default', detail: 'Leave Codex at its default.' },
  { value: 'low', label: THINKING_EFFORT_LABELS.low.long, detail: 'Quick worker turns.' },
  { value: 'medium', label: THINKING_EFFORT_LABELS.medium.long, detail: 'Balanced cost and quality.' },
  { value: 'high', label: THINKING_EFFORT_LABELS.high.long, detail: 'Deeper worker reasoning.' },
  { value: 'xhigh', label: THINKING_EFFORT_LABELS.xhigh.long, detail: 'Codex top effort.' },
];

export const CLAUDE_WORKER_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string; detail: string }> = [
  { value: 'adaptive', label: 'Runtime default', detail: 'Leave Claude Code at its default.' },
  { value: 'low', label: THINKING_EFFORT_LABELS.low.long, detail: 'Quick worker turns.' },
  { value: 'medium', label: THINKING_EFFORT_LABELS.medium.long, detail: 'Balanced cost and quality.' },
  { value: 'high', label: THINKING_EFFORT_LABELS.high.long, detail: 'Deeper worker reasoning.' },
  { value: 'max', label: THINKING_EFFORT_LABELS.max.long, detail: 'Claude Code top effort.' },
];

export const BRAIN_CODEX_MODEL_OPTIONS: Array<{ value: string; label: string; detail: string }> = [
  { value: MODEL_IDS.raw.openAiGpt6Astra, label: 'Astra', detail: 'Most capable model for complex, demanding work.' },
  { value: MODEL_IDS.raw.openAiGpt61Sol, label: 'GPT-6.1 Sol', detail: 'Balanced model for everyday work.' },
  { value: MODEL_IDS.raw.openAiGpt6Sol, label: 'GPT-6 Sol', detail: 'Balanced model for everyday work.' },
  { value: MODEL_IDS.raw.openAiGpt6Luna, label: 'GPT-6 Luna', detail: 'Fast model for easier tasks.' },
  { value: MODEL_IDS.raw.openAiGpt56Terra, label: 'Terra', detail: 'Balanced Brain answers and repo reasoning.' },
  { value: MODEL_IDS.raw.openAiGpt56Sol, label: 'GPT-5.6 Sol', detail: 'Frontier reasoning for the hardest questions.' },
  { value: MODEL_IDS.raw.openAiGpt56Luna, label: 'Luna', detail: 'Fast, inexpensive factual lookup.' },
  { value: MODEL_IDS.raw.openAiGpt55, label: 'GPT-5.5', detail: 'Previous-generation compatibility route.' },
];

export const ORCHESTRATOR_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: MODEL_IDS.raw.anthropicClaudeOpus55, label: 'Opus 5.5' },
  { value: MODEL_IDS.raw.anthropicClaudeFable51, label: 'Fable 5.1' },
  { value: MODEL_IDS.raw.anthropicClaudeFable5, label: 'Fable 5' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus5, label: 'Opus 5' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus47, label: 'Opus 4.7' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus46, label: 'Opus 4.6' },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5' },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet45, label: 'Sonnet 4.5' },
  { value: MODEL_IDS.raw.anthropicClaudeHaiku45, label: 'Haiku 4.5' },
];

export const DISPATCH_RUNTIME_OPTIONS: Array<{ value: DispatchRuntime; label: string; detail: string }> =
  listDispatchableRuntimes().map((value) => {
    const capability = getRuntimeCapability(value);
    return { value, label: capability.label, detail: capability.description };
  });

export const PICKER_MENU_POPOVER_BG = 'var(--t-popover-surface)';

export function resolvePickerGroupOpen(current: string | null, pickerId: string, nextOpen: boolean): string | null {
  if (nextOpen) return pickerId;
  return current === pickerId ? null : current;
}

export function nextPickerHighlightIndex(
  current: number,
  optionCount: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number {
  if (optionCount <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return optionCount - 1;
  if (key === 'ArrowUp') return current <= 0 ? optionCount - 1 : current - 1;
  return current < 0 || current >= optionCount - 1 ? 0 : current + 1;
}

export function PickerMenu<T extends string>({ value, options, onChange, disabled, minWidth, open: controlledOpen, onOpenChange }: {
  value: T;
  options: Array<{ value: T; label: string; detail?: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  minWidth?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const open = controlledOpen ?? uncontrolledOpen;
  const active = options.find((opt) => opt.value === value);
  const activeIndex = options.findIndex((opt) => opt.value === value);

  const setOpen = useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    if (nextOpen) {
      setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
      setHighlightedIndex(activeIndex >= 0 ? activeIndex : 0);
    }
    onOpenChange?.(nextOpen);
  }, [activeIndex, controlledOpen, onOpenChange]);

  const chooseHighlighted = useCallback(() => {
    const option = options[highlightedIndex];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }, [highlightedIndex, onChange, options, setOpen]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, setOpen]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (disabled) return;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
            setHighlightedIndex(nextPickerHighlightIndex(activeIndex, options.length, event.key));
            return;
          }
          if (!open) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            chooseHighlighted();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const navigationKey = event.key;
            setHighlightedIndex((current) => nextPickerHighlightIndex(current, options.length, navigationKey));
          }
        }}
        style={{
          minWidth: minWidth ?? 140,
          minHeight: 44,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 14,
          paddingRight: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: open ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
          borderRadius: 9,
          background: RAMS_CONTROL_BG,
          color: 'var(--t-text)',
          fontSize: 12,
          fontWeight: 400,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: APP_FONT_STACK,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          opacity: disabled ? 0.6 : 1,
          letterSpacing: '-0.005em',
          transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <span>{active?.label ?? value}</span>
        <svg
          width={11}
          height={11}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)', color: RAMS_INK_QUIET }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && !disabled && anchorRect && typeof document !== 'undefined' ? createPortal((
        <div
          id={listboxId}
          ref={popoverRef}
          data-o8-settings-portal="true"
          data-o8-settings-escape-scope
          role="listbox"
          aria-label="Settings picker options"
          aria-activedescendant={highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
          onMouseDown={(event) => event.preventDefault()}
          style={{
            position: 'fixed',
            top: anchorRect.bottom + 6,
            right: Math.max(8, window.innerWidth - anchorRect.right),
            minWidth: minWidth ?? 220,
            border: `1px solid ${RAMS_CONTROL_BORDER}`,
            borderRadius: 9,
            background: PICKER_MENU_POPOVER_BG,
            zIndex: 10000,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 0,
            paddingRight: 0,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 280,
            overflowY: 'auto',
            boxShadow: 'var(--t-panel-shadow)',
          }}
        >
          {options.map((opt, index) => {
            const isActive = opt.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <button
                key={opt.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                onMouseEnter={() => setHighlightedIndex(index)}
                style={{
                  minHeight: 44,
                  justifyContent: 'center',
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  border: 'none',
                  background: isHighlighted ? 'var(--t-hover)' : 'transparent',
                  color: isActive ? RAMS_ACCENT : 'var(--t-text)',
                  fontSize: 12,
                  fontWeight: isActive ? 500 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: APP_FONT_STACK,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  letterSpacing: '-0.005em',
                }}
              >
                <span>{opt.label}</span>
                {opt.detail ? (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 400,
                    color: RAMS_INK_QUIET,
                    fontFamily: APP_FONT_STACK,
                  }}>
                    {opt.detail}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ), document.body) : null}
    </div>
  );
}
