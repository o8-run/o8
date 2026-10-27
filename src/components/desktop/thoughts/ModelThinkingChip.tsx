import { useEffect, useRef, useState } from 'react';
import { useRuntimeInventory } from '../onboarding/useRuntimeInventory';
import { RuntimeToolsPanel } from '../onboarding/RuntimeToolsPanel';
import { runtimeForLead, visibleRuntimeInventory } from '@/lib/setup/runtime-recommendation';
import { ComposerPopover } from './chat-panel/ComposerPopover';
import { THINKING_EFFORT_LABELS, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorBackendSetting } from './operator-defaults';
import { MODEL_IDS } from '@/lib/models';
import { codexSupportsReasoningEffort } from '@/lib/codex/reasoning-effort';
import { AcpModelPicker } from './AcpModelPicker';
import { shortModelLabel as acpShortModelLabel } from '@/lib/orchestrator/acp-model-catalogue';
import { CLAUDE_CODE_PROFILE_CHANGED_EVENT } from '@/lib/claude-code/worker-profile-types';
import { formatModelLabel } from '@/lib/format';
import { composerModeSpec, type ComposerMode } from './composer-mode';
import {
  isHotComposerEffort,
  resolveEffectiveComposerLeadModelId,
  supportedEffortsForLead,
} from './composer-selector/state';
import { useUltraEffortPreference } from './composer-selector/UltraEffortPreference';
import { ServiceTierPicker } from './composer-selector/ServiceTierPicker';

const EFFORT_LEVEL: Record<ThinkingEffort, number> = {
  // Between medium (3) and high (4): adaptive auto-picks in that band, so its
  // bars fill 3 solid + a half-lit fourth — reading as "between medium and high".
  adaptive: 3.5,
  none: 0,
  minimal: 0.5,
  low: 1,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 6,
};

const SWARM_ACCENT = 'var(--t-brand-orange, #FF5A1F)';
const MODEL_THINKING_MENU_WIDTH = 200;
// The searchable (ACP) house renders two-line model rows — a label plus the
// full provider-qualified id — and at 200px four DeepSeek V4 rows truncated
// identically (live-hit 2026-08-05). The menu widens only while that house is
// open; the fixed houses keep their locked 200px geometry.
const SEARCHABLE_HOUSE_MENU_WIDTH = 300;

// Synthetic model id for the o8 backend — there is no underlying model name
// exposed in the UI (monetization doctrine: we own the brand, hide the model).
// This value is what `onModelChange` stores and what `activeModelOption` matches,
// so it keeps its original value for saved selections.
const O8_FREE_MODEL_ID = 'o8-free';

export type ComposerModelOption = {
  value: string;
  label: string;
  backend: OrchestratorBackendSetting;
  model?: string;
  sub?: string;
  /** Compact name for the composer trigger (defaults to `label`). */
  triggerLabel?: string;
};

export type ComposerModelGroup = {
  key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse';
  label: string;
  options: ComposerModelOption[];
  /**
   * True for houses whose model list is discovered from the running agent
   * rather than declared here. Those render `AcpModelPicker` and leave
   * `options` empty — hardcoding even a shortlist would drift from whatever
   * the operator's install is actually authenticated for.
   */
  searchable?: boolean;
};

