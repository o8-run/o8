'use client';

/**
 * DiffCard — Cursor Composer 2 style streaming diff preview (#525).
 *
 * Renders inside chat messages whenever an assistant message contains a
 * ```diff fenced code block. Streams hunks as they arrive, supports
 * per-hunk partial apply, and wires Apply → existing `/api/lanes/apply-diff`
 * endpoint via the `onApplyDiff` callback.
 *
 * Keyboard:
 *   Cmd/Ctrl+Enter       → Apply all selected hunks
 *   Cmd/Ctrl+Shift+Enter → Toggle hunk picker
 *   Esc                  → Close hunk picker
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, FileCode, X } from './lucide-shims';
import { DiffCardFile } from './DiffCardRows';
import {
  countDiffLines,
  hunkKey,
  parseDiff,
  serializeSelectedHunks,
  type ParsedDiffFile,
} from '@/lib/llm/diff-parse';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

export interface DiffCardProps {
  /** Raw diff body (contents between ```diff fences). */
  code: string;
  /** Callback fired when the user clicks Apply. Receives the (optionally filtered) diff. */
  onApplyDiff?: (diffText: string) => void;
  /**
   * Streaming signal — when true, the parser treats the final hunk as potentially
   * incomplete, fades new hunks in, and renders a live pulse in the header.
   */
  isStreaming?: boolean;
  /**
   * Optional interrupt hook. When provided + streaming, a stop button appears
   * in the header. Fire this to call through to the upstream stream-cancel
   * path (e.g. `useOrchestratorStream.interrupt()`).
   */
  onInterrupt?: () => void;
}

const BUTTON_BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  minHeight: 28,
  paddingTop: 0,
  paddingRight: 10,
  paddingBottom: 0,
  paddingLeft: 10,
  borderWidth: 0,
  borderRadius: 8,
  background: 'transparent',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--font-sans-system)',
  transition: 'color 150ms, background 150ms, opacity 150ms',
};

