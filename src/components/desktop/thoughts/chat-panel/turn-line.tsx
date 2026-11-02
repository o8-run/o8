'use client';

/**
 * turn-line — shared primitives for the Cursor slim-line turn grammar
 * (operator ruling 2026-07-13, vid2 2:26–3:20 mechanics study).
 *
 * The transcript's system vocabulary is TEXT, never boxes: live activity is a
 * text-sheen shimmer over plain words (the `.o8-thought-shimmer` compositor
 * sweep in globals.css), settled activity is a muted line, and the only
 * interactive affordance is a small rotating chevron. Terminal-log density.
 */

import type { CSSProperties, ReactNode } from 'react';

export const TURN_LINE_FONT_SIZE = 12;
export const TURN_LINE_COLOR = 'var(--t-text-muted)';

const baseLineStyle: CSSProperties = {
  fontFamily: 'var(--font-sans-system)',
  fontSize: TURN_LINE_FONT_SIZE,
  fontWeight: 400,
  letterSpacing: '-0.005em',
  lineHeight: 1.5,
  color: TURN_LINE_COLOR,
};

/** A live-activity line: plain text with the left-to-right sheen sweep. */
export function ShimmerLine({ children, reducedMotion = false, style }: {
  children: ReactNode;
  reducedMotion?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      className={reducedMotion ? undefined : 'o8-thought-shimmer'}
      style={{
        ...baseLineStyle,
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        color: 'var(--t-text-secondary)',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The turn grammar's sole affordance: a small chevron, down when open. */
export function TurnChevron({ open, reducedMotion = false }: { open: boolean; reducedMotion?: boolean }) {
  return (
    <svg
      width="11"
      height="11"
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
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: reducedMotion ? 'none' : 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

/** Green/red diff counts, tabular so live ticking reads smoothly. */
export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  if (added <= 0 && removed <= 0) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
      fontSize: 10.5,
      fontVariantNumeric: 'tabular-nums',
      flexShrink: 0,
    }}>
      {added > 0 ? (
        <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>{`+${added}`}</span>
      ) : null}
      {removed > 0 ? (
        <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>{`−${removed}`}</span>
      ) : null}
    </span>
  );
}

export const turnLineStyle = baseLineStyle;