// Grouped by house (Q ruling 2026-07-11): a Claude drawer and a Codex drawer,
// models nested under each. Codex exposes Astra, Sol, and Terra as
// orchestrator-worthy picks. Each runs as the Codex
// orchestrator model via resolveOrchestratorModelSync.
export const COMPOSER_MODEL_GROUPS: ComposerModelGroup[] = [
  {
    key: 'claude',
    label: 'Claude',
    options: [
      { value: MODEL_IDS.raw.anthropicClaudeFable51, label: 'Fable 5.1', backend: 'fable', model: MODEL_IDS.fableDefault, sub: 'flagship' },
      { value: MODEL_IDS.raw.anthropicClaudeOpus55, label: 'Opus 5.5', backend: 'claude', model: MODEL_IDS.raw.anthropicClaudeOpus55, sub: 'recommended lead' },
      { value: MODEL_IDS.raw.anthropicClaudeOpus5, label: 'Opus 5', backend: 'claude', model: MODEL_IDS.raw.anthropicClaudeOpus5, sub: 'deep reasoning' },
      { value: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8', backend: 'claude', model: MODEL_IDS.raw.anthropicClaudeOpus48, sub: 'previous Opus' },
      { value: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5', backend: 'claude', model: MODEL_IDS.claudeQaDefault, sub: 'everyday' },
    ],
  },
  {
    key: 'codex',
    label: 'Codex',
    options: [
      { value: MODEL_IDS.raw.openAiGpt6Astra, label: 'GPT-6 Astra', triggerLabel: 'Astra', backend: 'codex', model: MODEL_IDS.raw.openAiGpt6Astra, sub: 'orchestrator flagship' },
      { value: MODEL_IDS.raw.openAiGpt61Sol, label: 'GPT-6.1 Sol', triggerLabel: '6.1 Sol', backend: 'codex', model: MODEL_IDS.raw.openAiGpt61Sol, sub: 'everyday orchestrator' },
      { value: MODEL_IDS.raw.openAiGpt6Sol, label: 'GPT-6 Sol', triggerLabel: '6 Sol', backend: 'codex', model: MODEL_IDS.raw.openAiGpt6Sol, sub: 'previous Sol' },
      { value: MODEL_IDS.raw.openAiGpt6Luna, label: 'GPT-6 Luna', triggerLabel: '6 Luna', backend: 'codex', model: MODEL_IDS.raw.openAiGpt6Luna, sub: 'fast model for easier tasks' },
      { value: MODEL_IDS.raw.openAiGpt56Sol, label: 'GPT-5.6 Sol', triggerLabel: '5.6 Sol', backend: 'codex', model: MODEL_IDS.raw.openAiGpt56Sol, sub: 'flagship · Fable-class' },
      { value: MODEL_IDS.raw.openAiGpt56Terra, label: 'GPT-5.6 Terra', triggerLabel: 'Terra', backend: 'codex', model: MODEL_IDS.raw.openAiGpt56Terra, sub: 'Sonnet-class worker' },
    ],
  },
  // The model-agnostic house (#1729). Not bound to a provider: its catalogue is
  // whatever the local opencode install is authenticated for, read live from the
  // ACP session, so the operator can orchestrate on OpenRouter/Google/xAI models
  // — and keep working when the Claude and Codex subscriptions are exhausted.
  {
    key: 'opencode',
    label: 'OpenCode',
    options: [],
    searchable: true,
  },
  // OpenClaw + Hermes pulled from the picker (Q ruling 2026-07-16): neither
  // is on the one-click path the official CLIs are. OpenClaw's governed clone
  // needs its own gateway + credential story that broke three ways in one
  // night (invalid config key, model allowlist, SQLite auth migration);
  // Hermes is a Python-venv install that the 2026-07-07 storage cleanup
  // deleted outright while its wrapper script kept reporting "installed".
  // Both backend modules stay registered so existing threads keep working
  // and either can return when its setup story is one-click. Settings →
  // Operator Defaults still offers Hermes when a HEALTHY binary is present
  // (isHermesAvailable now exec-probes instead of existsSync).
  // o8's own house (#3408): its built-in agent, bundled Pi with the full o8
  // command set, on the managed model and the o8 model allowance. Needs no
  // installed CLI or key, so it draws on no Claude/Codex subscription. It is
  // the one Pi entry: a separate Pi row would name the same agent twice.
  {
    key: 'o8',
    label: 'o8',
    options: [
      { value: O8_FREE_MODEL_ID, label: 'o8', triggerLabel: 'o8', backend: 'o8', model: O8_FREE_MODEL_ID, sub: 'Managed model' },
    ],
  },
  { key: 'acp', label: 'Local ACP', options: [], searchable: true },
  { key: 'muse', label: 'Muse Code', options: [], searchable: true },
];

export interface ComposerModelCatalogue {
  groups: ComposerModelGroup[];
  carrier: { source: 'native' | 'openrouter' | 'codex-subscription'; model: string | null } | null;
}

export function useComposerModelCatalogue(enabled = true): ComposerModelCatalogue {
  const [carrier, setCarrier] = useState<ComposerModelCatalogue['carrier']>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      void fetch('/api/runtime/claude-code-profile', { cache: 'no-store' })
        .then(async (response) => response.ok ? response.json() : null)
        .then((payload: { profile?: { source?: unknown }; effectiveModel?: unknown } | null) => {
          const source = payload?.profile?.source;
          const model = payload?.effectiveModel;
          if (!cancelled && (source === 'native' || source === 'openrouter' || source === 'codex-subscription')) {
            setCarrier({ source, model: typeof model === 'string' ? model : null });
          }
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(CLAUDE_CODE_PROFILE_CHANGED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(CLAUDE_CODE_PROFILE_CHANGED_EVENT, load); };
  }, [enabled]);
  const carrierModel = carrier?.model ?? null;
  const carrierSource = carrier?.source;
  const groups = carrierSource && carrierSource !== 'native' && carrierModel
    ? COMPOSER_MODEL_GROUPS.map((group): ComposerModelGroup => group.key === 'claude'
      ? {
          ...group,
          options: [
            ...group.options.filter((option) => option.backend === 'fable'),
            {
              value: `claude-harness:${carrierModel}`,
              label: `${formatModelLabel(carrierModel)} in Claude Code`,
              triggerLabel: formatModelLabel(carrierModel),
              backend: 'claude',
              model: carrierModel,
              sub: carrierSource === 'codex-subscription'
                ? 'Codex subscription · full harness'
                : 'OpenRouter · full harness',
            },
          ],
        }
      : group)
    : COMPOSER_MODEL_GROUPS;
  return { groups, carrier };
}

function ThinkingBars({ effort, active = false }: { effort: ThinkingEffort; active?: boolean }) {
  const level = EFFORT_LEVEL[effort];
  const color = active
    ? (effort === 'max' || effort === 'ultra' ? SWARM_ACCENT : 'var(--t-accent)')
    : 'var(--t-text-faint)';
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1.25, width: 18, height: 9, flexShrink: 0 }}>
      {Array.from({ length: 6 }).map((_, index) => {
        const full = index < Math.floor(level);
        // Fractional step (adaptive's 3.5): the boundary bar is half-lit, so
        // adaptive reads as sitting between medium and high. Integer levels never
        // trigger this, so every other option renders exactly as before.
        const partial = !full && index < level;
        const on = full || partial;
        return (
          <span
            key={index}
            style={{
              width: 2,
              height: 2.25 + (index * 0.8),
              borderRadius: 999,
              background: on ? color : 'color-mix(in srgb, var(--t-text-faint) 22%, transparent)',
              opacity: full ? 1 : partial ? 0.5 : 0.7,
            }}
          />
        );
      })}
    </span>
  );
}

