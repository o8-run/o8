'use client';

/**
 * ThoughtBlock — the reasoning surface of a turn (turn-grammar, Cursor parity).
 *
 * Renders as a SLIM TEXT LINE, never a box (operator ruling 2026-07-13 —
 * Cursor's transcript vocabulary is slim grey lines with dropdowns):
 *   • Live (`live`): a shimmering "Thinking" label; when reasoning text is
 *     streaming it shows a one-line peek beside the label.
 *   • Done with reasoning text: "Thought for Ns ⌄" — click expands the faint
 *     reasoning body inline. The thinking STAYS in the transcript forever,
 *     collapsed by default.
 *   • Done with duration only (no text): "Thought for Ns" as a plain line —
 *     no chevron, nothing to expand.
 *
 * DATA REALITY (verified against raw stream-json, 2026-07-13): Claude 5-family
 * thinking streams SIGNATURE-ONLY — the content is redacted at the API, so for
 * claude-backend turns only the duration exists (`durationMs`, measured from
 * the thinking block-start marker). Backends that ship real reasoning text
 * (Codex reasoning summaries, etc.) populate `thinking` and get the full
 * expandable dropdown. No placeholder content, ever.
 *
 * Pure inline styles + theme tokens; the shimmer keyframe lives in globals.css.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

interface ThoughtBlockProps {
  thinking: string;
  /** True while the model is still reasoning (no answer text / no tool yet). */
  live?: boolean;
  /** Frozen reasoning duration from the stream (start marker → first answer
   *  token or tool call). Takes precedence over the client-measured span. */
  durationMs?: number | null;
  style?: CSSProperties;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatThoughtDuration(ms: number | null): string {
  if (ms === null) return 'Thought process';
  if (ms < 1500) return 'Thought briefly';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `Thought for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `Thought for ${minutes}m` : `Thought for ${minutes}m ${rest}s`;
}

export function ThoughtBlock({ thinking, live = false, durationMs = null, style }: ThoughtBlockProps) {
  const summary = collapse(thinking);

  // Reduced-motion: read once at mount as an initializer (mirrors ToolCallChip)
  // to avoid the react-hooks/set-state-in-effect rule.
  const [reducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  });

  // Reasoning stays collapsed until explicitly opened, including while live.
  const [expanded, setExpanded] = useState(false);

  // Client-measured fallback duration for backends that stream reasoning text
  // without a stream-derived duration. The start stamps on the first live pass,
  // and the elapsed freezes ONCE on the transition to not-live.
  const startedAtRef = useRef<number | null>(null);
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  useEffect(() => {
    if (live) {
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
      return;
    }
    if (startedAtRef.current !== null && measuredMs === null) {
      setMeasuredMs(Date.now() - startedAtRef.current);
    }
  }, [live, measuredMs]);

  const resolvedDurationMs = durationMs ?? measuredMs;

  // Nothing happened: no reasoning text, not live, no duration → render nothing.
  if (!summary && !live && resolvedDurationMs === null) return null;

  const expandable = summary.length > 0;
  const showBody = expandable && expanded;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: showBody ? 5 : 0,
        minWidth: 0,
        maxWidth: '100%',
        ...style,
      }}
    >
      <button
        type="button"
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
        aria-expanded={expandable ? expanded : undefined}
        aria-label={expandable ? (expanded ? 'Hide reasoning' : 'Show reasoning') : live ? 'Model is reasoning' : 'Reasoning duration'}
        disabled={!expandable}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          minHeight: 22,
          border: 'none',
          background: 'transparent',
          padding: 0,
          textAlign: 'left',
          cursor: expandable ? 'pointer' : 'default',
          color: 'var(--t-text-muted)',
          WebkitTapHighlightColor: 'transparent',
          transition: 'none',
        }}
      >
        {live ? (
          <span
            className={reducedMotion ? undefined : 'o8-thought-shimmer'}
            style={{
              flexShrink: 0,
              position: 'relative',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 12,
              fontWeight: 300,
              letterSpacing: '-0.005em',
              color: 'var(--t-text-secondary)',
            }}
          >
            Thinking
          </span>
        ) : (
          <span
            style={{
              flexShrink: 0,
              fontFamily: 'var(--font-sans-system)',
              fontSize: 12,
              fontWeight: 300,
              letterSpacing: '-0.005em',
              color: 'var(--t-text-muted)',
            }}
          >
            {formatThoughtDuration(resolvedDurationMs)}
          </span>
        )}

        {/* Live with streamed reasoning: a one-line peek beside the label.
            Done + expandable: a chevron. Duration-only: just the line. */}
        {live && summary ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11.5,
              color: 'var(--t-text-faint)',
            }}
          >
            {`— ${summary}`}
          </span>
        ) : expandable ? (
          <Chevron open={expanded} />
        ) : null}
      </button>

      {showBody ? (
        <div
          style={{
            maxHeight: live ? 132 : 360,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 12,
            lineHeight: 1.55,
            letterSpacing: '-0.005em',
            color: 'var(--t-text-faint)',
            paddingLeft: 1,
          }}
        >
          {thinking.trim()}
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        display: 'block',
        flexShrink: 0,
        color: 'var(--t-text-faint)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'none',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