export const DiffCard = memo(function DiffCard({ code, onApplyDiff, isStreaming, onInterrupt }: DiffCardProps) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Selection map — keys are `${filePath}::${hunkIndex}`. Missing key = selected
  // (default-on). Explicit `false` = deselected. Explicit `true` = selected.
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  // Track hunks that are newly appeared on the current render for fade-in.
  const seenHunkKeysRef = useRef<Set<string>>(new Set());
  const [newHunkKeys, setNewHunkKeys] = useState<Set<string>>(new Set());

  const files = useMemo(() => parseDiff(code), [code]);
  const { added, removed } = useMemo(() => countDiffLines(files), [files]);

  // Detect newly arrived hunks for fade-in.
  useEffect(() => {
    const currentKeys = new Set<string>();
    for (const file of files) {
      for (let i = 0; i < file.hunks.length; i += 1) {
        currentKeys.add(hunkKey(file, i));
      }
    }
    const fresh = new Set<string>();
    currentKeys.forEach((key) => {
      if (!seenHunkKeysRef.current.has(key)) fresh.add(key);
    });
    seenHunkKeysRef.current = currentKeys;
    if (fresh.size > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- marks hunks that arrived in this commit so they fade in once
      setNewHunkKeys(fresh);
      // Clear the fade-in marker after the animation completes so future
      // re-renders don't replay the animation.
      const timer = window.setTimeout(() => setNewHunkKeys(new Set()), 300);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [files]);

  const selectedDiffText = useMemo(() => {
    const hasExplicitSelection = Object.values(selection).some((v) => v === false);
    if (!hasExplicitSelection) return code; // all hunks on — apply the raw text
    return serializeSelectedHunks(files, selection);
  }, [code, files, selection]);

  const selectedHunkCount = useMemo(() => {
    let count = 0;
    for (const file of files) {
      for (let i = 0; i < file.hunks.length; i += 1) {
        if (selection[hunkKey(file, i)] !== false) count += 1;
      }
    }
    return count;
  }, [files, selection]);

  const totalHunkCount = useMemo(() => {
    return files.reduce((acc, file) => acc + file.hunks.length, 0);
  }, [files]);

  const canApply = !!onApplyDiff && !isStreaming && selectedHunkCount > 0;

  const handleCopy = useCallback(() => {
    const writeText = navigator.clipboard?.writeText;
    if (typeof writeText !== 'function') {
      return;
    }
    void writeText.call(navigator.clipboard, code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      /* write rejected — keep Copy label for retry */
    });
  }, [code]);

  const handleApply = useCallback(() => {
    if (!onApplyDiff || isStreaming) return;
    const diff = selectedDiffText.trim();
    if (!diff) return;
    onApplyDiff(diff);
    setApplied(true);
    window.setTimeout(() => setApplied(false), 2000);
  }, [isStreaming, onApplyDiff, selectedDiffText]);

  const handleTogglePicker = useCallback(() => {
    setPickerOpen((open) => !open);
  }, []);

  const handleToggleHunk = useCallback((key: string) => {
    setSelection((prev) => {
      const isSelected = prev[key] !== false;
      return { ...prev, [key]: !isSelected };
    });
  }, []);

  const handleToggleFile = useCallback((file: ParsedDiffFile) => {
    setSelection((prev) => {
      const next = { ...prev };
      const allOn = file.hunks.every((_, i) => next[hunkKey(file, i)] !== false);
      for (let i = 0; i < file.hunks.length; i += 1) {
        next[hunkKey(file, i)] = !allOn;
      }
      return next;
    });
  }, []);

  // Keyboard shortcuts — scoped to the card via a ref + key handler.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      // Only fire if the card contains the focused element.
      const activeElement = document.activeElement;
      if (!(activeElement instanceof Node) || !card.contains(activeElement)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          setPickerOpen((open) => !open);
        } else if (canApply) {
          handleApply();
        }
      } else if (event.key === 'Escape' && pickerOpen) {
        event.preventDefault();
        setPickerOpen(false);
      }
    };
    card.addEventListener('keydown', handler);
    return () => card.removeEventListener('keydown', handler);
  }, [canApply, handleApply, pickerOpen]);

  const applyLabel = applied
    ? 'Applied'
    : pickerOpen && selectedHunkCount < totalHunkCount
    ? `Apply ${selectedHunkCount}`
    : 'Apply';

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-diff-card="true"
      style={{
        marginTop: 8,
        marginBottom: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-panel-border)',
        background: THEME_PANEL_GLASS,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 6,
          paddingLeft: 12,
          background: THEME_BG_CARD,
          borderBottom: '1px solid var(--t-divider)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text-secondary)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            diff
          </span>
          {isStreaming ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 10,
                color: THEME_ACCENT,
                fontWeight: 600,
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: THEME_ACCENT,
                  animation: 'llmDot 1s ease-in-out infinite',
                }}
              />
              streaming
            </span>
          ) : null}
          {files.length > 0 ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10,
                color: 'var(--t-text-muted)',
                fontFamily: 'var(--font-sans-system)',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ color: '#16a34a', fontWeight: 700 }}>+{added}</span>
              <span style={{ color: '#dc2626', fontWeight: 700 }}>-{removed}</span>
              <span>· {totalHunkCount} hunk{totalHunkCount === 1 ? '' : 's'}</span>
            </span>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {isStreaming && onInterrupt ? (
            <button
              type="button"
              onClick={onInterrupt}
              title="Stop streaming"
              aria-label="Stop streaming"
              style={{
                ...BUTTON_BASE,
                color: '#dc2626',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
              }}
            >
              <X size={12} />
              Stop
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleCopy}
            style={{
              ...BUTTON_BASE,
              color: copied ? '#10b981' : 'var(--t-text-muted)',
            }}
            onMouseEnter={(event) => {
              if (copied) return;
              event.currentTarget.style.background = THEME_BG_CARD;
              event.currentTarget.style.color = 'var(--t-text-secondary)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
              if (!copied) event.currentTarget.style.color = 'var(--t-text-muted)';
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {totalHunkCount > 1 ? (
            <button
              type="button"
              onClick={handleTogglePicker}
              title="Cmd+Shift+Enter"
              style={{
                ...BUTTON_BASE,
                color: pickerOpen ? THEME_ACCENT : 'var(--t-text-muted)',
                background: pickerOpen ? THEME_ACCENT_SOFT : 'transparent',
              }}
              onMouseEnter={(event) => {
                if (pickerOpen) return;
                event.currentTarget.style.background = THEME_BG_CARD;
                event.currentTarget.style.color = 'var(--t-text-secondary)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = pickerOpen ? THEME_ACCENT_SOFT : 'transparent';
                event.currentTarget.style.color = pickerOpen ? THEME_ACCENT : 'var(--t-text-muted)';
              }}
            >
              {pickerOpen ? `${selectedHunkCount}/${totalHunkCount}` : 'Pick'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            title={canApply ? 'Cmd+Enter' : undefined}
            style={{
              ...BUTTON_BASE,
              paddingRight: 12,
              paddingLeft: 12,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-accent-border, rgba(37, 99, 235, 0.22))',
              background: applied ? THEME_ACCENT_SOFT : canApply ? THEME_ACCENT : THEME_BG_CARD,
              color: applied ? '#10b981' : canApply ? '#ffffff' : 'var(--t-text-muted)',
              fontWeight: 700,
              cursor: canApply ? 'pointer' : 'not-allowed',
              opacity: canApply ? 1 : 0.6,
            }}
            onMouseEnter={(event) => {
              if (!canApply || applied) return;
              event.currentTarget.style.background = 'var(--t-accent-strong, #1d4ed8)';
            }}
            onMouseLeave={(event) => {
              if (!canApply || applied) return;
              event.currentTarget.style.background = THEME_ACCENT;
            }}
          >
            {applied ? <Check size={12} /> : <FileCode size={12} />}
            {applyLabel}
          </button>
        </div>
      </div>

      {files.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {files.map((file, fileIndex) => (
            <DiffCardFile
              key={`${file.filePath || file.oldPath || 'file'}-${fileIndex}`}
              file={file}
              fileIndex={fileIndex}
              selection={selection}
              onToggleHunk={handleToggleHunk}
              onToggleFile={handleToggleFile}
              pickerOpen={pickerOpen}
              newHunkKeys={newHunkKeys}
            />
          ))}
        </div>
      ) : (
        <pre
          style={{
            marginTop: 0,
            marginRight: 0,
            marginBottom: 0,
            marginLeft: 0,
            paddingTop: 12,
            paddingRight: 16,
            paddingBottom: 12,
            paddingLeft: 16,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", monospace',
            overflowX: 'auto',
            color: 'var(--t-text-secondary)',
            tabSize: 2,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {code || '\u00A0'}
          {isStreaming ? (
            <span
              style={{
                display: 'inline-block',
                width: 2,
                height: 14,
                background: THEME_ACCENT,
                marginLeft: 1,
                verticalAlign: 'text-bottom',
                animation: 'llmDot 1s ease-in-out infinite',
              }}
            />
          ) : null}
        </pre>
      )}
    </div>
  );
});
