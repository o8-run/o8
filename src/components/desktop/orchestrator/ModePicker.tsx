'use client';

/**
 * ModePicker — renders below IntentChips when the composer has text.
 *
 * Two side-by-side mode cards (#888/#892):
 *   - LEFT  — "Fleet orchestration" — Claude orchestrates Codex +
 *             Gemini + opencode in parallel waves. Tagged with the
 *             resolved orchestrator model (operator default).
 *   - MID   — "Solo" — the SAME orchestrator brain, forbidden from
 *             dispatching for the turn (works the repo itself). Never
 *             swaps the composer to a raw CLI session.
 *
 * Selected card has a subtle orange border (one orange accent rule).
 * Default = Fleet on first dispatch, last-used after that. Persisted
 * per-workspace via localStorage `cortex-ide:orchestrator:mode:<key>`.
 *
 * No native form controls. Inline styles + theme tokens. Reduced-motion
 * is honored — no card mount animation when set.
 */

import { memo, useCallback } from 'react';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { useExperimentalChatFlag } from '@/lib/operator/use-experimental-chat';
import { useOrchestratorModel } from '@/lib/operator/use-orchestrator-model';
import { formatModelLabel } from '@/lib/format';
import type { ChatModelId } from './chat-models';

export type { ChatModelId, OrchestrationMode };
export { CHAT_MODEL_OPTIONS } from './chat-models';

interface ModePickerProps {
  visible: boolean;
  workspaceKey: string;
  selectedMode: OrchestrationMode;
  onSelectMode: (mode: OrchestrationMode) => void;
  selectedSingleRuntime: OrchestratorRuntime;
  onSelectSingleRuntime: (runtime: OrchestratorRuntime) => void;
  // When set, picking a runtime spawns a new Single tab instead of
  // flipping the current tab's mode. The card click opens the
  // sub-picker; the runtime button is the spawn trigger.
  onSpawnSingleTab?: (runtime: OrchestratorRuntime) => void;
  // When set, clicking the Chat card spawns a new Chat tab directly.
  // The spawned tab carries its own model picker chip in the composer
  // — there's no longer a sub-picker drawer at the chooser level.
  onSpawnChatTab?: () => void;
}

function ModePickerBase({
  visible,
  selectedMode,
  onSelectMode,
  onSpawnChatTab,
}: ModePickerProps) {
  const chatEnabled = useExperimentalChatFlag();
  const orchestratorModel = useOrchestratorModel();

  const handleClickFleet = useCallback(() => {
    onSelectMode('fleet');
  }, [onSelectMode]);

  // Solo (operator, 2026-07-06): selecting it keeps the SAME orchestrator
  // brain and simply forbids dispatch — it must never swap the composer to a
  // raw single-runtime CLI session (the stuck-on-Codex trap). Dedicated CLI
  // tabs still exist via the new-tab drawer and slash commands (/codex ...).
  const handleClickSingle = useCallback(() => {
    onSelectMode('single');
  }, [onSelectMode]);

  const handleClickChat = useCallback(() => {
    if (onSpawnChatTab) {
      onSpawnChatTab();
    } else {
      onSelectMode('chat');
    }
  }, [onSelectMode, onSpawnChatTab]);

  if (!visible) return null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 8,
        paddingTop: 4,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <ModeCard
        active={selectedMode === 'fleet'}
        title="Fleet orchestration"
        copy="Claude orchestrates Codex + Gemini + opencode in parallel waves."
        tag={`using Claude ${formatModelLabel(orchestratorModel)}`}
        onClick={handleClickFleet}
        glyph={<FleetGlyph />}
      />
      <ModeCard
        active={selectedMode === 'single'}
        title="Solo"
        copy="The orchestrator works the repo itself — no workers dispatched."
        tag={`using Claude ${formatModelLabel(orchestratorModel)}`}
        onClick={handleClickSingle}
        glyph={<SingleGlyph />}
      />
      {chatEnabled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ModeCard
            active={selectedMode === 'chat'}
            title="Chat"
            copy={onSpawnChatTab
              ? 'Spawn a new chat tab — talk to o8, switch models from inside the tab.'
              : 'Talk to o8 about anything. No dispatch.'}
            tag="model picker in tab"
            onClick={handleClickChat}
            glyph={<ChatGlyph />}
          />
        </div>
      ) : null}
    </div>
  );
}

interface ModeCardProps {
  active: boolean;
  title: string;
  copy: string;
  tag: string;
  onClick: () => void;
  glyph: React.ReactNode;
}

function ModeCard({ active, title, copy, tag, onClick, glyph }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 6,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-divider-subtle)',
        background: active ? 'var(--t-accent-soft)' : 'var(--t-bg-card)',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        transition: 'border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), background 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.borderColor = 'var(--t-border)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-muted)' }}>
          {glyph}
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.005em',
          }}
        >
          {title}
        </span>
      </div>
      <span
        style={{
          fontSize: 10.5,
          color: 'var(--t-text-muted)',
          lineHeight: 1.45,
        }}
      >
        {copy}
      </span>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: 'var(--t-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
        }}
      >
        {tag}
      </span>
    </button>
  );
}

function FleetGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v4" />
      <path d="m12 12-6 4" />
      <path d="m12 12 6 4" />
    </svg>
  );
}

function SingleGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

export const ModePicker = memo(ModePickerBase);

export function loadOrchestrationMode(workspaceKey: string): { mode: OrchestrationMode; runtime: OrchestratorRuntime } {
  if (typeof window === 'undefined') return { mode: 'fleet', runtime: 'codex' };
  try {
    const raw = window.localStorage.getItem(`cortex-ide:orchestrator:mode:${workspaceKey}`);
    if (!raw) return { mode: 'fleet', runtime: 'codex' };
    const parsed = JSON.parse(raw) as { mode?: string; runtime?: string };
    const mode: OrchestrationMode = parsed.mode === 'single' || parsed.mode === 'fusion' || parsed.mode === 'chat' ? parsed.mode : 'fleet';
    const runtime: OrchestratorRuntime = parsed.runtime === 'opencode' || parsed.runtime === 'claude-code' || parsed.runtime === 'codex'
      ? parsed.runtime
      : 'codex';
    return { mode, runtime };
  } catch {
    return { mode: 'fleet', runtime: 'codex' };
  }
}

export function persistOrchestrationMode(workspaceKey: string, mode: OrchestrationMode, runtime: OrchestratorRuntime): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`cortex-ide:orchestrator:mode:${workspaceKey}`, JSON.stringify({ mode, runtime }));
  } catch {
    // ignore
  }
}
