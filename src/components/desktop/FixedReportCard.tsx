'use client';

/**
 * FixedReportCard — "the bug you reported is fixed."
 *
 * Sibling of UpdateCard in the AgentPanel bottom slot, same geometry, green dot
 * instead of orange. Shows only when a report THIS machine filed appears in the
 * public fix manifest (see src/lib/feedback/fixed-feed.ts).
 *
 * It reaches everyone who ever filed a report. Dismissing acknowledges it for
 * good — a receipt that nags is not a thank-you.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

interface FixReceipt {
  id: string;
  title: string;
  version: string;
  reportedAt: number;
  /** 'fixed' is a win; 'needs-info' is us asking them for help. */
  status: 'fixed' | 'needs-info';
  /** The ask, for needs-info. */
  note?: string;
}

// The manifest only changes on release; the server caches for 6h anyway.
const POLL_MS = 60 * 60 * 1000;
const INITIAL_LOAD_DELAY_MS = 3_000;

function relativeAge(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? 'a month ago' : `${months} months ago`;
}

export function FixedReportCard() {
  const [receipts, setReceipts] = useState<FixReceipt[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/feedback/fixed', { cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json()) as { receipts?: FixReceipt[] };
      if (Array.isArray(body.receipts)) setReceipts(body.receipts);
    } catch {
      /* best-effort — a missing receipt is invisible, not broken */
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void load(); }, INITIAL_LOAD_DELAY_MS);
    const interval = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [load]);

  // Show one at a time. Three "we fixed your bug" cards stacked reads as a
  // changelog; one reads as a thank-you.
  const receipt = receipts[0];

  const dismiss = useCallback(async () => {
    if (!receipt) return;
    setReceipts((prev) => prev.slice(1)); // optimistic — the next one surfaces
    try {
      await fetch('/api/feedback/fixed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [receipt.id] }),
      });
    } catch {
      /* un-acked just means we offer it again next launch */
    }
  }, [receipt]);

  if (!receipt) return null;

  const asking = receipt.status === 'needs-info';
  const accent = asking ? 'var(--t-warning, #d97706)' : 'var(--t-success, #16a34a)';

  const cardStyle: CSSProperties = {
    flexShrink: 0,
    marginLeft: 8,
    marginRight: 8,
    marginBottom: 6,
    paddingTop: 9,
    paddingRight: 10,
    paddingBottom: 9,
    paddingLeft: 11,
    borderRadius: 10,
    border: '1px solid var(--t-divider-subtle)',
    background: 'var(--t-bg-card, var(--t-panel-solid))',
    boxShadow: '0 4px 14px var(--t-shadow-subtle, transparent)',
    fontFamily: 'var(--font-sans-system)',
    color: 'var(--t-text)',
  };

  const dismissStyle: CSSProperties = {
    flexShrink: 0,
    height: 22,
    width: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--t-text-faint)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 14,
    lineHeight: 1,
  };

  return (
    <div role="status" aria-live="polite" style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: accent,
            flexShrink: 0,
            marginTop: 4,
          }}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--t-text)',
            }}
          >
            {asking ? 'You reported this — we need a bit more' : 'You reported this — it\u2019s fixed'}
          </span>
          {/* The operator's own words back at them. Wrapped, not truncated: this
              is the whole payload of the card. */}
          <span
            style={{
              fontSize: 11,
              fontWeight: 320,
              lineHeight: 1.45,
              color: 'var(--t-text-secondary)',
              wordBreak: 'break-word',
            }}
          >
            {receipt.title}
          </span>
          {/* The ask IS the payload of a needs-info card — without it there is
              nothing to act on, which is why the server drops a note-less ask. */}
          {asking && receipt.note ? (
            <span
              style={{
                marginTop: 2,
                fontSize: 11,
                fontWeight: 320,
                lineHeight: 1.45,
                color: 'var(--t-text)',
                wordBreak: 'break-word',
              }}
            >
              {receipt.note}
            </span>
          ) : null}
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              color: 'var(--t-text-muted)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            {receipt.id} · reported {relativeAge(receipt.reportedAt)}
            {asking ? ' · press ⌘⇧E to reply' : ` · fixed in v${receipt.version}`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          aria-label="Dismiss"
          style={dismissStyle}
        >
          ×
        </button>
      </div>
    </div>
  );
}