export type EffortStop = { effort: ThinkingEffort; label: string; sub: string };

/** Horizontal track with one discrete stop per supported reasoning effort. */
export function EffortSlider({
  stops,
  index,
  onPick,
}: {
  stops: EffortStop[];
  index: number;
  onPick: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const last = stops.length - 1;
  const clamped = Math.max(0, Math.min(last, index));
  const active = stops[clamped];
  const hot = Boolean(active && isHotComposerEffort(active.effort));
  const accent = hot ? SWARM_ACCENT : 'var(--t-accent)';

  const pickFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || last <= 0) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onPick(Math.round(t * last));
  };

  const pct = last <= 0 ? 0 : (clamped / last) * 100;

  return (
    <div style={{ paddingLeft: 9, paddingRight: 9, paddingTop: 2, paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 9 }}>
        <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, color: hot ? SWARM_ACCENT : 'var(--t-text)' }}>
          {active?.label}
        </span>
        <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.2 }}>
          {active?.sub}
        </span>
      </div>
      {/* Track — 8px inset each side so the handle centers on the end stops
          without clipping. Pointer-drag + click-to-stop. */}
      <div
        role="slider"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={clamped}
        aria-valuetext={active?.label}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onPick(Math.min(last, clamped + 1)); }
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onPick(Math.max(0, clamped - 1)); }
        }}
        style={{ position: 'relative', height: 22, marginLeft: 8, marginRight: 8, cursor: 'pointer', outline: 'none', touchAction: 'none' }}
        onPointerDown={(event) => {
          (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          setDragging(true);
          pickFromClientX(event.clientX);
        }}
        onPointerMove={(event) => { if (dragging) pickFromClientX(event.clientX); }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        {/* Rail */}
        <div ref={trackRef} style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 3, transform: 'translateY(-50%)', borderRadius: 999, background: 'color-mix(in srgb, var(--t-text-faint) 22%, transparent)' }} />
        {/* Filled portion */}
        <div style={{ position: 'absolute', top: '50%', left: 0, width: `${pct}%`, height: 3, transform: 'translateY(-50%)', borderRadius: 999, background: accent, transition: dragging ? 'none' : 'width 140ms cubic-bezier(0.22, 1, 0.36, 1)' }} />
        {/* Stops */}
        {stops.map((stop, i) => {
          const on = i <= clamped;
          return (
            <span
              key={i}
              aria-hidden
              style={{
                position: 'absolute',
                top: '50%',
                left: `${last <= 0 ? 0 : (i / last) * 100}%`,
                width: 5,
                height: 5,
                borderRadius: 999,
                transform: 'translate(-50%, -50%)',
                background: on ? accent : 'color-mix(in srgb, var(--t-text-faint) 40%, transparent)',
              }}
            />
          );
        })}
        {/* Handle */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%',
            left: `${pct}%`,
            width: 13,
            height: 13,
            borderRadius: 999,
            transform: 'translate(-50%, -50%)',
            background: 'var(--t-panel-solid, #fff)',
            border: `2px solid ${accent}`,
            boxShadow: '0 1px 3px rgba(15, 23, 42, 0.18)',
            transition: dragging ? 'none' : 'left 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      </div>
    </div>
  );
}

