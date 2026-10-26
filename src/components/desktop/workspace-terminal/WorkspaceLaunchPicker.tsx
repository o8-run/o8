'use client';

import { memo, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import {
  MessageSquare,
  Terminal as TerminalIcon,
} from '../lucide-shims';
import { THEME_ACCENT, THEME_ACCENT_SOFT } from '@/components/desktop/workspace-terminal/constants';
import { PhosphorPlay } from '@/components/desktop/workspace-terminal/icons';
import { useWorkspaceSpawn } from '@/components/desktop/workspace-terminal/spawn-context';
import { useExperimentalChatFlag } from '@/lib/operator/use-experimental-chat';
import type { RegisteredRepo } from '@/components/desktop/workspace-terminal/types';

interface WorkspaceLaunchPickerProps {
  launchRequestKey?: number;
  scopedRepo?: RegisteredRepo | null;
  onNewTab: (agentId: string, repo?: RegisteredRepo) => void;
  onNewLLMChatTab: (repo?: RegisteredRepo) => void;
  onNewChatGPTPlanTab?: () => void;
}

const subscribePlatform = () => () => undefined;

function browserSupportsMagnitude() {
  return !navigator.userAgent.toLowerCase().includes('windows');
}

function WorkspaceLaunchPickerBase({
  launchRequestKey,
  scopedRepo,
  onNewTab,
  onNewLLMChatTab,
  onNewChatGPTPlanTab,
}: WorkspaceLaunchPickerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const magnitudeSupported = useSyncExternalStore(subscribePlatform, browserSupportsMagnitude, () => false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const spawnHandlers = useWorkspaceSpawn();
  // Alpha: the casual "Chat" (llm-chat) option is hidden unless experimentalChat.
  const experimentalChat = useExperimentalChatFlag();

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const handler = (event: globalThis.MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  useEffect(() => {
    if (!launchRequestKey) return undefined;
    const frame = requestAnimationFrame(() => setPickerOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [launchRequestKey]);

  const handleNewOrchestrator = () => {
    spawnHandlers?.spawnOrchestratorTab();
    setPickerOpen(false);
  };

  const handleNewChat = () => {
    onNewLLMChatTab(scopedRepo ?? undefined);
    setPickerOpen(false);
  };

  const handleNewTerminal = () => {
    onNewTab('shell', scopedRepo ?? undefined);
    setPickerOpen(false);
  };

  const handleNewMagnitude = () => {
    onNewTab('magnitude', scopedRepo ?? undefined);
    setPickerOpen(false);
  };

  return (
    <div ref={pickerRef} style={{ position: 'relative', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setPickerOpen((prev) => !prev)}
        aria-label="New tab"
        title="New tab"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: 'center',
          width: 24,
          height: 24,
          marginLeft: 4,
          marginRight: 2,
          borderRadius: 6,
          borderWidth: 0,
          background: pickerOpen ? THEME_ACCENT_SOFT : 'transparent',
          color: THEME_ACCENT,
          cursor: 'pointer',
          flexShrink: 0,
          boxShadow: 'none',
          transition: 'background 100ms, color 100ms',
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = THEME_ACCENT_SOFT;
        }}
        onMouseLeave={(event) => {
          if (!pickerOpen) {
            event.currentTarget.style.background = 'transparent';
          }
        }}
      >
        <PhosphorPlay size={13} />
      </button>

      {pickerOpen ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 9000,
            marginTop: 4,
            minWidth: 240,
            background: 'var(--t-popover-surface)',
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
            border: '1px solid var(--t-panel-border)',
            borderRadius: 10,
            overflow: 'hidden',
            boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.12)',
          } as CSSProperties}
        >
          <button
            type="button"
            onClick={handleNewOrchestrator}
            disabled={!spawnHandlers}
            style={menuButtonStyle}
            onMouseEnter={highlightOn}
            onMouseLeave={resetOn}
          >
            <span style={iconSlotStyle}>
              <OrchestratorGlyph color={THEME_ACCENT} />
            </span>
            <div>
              <div style={{ fontWeight: 500 }}>Orchestrator</div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Fleet by default · switch mode in-tab</div>
            </div>
          </button>

          <div style={dividerStyle} />
          <button type="button" onClick={() => { (onNewChatGPTPlanTab ?? spawnHandlers?.spawnChatGPTPlanTab)?.(); setPickerOpen(false); }}
            disabled={!onNewChatGPTPlanTab && !spawnHandlers?.spawnChatGPTPlanTab}
            style={menuButtonStyle} onMouseEnter={highlightOn} onMouseLeave={resetOn}>
            <span style={iconSlotStyle}><MessageSquare size={14} style={{ color: THEME_ACCENT }} /></span>
            <div>
              <div style={{ fontWeight: 300 }}>ChatGPT plan chat</div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Text with your connected plan</div>
            </div>
          </button>

          {experimentalChat ? (
            <>
              <div style={dividerStyle} />
              <button
                type="button"
                onClick={handleNewChat}
                style={menuButtonStyle}
                onMouseEnter={highlightOn}
                onMouseLeave={resetOn}
              >
                <span style={iconSlotStyle}>
                  <MessageSquare size={14} style={{ color: THEME_ACCENT }} />
                </span>
                <div>
                  <div style={{ fontWeight: 500 }}>Chat</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Direct LLM conversation</div>
                </div>
              </button>
            </>
          ) : null}

          <div style={dividerStyle} />

          <button
            type="button"
            onClick={handleNewTerminal}
            style={menuButtonStyle}
            onMouseEnter={highlightOn}
            onMouseLeave={resetOn}
          >
            <span style={iconSlotStyle}>
              <TerminalIcon size={14} style={{ color: 'var(--t-text-secondary)' }} />
            </span>
            <div>
              <div style={{ fontWeight: 500 }}>Terminal</div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Plain shell · no chat</div>
            </div>
          </button>

          {magnitudeSupported ? (
            <button
              type="button"
              onClick={handleNewMagnitude}
              style={menuButtonStyle}
              onMouseEnter={highlightOn}
              onMouseLeave={resetOn}
            >
              <span style={iconSlotStyle}>
                <LocalAgentGlyph color="#0f9f8f" />
              </span>
              <div>
                <div style={{ fontWeight: 500 }}>Magnitude</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Local agent · visible repository terminal</div>
              </div>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LocalAgentGlyph({ color }: { color: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <path d="M8 10h8M8 14h5" />
    </svg>
  );
}

function OrchestratorGlyph({ color }: { color: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v4" />
      <path d="m12 12-6 4" />
      <path d="m12 12 6 4" />
    </svg>
  );
}

export const WorkspaceLaunchPicker = memo(WorkspaceLaunchPickerBase);

const menuButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  paddingTop: 10,
  paddingBottom: 10,
  paddingLeft: 12,
  paddingRight: 12,
  border: 'none',
  background: 'transparent',
  color: 'var(--t-text)',
  fontSize: 13,
  fontFamily: 'var(--font-sans-system)',
  cursor: 'pointer',
  textAlign: 'left' as const,
  transition: 'background 100ms',
};

const dividerStyle = { height: 1, background: 'var(--t-divider)' } as const;

const iconSlotStyle = {
  width: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function highlightOn(event: ReactMouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = THEME_ACCENT_SOFT;
}

function resetOn(event: ReactMouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
}
