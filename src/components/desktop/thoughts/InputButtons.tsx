import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ComposerChipCompactContext } from './composer-compact-context';
import { ComposerPopover } from './chat-panel/ComposerPopover';
import { useRepoTargetMenu } from './useRepoTargetMenu';
import { AttachFilesButton } from './AttachFilesButton';
import { ComposerModeChip } from './ComposerFleetChips';
import type { ComposerMode } from './composer-mode';
import { MicButton } from './MicButton';
import { SessionRulesChip } from './SessionRulesChip';
import { ModelThinkingChip } from './ModelThinkingChip';
import type { OrchestratorBackendSetting } from './operator-defaults';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { THINKING_EFFORT_LABELS, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { ComposerSelectorFooterView } from './composer-selector/ComposerSelectorFooter';
import { SendPill } from './ComposerSendControl';
import type { ComposerSelectorController } from './composer-selector/useComposerSelectorState';

// xhigh stays in the menu but reads as a sibling option to max, NOT as
// "even better than max". max gets the brand orange to anchor it as the
// climax tier; xhigh gets a muted dot so it doesn't outshine max.
const EFFORT_OPTIONS: ThinkingEffort[] = ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_DOT: Record<ThinkingEffort, string> = {
  adaptive: 'var(--t-text-faint)',
  none: 'var(--t-text-faint)',
  minimal: 'var(--t-text-faint)',
  low: 'var(--t-text-faint)',
  medium: 'var(--t-text-muted)',
  high: 'var(--t-text-muted)',
  xhigh: 'var(--t-text-muted)',
  max: '#FF5A1F',
  ultra: '#FF5A1F',
};
/**
 * Thinking effort control — Rams pill matching ThreadsDropdown aesthetic.
 * <details>-based popover that opens UPWARD (bottom: 30) so it never
 * collides with the bottom edge of the composer.
 */
export function ThinkingChip({
  effort = 'adaptive',
  adaptiveEnabled = true,
  onChange,
}: {
  effort?: ThinkingEffort;
  adaptiveEnabled?: boolean;
  onChange?: (next: ThinkingEffort) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const label = THINKING_EFFORT_LABELS[effort].short;
  const dotColor = EFFORT_DOT[effort];
  const options = adaptiveEnabled ? EFFORT_OPTIONS : EFFORT_OPTIONS.filter((option) => option !== 'adaptive');

  const menuItem = (option: ThinkingEffort) => {
    const active = option === effort;
    return (
      <button
        key={option}
        type="button"
        onClick={() => { detailsRef.current?.removeAttribute('open'); onChange?.(option); }}
        style={{
          height: 28, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, borderWidth: 0,
          background: active ? 'var(--t-accent-soft)' : 'transparent',
          color: active ? 'var(--t-accent)' : 'var(--t-text)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          cursor: 'pointer', fontSize: 12, fontWeight: 400,
          fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: 999, background: EFFORT_DOT[option] }}
          />
          <span>{THINKING_EFFORT_LABELS[option].long}</span>
        </span>
        {active ? <span style={{ fontSize: 11, color: 'var(--t-accent)' }}>•</span> : null}
      </button>
    );
  };

  return (
    <details ref={detailsRef} style={{ position: 'relative', flexShrink: 0 }}>
      <summary
        title={`Thinking ${label}`}
        style={{
          listStyle: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 26,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-border)',
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          minWidth: 0,
          fontSize: 11.5,
          fontWeight: 400,
          letterSpacing: '0.01em',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 999, flexShrink: 0, background: dotColor }}
        />
        <span style={{ color: 'var(--t-text-muted)' }}>thinking</span>
        <span style={{ color: 'var(--t-text)' }}>{label}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div
        style={{
          position: 'absolute', bottom: 30, left: 0, width: 156,
          paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4,
          borderRadius: 10, borderWidth: 1, borderStyle: 'solid',
          borderColor: 'var(--t-border)', background: 'var(--t-popover-surface)',
          backdropFilter: 'blur(18px) saturate(1.3)', boxShadow: 'var(--t-panel-shadow)',
          display: 'flex', flexDirection: 'column', gap: 2, zIndex: 20,
        }}
      >
        {options.map((option) => menuItem(option))}
      </div>
    </details>
  );
}

/**
 * InputToolbar — sits below the textarea inside the composer container.
 *
 *   [▊▊▊ effort] [model label] [✦ enhance]         [+ attach] [↑ send]
 */
export type { ThinkingEffort };

function repoPathLabel(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  return path.split('/').filter(Boolean).pop() ?? path;
}

function repoGroupLabel(target: OrchestratorWorkspaceTarget): string {
  return target.repoName?.trim() || repoPathLabel(target.localPath) || target.label;
}

function repoTargetRowLabel(target: OrchestratorWorkspaceTarget, groupLabel: string): string {
  if (!target.isWorktree) return 'Base repo';
  if (target.branch?.trim()) return target.branch;

  const pathLabel = repoPathLabel(target.localPath);
  if (pathLabel && pathLabel !== groupLabel) return pathLabel;

  const prefix = `${groupLabel} · `;
  return target.label.startsWith(prefix) ? target.label.slice(prefix.length) : target.label;
}

function compactRepoPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

const REPO_TARGET_MENU_WIDTH = 320;
const REPO_TARGET_MENU_HEIGHT = 280;

export function RepoTargetChip({
  repoLabel,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  onAddProject,
}: {
  repoLabel?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
  onAddProject?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { menuRef, focusMenu, closeMenu, onTriggerKeyDown, onMenuKeyDown } = useRepoTargetMenu(setOpen, buttonRef);
  const targets = useMemo(() => workspaceTargets ?? [], [workspaceTargets]);
  const targetGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      label: string;
      targets: Array<{ target: OrchestratorWorkspaceTarget; index: number }>;
    }>();

    targets.forEach((target, index) => {
      const label = repoGroupLabel(target);
      const key = label.toLowerCase();
      const group = groups.get(key) ?? {
        key,
        label,
        targets: [],
      };
      group.targets.push({ target, index });
      groups.set(key, group);
    });

    return Array.from(groups.values()).map((group) => ({
      key: group.key,
      label: group.label,
      targets: group.targets
        .sort((a, b) => {
          const aRank = a.target.isWorktree ? 1 : 0;
          const bRank = b.target.isWorktree ? 1 : 0;
          return aRank === bRank ? a.index - b.index : aRank - bRank;
        })
        .map(({ target }) => target),
    }));
  }, [targets]);
  const selectedTarget = useMemo(
    () => targets.find((target) => target.localPath === selectedRepoPath) ?? null,
    [selectedRepoPath, targets],
  );
  const label = selectedRepoPath === '~' ? 'Project' : selectedTarget?.label
    ?? repoLabel
    ?? repoPathLabel(selectedRepoPath)
    ?? 'Project';
  const targetName = selectedTarget?.repoName?.trim()
    || repoLabel?.trim()
    || (selectedRepoPath && selectedRepoPath !== '~' ? repoPathLabel(selectedRepoPath) : null);
  const accessibleLabel = targetName ? `Project target: ${targetName}` : 'Project target';
  const canSelect = (targets.length > 0 && Boolean(onSelectRepoPath)) || Boolean(onAddProject);
  const showingAffordance = canSelect && (hovered || focused || open);

  if (!label) return null;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (canSelect) setOpen((value) => !value); }}
        onKeyDown={onTriggerKeyDown}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={!canSelect}
        title={accessibleLabel}
        aria-label={accessibleLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          maxWidth: 180,
          height: 22,
          paddingTop: 0,
          paddingRight: canSelect ? 6 : 0,
          paddingBottom: 0,
          paddingLeft: canSelect ? 6 : 0,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: showingAffordance ? 'rgba(37, 99, 235, 0.16)' : 'transparent',
          borderRadius: 7,
          background: showingAffordance ? 'rgba(37, 99, 235, 0.055)' : 'transparent',
          color: showingAffordance ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
          cursor: canSelect ? 'pointer' : 'default',
          outline: focused && canSelect ? '2px solid rgba(37, 99, 235, 0.14)' : 'none',
          outlineOffset: 1,
          fontSize: 10.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-sans-system)',
          transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms cubic-bezier(0.22, 1, 0.36, 1), color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {canSelect ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: showingAffordance ? 0.92 : 0.58, transition: 'opacity 180ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        ) : null}
      </button>

      <ComposerPopover anchorRef={buttonRef} open={open} onClose={closeMenu} onOpenReady={focusMenu} align="start">
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Project target"
          onKeyDown={onMenuKeyDown}
          style={{
            width: REPO_TARGET_MENU_WIDTH,
            maxHeight: REPO_TARGET_MENU_HEIGHT,
            overflowY: 'auto',
            scrollbarWidth: 'none',
            paddingTop: 5,
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
            gap: 2,
          }}
        >
          {targetGroups.map((group) => {
            const groupActive = group.targets.some((target) => target.localPath === selectedRepoPath);
            return (
              <div
                key={group.key}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 3,
                  paddingBottom: 3,
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    alignItems: 'center',
                    columnGap: 8,
                    paddingTop: 4,
                    paddingRight: 8,
                    paddingBottom: 3,
                    paddingLeft: 8,
                    color: groupActive ? 'var(--t-accent)' : 'var(--t-text-muted)',
                    fontFamily: 'var(--font-sans-system)',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px' }}>
                    {group.label}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 300, color: 'var(--t-text-faint)', letterSpacing: '-0.1px' }}>
                    {group.targets.length === 1 ? '1 target' : `${group.targets.length} targets`}
                  </span>
                </div>
                {group.targets.map((target, index) => {
                  const active = target.localPath === selectedRepoPath;
                  const targetLabel = repoTargetRowLabel(target, group.label);
                  return (
                    <button
                      key={`${target.id}:${target.localPath}:${target.branch ?? 'default'}:${index}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onSelectRepoPath?.(target.localPath);
                        closeMenu();
                      }}
                      style={{
                        width: '100%',
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) auto',
                        columnGap: 10,
                        rowGap: 2,
                        alignItems: 'center',
                        paddingTop: 6,
                        paddingRight: 9,
                        paddingBottom: 6,
                        paddingLeft: 12,
                        borderWidth: 0,
                        borderRadius: 9,
                        background: active ? 'var(--t-accent-soft)' : 'rgba(255, 255, 255, 0.02)',
                        color: active ? 'var(--t-accent)' : 'var(--t-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans-system)',
                      }}
                    >
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {targetLabel}
                        </span>
                        <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
                          {compactRepoPath(target.localPath)}
                        </span>
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace" }}>
                          {target.isWorktree ? 'worktree' : 'base'}
                        </span>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: active ? 'var(--t-accent)' : 'transparent',
                            boxShadow: active ? '0 0 0 3px var(--t-accent-soft)' : 'none',
                          }}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {onAddProject ? (
            <button type="button" role="option" aria-selected={false} onClick={() => { buttonRef.current?.focus(); onAddProject(); setOpen(false); }} style={{ width: '100%', paddingTop: 8, paddingRight: 9, paddingBottom: 8, paddingLeft: 12, borderWidth: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-secondary)', cursor: 'pointer', textAlign: 'left', fontSize: 11.5, fontFamily: 'var(--font-sans-system)' }}>
              Add repository…
            </button>
          ) : null}
        </div>
      </ComposerPopover>
    </div>
  );
}

export function InputButtons({
  input,
  hasAttachments = false,
  onSubmit,
  sendDisabled = false,
  modelLabel,
  modelId,
  onModelChange,
  activeBackend,
  onBackendChange,
  effort = 'adaptive',
  onEffortChange,
  adaptiveEnabled = true,
  sessionRulesThreadId,
  repoLabel,
  displayMessagesCount = 0,
  working = false,
  onStop,
  onUploadDiskFiles,
  onFileReferenceSelect,
  composerMode,
  onComposerModeChange,
  composerSelectorController,
  repoPath,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  inlineLeadingExtras,
  permissionControl,
  managedVoiceControl,
  inlineMeterSlot,
  onBrowsePrompts,
  onSavePrompt,
  onRequestTextareaFocus,
  composerSelectorV1Enabled = false,
}: {
  input: string;
  hasAttachments?: boolean;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSendAsTask?: () => void;
  onSubmit: () => void;
  sendDisabled?: boolean;
  small?: boolean;
  modelLabel?: string;
  /** Raw orchestrator model id — drives the active row in the chip's model section. */
  modelId?: string;
  /** When set, the chip menu grows a Model section (Fable/Opus/Sonnet). */
  onModelChange?: (model: string) => void;
  activeBackend?: OrchestratorBackendSetting;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  effort?: ThinkingEffort;
  onEffortChange?: (effort: ThinkingEffort) => void;
  adaptiveEnabled?: boolean;
  /**
   * Session rules (#1329). `undefined` = surface doesn't carry session rules
   * (CLI lanes) → chip hidden. `null` = orchestrator surface, thread not yet
   * minted → chip shows read-only tiers. String = active thread, fully editable.
   */
  sessionRulesThreadId?: string | null;
  repoLabel?: string | null;
  /**
   * Transcript size in the parent panel. When > 0 the chat is no longer
   * in its empty state, so the in-composer repo chip is hidden (the repo
   * is locked in for the conversation — Codex behavior).
   */
  displayMessagesCount?: number;
  working?: boolean;
  onStop?: () => void;
  onUploadDiskFiles?: (files: FileList | File[]) => void;
  onFileReferenceSelect?: (path: string) => void;
  composerMode?: ComposerMode;
  onComposerModeChange?: (mode: ComposerMode) => void;
  composerSelectorController?: ComposerSelectorController;
  repoPath?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
  inlineLeadingExtras?: ReactNode;
  permissionControl?: ReactNode;
  managedVoiceControl?: ReactNode;
  inlineMeterSlot?: ReactNode;
  voiceModeEnabled?: boolean;
  onVoiceModeChange?: (enabled: boolean) => void;
  onBrowsePrompts?: () => void;
  onSavePrompt?: (body: string) => void;
  onRequestTextareaFocus?: () => void;
  composerSelectorV1Enabled?: boolean;
}) {
  const canSubmit = Boolean(input.trim() || hasAttachments);
  const showRepoChip = Boolean(repoLabel) && displayMessagesCount === 0;
  const selectorReady = Boolean(
    composerSelectorController && composerMode && (modelLabel || activeBackend === 'acp') && (modelId || activeBackend === 'acp') && activeBackend && onEffortChange,
  );
  const selectorControls = composerSelectorController;

  // Adaptive composer row: measure available width and, below the threshold,
  // collapse the in-input pickers (model + agent) to icon-only — matching the
  // below-composer chip row's COMPACT_CHIP_ROW_WIDTH (440) so both collapse in
  // lockstep. Measured, not a media query, so it tracks the real panel size.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setCompact(w < 440);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (
    composerSelectorV1Enabled
    && selectorControls
    && selectorReady
  ) {
    return (
      <ComposerChipCompactContext.Provider value={compact}>
        <ComposerSelectorFooterView
          input={input}
          state={selectorControls.state}
          defaults={selectorControls.defaults}
          composerModelGroups={selectorControls.composerModelGroups}
          onModeChange={selectorControls.onModeChange}
          onModelChange={selectorControls.onModelChange}
          onBackendChange={selectorControls.onBackendChange}
          onEffortChange={selectorControls.onEffortChange}
          onRuntimeChange={selectorControls.onRuntimeChange}
          onWorkerModelChange={selectorControls.onWorkerModelChange}
          onWorkerEffortChange={selectorControls.onWorkerEffortChange}
          workerLocks={selectorControls.workerLocks}
          onWorkerStartModeChange={selectorControls.onWorkerStartModeChange}
          saving={selectorControls.savingWorkerDefaults}
          permissionControl={permissionControl}
          leadingControls={(
            <>
              {inlineLeadingExtras ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
                  {inlineLeadingExtras}
                </span>
              ) : null}
              {showRepoChip ? (
                <>
                  {compact || !inlineLeadingExtras ? null : <span style={{ color: 'var(--t-text-faint)' }}>·</span>}
                  <RepoTargetChip
                    repoLabel={repoLabel}
                    workspaceTargets={workspaceTargets}
                    selectedRepoPath={selectedRepoPath}
                    onSelectRepoPath={onSelectRepoPath}
                  />
                </>
              ) : null}
              {sessionRulesThreadId !== undefined ? (
                <span data-testid="composer-selector-session-rules" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                  <SessionRulesChip threadId={sessionRulesThreadId} repoPath={repoPath} />
                </span>
              ) : null}
            </>
          )}
          attachControl={(
            <AttachFilesButton
              onUploadDiskFiles={onUploadDiskFiles}
              onFileReferenceSelect={onFileReferenceSelect}
              repoPath={repoPath}
              promptBody={input}
              onBrowsePrompts={onBrowsePrompts}
              onSavePrompt={onSavePrompt}
            />
          )}
          meterControl={inlineMeterSlot}
          micControl={<MicButton />}
          voiceControl={managedVoiceControl}
          sendControl={(
            <SendPill
              canSubmit={canSubmit && !sendDisabled}
              working={working}
              onSubmit={onSubmit}
              onStop={onStop}
            />
          )}
          containerRef={rowRef}
          onRequestTextareaFocus={onRequestTextareaFocus}
        />
      </ComposerChipCompactContext.Provider>
    );
  }

  return (
    <ComposerChipCompactContext.Provider value={compact}>
    <div ref={rowRef} style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      paddingTop: 4,
      paddingRight: 8,
      paddingBottom: 8,
      paddingLeft: 10,
    }}>
      {/* Left controls — the flexible group. As the composer narrows this
          shrinks and (below the threshold) collapses its pickers to icon-only.
          The right action cluster stays pinned, so Send/mic/attach are never
          pushed off the clipped right edge — the bug this fixes. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
      {permissionControl}
      {inlineLeadingExtras ? (
        // overflow:hidden is load-bearing — without it a nowrap child that
        // can't shrink spills out of this minWidth:0 span and paints under
        // the row siblings that follow.
        <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
          {inlineLeadingExtras}
        </span>
      ) : null}

      {/* Repo / workspace target — only on the empty state. Once a chat
          has messages, the repo is locked in for the conversation
          (Codex behavior) and the chip becomes redundant noise. */}
      {showRepoChip ? (
        <>
          {compact || !inlineLeadingExtras ? null : <span style={{ color: 'var(--t-text-faint)' }}>·</span>}
          <RepoTargetChip
            repoLabel={repoLabel}
            workspaceTargets={workspaceTargets}
            selectedRepoPath={selectedRepoPath}
            onSelectRepoPath={onSelectRepoPath}
          />
        </>
      ) : null}

      {/* Clarify-first toggle removed 2026-07-11 (Q ruling): the interview
          now auto-arms silently — standing doctrine covers materially
          ambiguous requests, and the system prompt arms it for a repo's
          first-ever mission. No transcript-visible directive, no chrome. */}

      {/* Session rules (#1329) — "Rules · N" chip. Lists the merged
          Session/Repo/Global rule set; session tier is editable inline.
          Only on orchestrator surfaces (undefined = hidden). */}
      {sessionRulesThreadId !== undefined ? (
        <SessionRulesChip threadId={sessionRulesThreadId} repoPath={repoPath} />
      ) : null}

      {/* Left cluster = intent: attach/+ and mic (Q ruling 2026-08-05 —
          supersedes 07-17: the mode chip moved to the RIGHT cluster so the
          right side reads mode → fleet worker → orchestrator model). */}
      <AttachFilesButton
        onUploadDiskFiles={onUploadDiskFiles}
        onFileReferenceSelect={onFileReferenceSelect}
        repoPath={repoPath}
        promptBody={input}
        onBrowsePrompts={onBrowsePrompts}
        onSavePrompt={onSavePrompt}
      />
      <MicButton />
      {managedVoiceControl}

      </div>

      {/* Right cluster — runtime: mode · context meter · model · thinking ·
          fleet worker · send (Q re-ruling 2026-08-05: reads left→right, so the
          orchestrator model comes BEFORE the fleet worker it dispatches — the
          old order looked like the fleet model was driving the orchestrator).
          The mode chip owns its own switcher; the fleet chip appears only when
          the mode dispatches, one visual step smaller than the model chip.
          Pinned, never shrinks or clips. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {composerMode && onComposerModeChange ? (
        <ComposerModeChip
          mode={selectorControls?.state.mode ?? composerMode}
          onModeChange={selectorControls?.onModeChange ?? onComposerModeChange}
        />
      ) : null}
      {inlineMeterSlot ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {inlineMeterSlot}
        </span>
      ) : null}
      {modelLabel ? (
        <ModelThinkingChip
          split
          compact={compact}
          modelLabel={selectorControls?.state.leadModelLabel ?? modelLabel}
          modelId={selectorControls?.state.leadModelId ?? modelId}
          onModelChange={selectorControls?.onModelChange ?? onModelChange}
          activeBackend={selectorControls?.state.leadBackend ?? activeBackend}
          onBackendChange={selectorControls?.onBackendChange ?? onBackendChange}
          effort={selectorControls?.state.effort ?? effort}
          adaptiveEnabled={adaptiveEnabled}
          onEffortChange={selectorControls?.onEffortChange ?? onEffortChange}
          composerMode={selectorControls?.state.mode ?? composerMode}
        />
      ) : null}


      {/* Send — ↵ enter key when idle, square stop while working
          (Claude Code reference, Q ruling 2026-07-11). */}
      <SendPill
        canSubmit={canSubmit && !sendDisabled}
        working={working}
        onSubmit={onSubmit}
        onStop={onStop}
      />
      </div>
    </div>
    </ComposerChipCompactContext.Provider>
  );
}