function SwarmGlyph({ size = 12, color = SWARM_ACCENT }: { size?: number; color?: string }) {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="3.4" r="2" fill={color} />
        <circle cx="3.4" cy="11.6" r="2" fill={color} />
        <circle cx="12.6" cy="11.6" r="2" fill={color} />
      </svg>
    </span>
  );
}

export function ModelThinkingChip({
  modelLabel,
  modelId,
  onModelChange,
  activeBackend,
  onBackendChange,
  effort,
  adaptiveEnabled,
  onEffortChange,
  composerMode = 'solo',
  compact = false,
  split = false,
}: {
  modelLabel: string;
  modelId?: string;
  onModelChange?: (model: string) => void;
  activeBackend?: OrchestratorBackendSetting;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  effort: ThinkingEffort;
  adaptiveEnabled: boolean;
  onEffortChange?: (effort: ThinkingEffort) => void;
  composerMode?: ComposerMode;
  compact?: boolean;
  /** Quiet-text presentation (Q ruling 2026-07-11): model and thinking
      level render as two separate quiet-text triggers ("Fable 5" · "High")
      instead of one bordered chip with bars. Both open the shared menu. */
  split?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const tools = useRuntimeInventory(open);
  const [acpAvailable, setAcpAvailable] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch('/api/setup/orchestrator-backends').then(response => response.json()).then(data => { if (alive) setAcpAvailable(data.acp === true); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);
  const [advancedLeads, setAdvancedLeads] = useState(false);
  const installed = visibleRuntimeInventory(tools.inventory ?? []);
  const visibleLead = (key: ComposerModelGroup['key']) => {
    const current = key === activeBackend || (key === 'claude' && activeBackend === 'fable');
    if (current) return true;
    if (key === 'acp') return acpAvailable;
    if (key === 'o8') return advancedLeads;
    const tool = runtimeForLead(key);
    return installed.some((item) => item.id === tool) && (key !== 'opencode' || advancedLeads);
  };
  const leadReady = (key: ComposerModelGroup['key']) => key === 'o8' || (key === 'acp' && acpAvailable)
    || tools.inventory?.some((item) => item.id === runtimeForLead(key) && item.available) === true;
  const { groups: composerModelGroups, carrier: harnessCarrier } = useComposerModelCatalogue(Boolean(onEffortChange || onModelChange || onBackendChange));
  const ultraEnabled = useUltraEffortPreference();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const splitRef = useRef<HTMLSpanElement>(null);
  const selectedLabel = THINKING_EFFORT_LABELS[effort].short;
  const effortHot = isHotComposerEffort(effort);
  const mode = composerModeSpec(composerMode);
  const deepModeActive = composerMode === 'fusion' || composerMode === 'moa';
  const modelSwitchable = Boolean(onModelChange || onBackendChange);
  const canOpen = Boolean(onEffortChange || onModelChange || onBackendChange);
  const showingAffordance = canOpen && (hovered || focused || open);
  const isCodexBackend = activeBackend === 'codex';
  const effortSectionLabel = isCodexBackend ? 'Reasoning' : 'Thinking';
  const effortTitle = isCodexBackend ? 'reasoning' : 'thinking';
  const normalizedModelId = modelId?.replace(/\[[^\]]*\]$/, '');
  const effectiveModelId = activeBackend === 'claude' && harnessCarrier?.source !== 'native'
    ? harnessCarrier?.model ?? normalizedModelId
    : activeBackend === 'codex'
      ? resolveEffectiveComposerLeadModelId(activeBackend, normalizedModelId)
      : normalizedModelId;
  // The composer trigger should name the actual MODEL, not the provider
  // (Q ruling 2026-07-11 — "you might need to know what model you're on").
  // Resolve it from the picked (backend, modelId); fall back to the provider
  // label only when nothing matches (e.g. a fresh 'auto' session before a pick).
  const activeModelOption = composerModelGroups
    .flatMap((g) => g.options)
    .find((o) => activeBackend === o.backend && (!o.model || effectiveModelId === o.model));
  // A searchable house has no static options, so activeModelOption never
  // matches and the chip would fall back to the PROVIDER name — the exact
  // thing the Q ruling below says it must not do. Derive the model's own short
  // name from its id instead.
  const searchableHouseLabel = composerModelGroups.some((g) => g.searchable && g.key === activeBackend)
    ? acpShortModelLabel(normalizedModelId)
    : null;
  const triggerModelLabel = activeModelOption?.triggerLabel ?? activeModelOption?.label ?? searchableHouseLabel ?? modelLabel;
  // Which house drawer is open in the model picker. Defaults to the active
  // backend's house so the current model is visible on open.
  const [openHouse, setOpenHouse] = useState<ComposerModelGroup['key']>(
    activeBackend === 'codex' || activeBackend === 'openclaw' || activeBackend === 'hermes' || activeBackend === 'o8' || activeBackend === 'opencode' || activeBackend === 'muse'
      ? activeBackend
      : activeBackend === 'pi' ? 'o8' : 'claude',
  );
  // The ACP house needs a wider menu than the fixed drawers (see the width
  // constants) — derived from the open house, not the active backend, so the
  // menu resizes the moment the operator expands opencode.
  const searchableHouseOpen = composerModelGroups.some((group) => group.searchable && group.key === openHouse);
  // Thinking levels are only KNOWN for the Claude-family and Codex backends
  // ('auto' resolves to one of them). Every other runtime uses its default
  // effort and the thinking trigger stays hidden — no bespoke picker for
  // levels we can't actually steer (Q ruling 2026-07-11).
  const thinkingKnown = activeBackend === 'claude' || activeBackend === 'fable'
    || activeBackend === 'codex' || activeBackend === 'auto';
  // The o8 lead has one managed setting, so it shows no effort control
  // (#2999, #3660). Mode rows (Solo/Collide) stay hidden for o8.
  const isO8Backend = activeBackend === 'o8';
  const options = supportedEffortsForLead(
    activeBackend ?? 'auto',
    effectiveModelId ?? '',
    adaptiveEnabled,
    ultraEnabled,
  );
  // Backends without steerable thinking expose no effort stops.
  const hideEffortUi = options.length === 0 || !thinkingKnown;
  const useSplit = split && !compact;

  const effortStops: EffortStop[] = options.map((option) => ({
    effort: option,
    label: THINKING_EFFORT_LABELS[option].long,
    sub: option === 'adaptive' ? 'auto' : `${EFFORT_LEVEL[option]}/6`,
  }));
  const currentEffortIndex = Math.max(0, options.indexOf(effort));
  const handleEffortPick = (idx: number) => {
    const stop = effortStops[idx];
    if (!stop) return;
    onEffortChange?.(stop.effort);
  };

  const quietTriggerStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    maxWidth: 180,
    paddingTop: 0,
    paddingRight: 5,
    paddingBottom: 0,
    paddingLeft: 5,
    borderWidth: 0,
    borderRadius: 6,
    background: active ? 'var(--t-hover)' : 'transparent',
    color: active ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans-system)',
    fontSize: 11,
    fontWeight: 300,
    letterSpacing: '0',
    whiteSpace: 'nowrap',
    transition: 'color 140ms, background 140ms',
  });

  return (
    <>
      {useSplit ? (
        // Right cluster: "Fable 5   High" — two quiet text
        // triggers, no border/bars/chevron at rest. Both open the shared menu.
        <span ref={splitRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {deepModeActive ? <SwarmGlyph size={11} /> : null}
          <button
            type="button"
            onClick={() => { if (canOpen) setOpen((current) => !current); }}
            disabled={!canOpen}
            title={`${triggerModelLabel} · ${mode.long}`}
            aria-haspopup="menu"
            aria-expanded={open}
            style={quietTriggerStyle(open)}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = open ? 'var(--t-text-muted)' : 'var(--t-text-faint)'; }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{triggerModelLabel}</span>
          </button>
          {thinkingKnown && onEffortChange ? (() => {
            const tierLabel = selectedLabel.charAt(0).toUpperCase() + selectedLabel.slice(1);
            return (
              <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                title={`${effortSectionLabel}: ${tierLabel}`}
                aria-haspopup="menu"
                aria-expanded={open}
                style={{ ...quietTriggerStyle(open), color: effortHot ? SWARM_ACCENT : (open ? 'var(--t-text-muted)' : 'var(--t-text-faint)') }}
                onMouseEnter={(event) => { event.currentTarget.style.color = effortHot ? SWARM_ACCENT : 'var(--t-text)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = effortHot ? SWARM_ACCENT : (open ? 'var(--t-text-muted)' : 'var(--t-text-faint)'); }}
              >
                {tierLabel}
              </button>
            );
          })() : null}
        </span>
      ) : (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (canOpen) setOpen((current) => !current); }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={!canOpen}
        title={canOpen ? `${triggerModelLabel} · ${mode.long} · ${effortTitle} ${selectedLabel}` : triggerModelLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          height: 22,
          maxWidth: 200,
          paddingTop: 0,
          paddingRight: canOpen ? 6 : 0,
          paddingBottom: 0,
          paddingLeft: canOpen ? 5 : 0,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: deepModeActive ? `color-mix(in srgb, ${SWARM_ACCENT} 32%, transparent)` : showingAffordance ? 'var(--t-border)' : 'transparent',
          borderRadius: 7,
          background: deepModeActive ? `color-mix(in srgb, ${SWARM_ACCENT} 8%, transparent)` : showingAffordance ? 'var(--t-hover)' : 'transparent',
          color: deepModeActive ? 'var(--t-text)' : showingAffordance ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
          cursor: canOpen ? 'pointer' : 'default',
          outline: focused && canOpen ? '2px solid var(--t-focus-ring)' : 'none',
          outlineOffset: 1,
          fontFamily: 'var(--font-sans-system)',
          transition: 'background 160ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms cubic-bezier(0.22, 1, 0.36, 1), color 160ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {compact ? null : (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 300, letterSpacing: '0' }}>
            {triggerModelLabel}
          </span>
        )}
        {deepModeActive ? <SwarmGlyph size={11} /> : null}
        {isO8Backend ? null : <ThinkingBars effort={effort} active={open || effort === 'max' || effort === 'ultra' || (isCodexBackend && effort === 'xhigh')} />}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: canOpen ? 0.72 : 0 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      )}

      <ComposerPopover anchorRef={useSplit ? splitRef : buttonRef} open={open} onClose={() => setOpen(false)} align={useSplit ? 'end' : 'start'}>
        <div
          role="menu"
          aria-label="Model and thinking"
          style={{
            width: searchableHouseOpen ? SEARCHABLE_HOUSE_MENU_WIDTH : MODEL_THINKING_MENU_WIDTH,
            paddingTop: 7,
            paddingRight: 5,
            paddingBottom: 5,
            paddingLeft: 5,
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            background: 'var(--t-popover-surface)',
            backdropFilter: 'blur(18px) saturate(1.3)',
            boxShadow: 'var(--t-panel-shadow)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {modelSwitchable ? (
            <>
              <div style={{ paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 2 }}>
                <div style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>Model</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {composerModelGroups.filter((group) => visibleLead(group.key)).map((group) => {
                  const houseOpen = openHouse === group.key;
                  const houseHasActive = group.options.some((o) => activeBackend === o.backend && (!o.model || effectiveModelId === o.model));
                  return (
                    <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {/* Drawer header — click to expand this house. */}
                      <button
                        type="button"
                        aria-expanded={houseOpen}
                        onClick={() => setOpenHouse(group.key)}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) auto',
                          alignItems: 'center',
                          gap: 6,
                          minHeight: 24,
                          paddingTop: 2,
                          paddingRight: 6,
                          paddingBottom: 2,
                          paddingLeft: 7,
                          borderWidth: 0,
                          borderRadius: 8,
                          background: 'transparent',
                          color: 'var(--t-text)',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontFamily: 'var(--font-sans-system)',
                        }}
                        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
                        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 400, letterSpacing: '0', lineHeight: 1.2 }}>{group.label}{group.key === 'opencode' ? ' · experimental' : ''}</span>
                          {!houseOpen && houseHasActive ? <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--t-accent)', flexShrink: 0 }} /> : null}
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.6, transform: houseOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {/* A model-agnostic house has no fixed option list — its
                          models come from the live agent, so it renders a
                          searchable picker instead of a drawer of literals. */}
                      {houseOpen && !leadReady(group.key) ? <div style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>{tools.loading ? 'Checking readiness…' : tools.inventory?.find((item) => item.id === runtimeForLead(group.key))?.fix || 'Connect this tool using Add tools below.'}</div> : null}
                      {houseOpen && leadReady(group.key) && group.key === 'acp' ? <button type="button" onClick={() => { onBackendChange?.('acp', ''); setOpen(false); }} style={{ border: 0, borderRadius: 8, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, background: 'var(--t-hover)', color: 'var(--t-text)', cursor: 'pointer', textAlign: 'left' }}>Use agent default</button> : null}
                      {houseOpen && leadReady(group.key) && group.searchable ? (
                        <AcpModelPicker
                          backend={group.key}
                          value={activeBackend === group.key ? (modelId ?? null) : null}
                          width={SEARCHABLE_HOUSE_MENU_WIDTH}
                          onSelect={(picked: string) => {
                            if (activeBackend === group.key) onModelChange?.(picked);
                            else onBackendChange?.(group.key as OrchestratorBackendSetting, picked);
                            setOpen(false);
                          }}
                        />
                      ) : null}
                      {/* Models nested under the open house. */}
                      {houseOpen && leadReady(group.key) && !group.searchable ? group.options.map((option) => {
                        const active = activeBackend === option.backend && (!option.model || effectiveModelId === option.model);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              if (activeBackend === option.backend) {
                                if (option.model) onModelChange?.(option.model);
                              } else {
                                onBackendChange?.(option.backend, option.model);
                              }
                              // Drop an effort only when the shared verified catalog excludes it.
                              if (!codexSupportsReasoningEffort(option.model, 'ultra') && effort === 'ultra') onEffortChange?.('max');
                              // The o8 lead has one managed setting (#3660).
                              if (option.backend === 'o8') onEffortChange?.('low');
                              setOpen(false);
                            }}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(0, 1fr) auto',
                              alignItems: 'center',
                              gap: 6,
                              minHeight: 26,
                              paddingTop: 3,
                              paddingRight: 6,
                              paddingBottom: 3,
                              paddingLeft: 18,
                              borderWidth: 0,
                              borderRadius: 8,
                              background: active ? 'var(--t-accent-soft)' : 'transparent',
                              color: active ? 'var(--t-accent)' : 'var(--t-text)',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontFamily: 'var(--font-sans-system)',
                            }}
                            onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
                            onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
                          >
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 13, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                              {option.sub ? <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.sub}</span> : null}
                            </span>
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: active ? 'var(--t-accent)' : 'transparent', flexShrink: 0 }} />
                          </button>
                        );
                      }) : null}
                    </div>
                  );
                })}
                <button type="button" aria-expanded={advancedLeads} onClick={() => setAdvancedLeads((current) => !current)} style={{ border: 0, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300, padding: 7, cursor: 'pointer', textAlign: 'left' }}>{advancedLeads ? 'Standard leads' : 'Customize leads'}</button>
                <RuntimeToolsPanel inventory={tools.inventory} loading={tools.loading} error={tools.error} onRefresh={tools.refresh} />
              </div>
              {hideEffortUi ? null : (
                <div style={{ marginTop: 4, paddingLeft: 7, paddingRight: 7, paddingTop: 6, paddingBottom: 2, borderTop: '1px solid var(--t-divider-subtle)' }}>
                  <div style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>{effortSectionLabel}</div>
                </div>
              )}
            </>
          ) : (
            <div style={{ paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 6, borderBottom: '1px solid var(--t-divider-subtle)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', color: 'var(--t-text)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{triggerModelLabel}</div>
              <div style={{ marginTop: 2, fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>{effortSectionLabel}</div>
            </div>
          )}
          {onEffortChange && !hideEffortUi ? (
            <EffortSlider stops={effortStops} index={currentEffortIndex} onPick={handleEffortPick} />
          ) : null}
          {onEffortChange && !hideEffortUi ? <ServiceTierPicker backend={activeBackend ?? 'claude'} model={modelId ?? ''} disabled={false} /> : null}

          {/* Mode section removed (Q 2026-07-17): Solo / Multitask /
              Mixture of Agents live in the composer's "+" switcher now —
              this picker is models + thinking only. */}
        </div>
      </ComposerPopover>
    </>
  );
}
