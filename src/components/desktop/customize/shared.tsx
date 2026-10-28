'use client';

import { useState } from 'react';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono, "SF Mono", Menlo, monospace)';

export function TruncatedRows({ rows, limit = 6 }: { rows: React.ReactNode[]; limit?: number }) {
  const [showAll, setShowAll] = useState(false);
  if (rows.length <= limit || showAll) return <>{rows}</>;
  return (
    <>
      {rows.slice(0, limit)}
      <button
        type="button"
        onClick={() => setShowAll(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 44,
          border: 'none',
          background: 'transparent',
          paddingTop: 5,
          paddingBottom: 5,
          paddingLeft: 10,
          paddingRight: 10,
          textAlign: 'left',
          cursor: 'pointer',
          color: 'var(--t-text-muted)',
          fontSize: 12,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          fontFamily: UI_FONT,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {`Show ${rows.length - limit} more`}
        <ChevronDownGlyph />
      </button>
    </>
  );
}

export function SectionHeader({ label, count, action }: {
  label: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 44, paddingTop: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)' }}>{label}</span>
      <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>{count}</span>
      {action ? <span style={{ marginLeft: 'auto' }}>{action}</span> : null}
    </div>
  );
}

export function Row({ title, titleMono = false, subtitle, pill, dot, expanded, onClick, trailing, children }: {
  title: string;
  titleMono?: boolean;
  subtitle?: string | null;
  pill?: string | null;
  dot?: 'green' | 'gray' | null;
  expanded?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        {...(onClick ? {
          role: 'button',
          tabIndex: 0,
          onClick,
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onClick();
            }
          },
        } : {})}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          minHeight: 44,
          paddingTop: 5,
          paddingBottom: 5,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 9,
          background: hover || expanded ? 'var(--t-hover, var(--t-bg-card))' : 'transparent',
          cursor: onClick ? 'pointer' : 'default',
          transition: 'background 100ms ease',
        }}
      >
        {dot ? (
          <span aria-hidden="true" style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: dot === 'green' ? 'var(--t-terminal-ansi-bright-green, #16a34a)' : 'var(--t-text-faint)',
          }} />
        ) : null}
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{
            fontSize: titleMono ? 12 : 13.5,
            fontWeight: titleMono ? 400 : 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
            color: 'var(--t-text)',
            fontFamily: titleMono ? MONO_FONT : UI_FONT,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {title}
          </span>
          {subtitle ? (
            <span style={{
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              lineHeight: 1.25,
              color: 'var(--t-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {subtitle}
            </span>
          ) : null}
        </div>
        {pill ? (
          <span style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: 'var(--t-text-muted)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            borderRadius: 999,
            paddingTop: 1,
            paddingBottom: 1,
            paddingLeft: 7,
            paddingRight: 7,
          }}>
            {pill}
          </span>
        ) : null}
        {trailing}
        {onClick ? <RowChevron open={expanded === true} /> : null}
      </div>
      {expanded && children ? (
        <div style={{
          marginLeft: 10,
          marginRight: 10,
          marginBottom: 6,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 8,
          background: 'var(--t-bg-card)',
        }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, body, actionLabel, onAction }: {
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{
      marginTop: 16,
      minHeight: 140,
      paddingTop: 28,
      paddingBottom: 28,
      paddingLeft: 24,
      paddingRight: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-divider-subtle)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      textAlign: 'center',
    }}>
      <span style={{ fontSize: 13.5, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>{title}</span>
      {body ? <span style={{ fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-muted)', maxWidth: 420, lineHeight: 1.5 }}>{body}</span> : null}
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          style={{
            minHeight: 44,
            marginTop: 8,
            paddingTop: 5,
            paddingBottom: 5,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            fontSize: 12,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            fontFamily: UI_FONT,
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function DetailLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 9, fontWeight: 300, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t-text-faint)', width: 68, flexShrink: 0, paddingTop: 1 }}>
        {label}
      </span>
      <span style={{
        fontSize: 11,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        color: 'var(--t-text-secondary)',
        fontFamily: mono ? MONO_FONT : UI_FONT,
        wordBreak: 'break-all',
      }}>
        {value}
      </span>
    </div>
  );
}

export function OpenFileLink({ file, onOpenFile }: { file: string; onOpenFile: (path: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenFile(file)}
      style={{
        alignSelf: 'flex-start',
        minHeight: 44,
        border: 'none',
        background: 'transparent',
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
        fontSize: 12,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        color: 'var(--t-accent)',
        cursor: 'pointer',
        fontFamily: UI_FONT,
      }}
    >
      Open file ›
    </button>
  );
}

function ChevronDownGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--t-text-faint)' }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function RowChevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{
      flexShrink: 0,
      color: 'var(--t-text-faint)',
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
    }}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
