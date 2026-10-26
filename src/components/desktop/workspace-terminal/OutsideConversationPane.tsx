'use client';

import { memo, useEffect } from 'react';
import { getRuntimeCapability, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { useTranscript } from '@/lib/transcripts/useTranscript';
import { renderLLMMarkdown } from '@/components/desktop/LLMMarkdown';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { TerminalTab } from './types';

/** A source transcript has no writable chat lifecycle, injection or runtime controls. */
export function OutsideConversationPane({ sessionKey, runtime, tab, active }: {
  sessionKey: string;
  runtime: OrchestratorRuntime;
  tab: TerminalTab;
  active: boolean;
}) {
  const slice = useTranscript(sessionKey, { live: active, visible: active });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void bootstrapTranscripts([sessionKey], { refetchFresh: true, signal: controller.signal });
    return () => controller.abort();
  }, [active, sessionKey]);

  return (
    <section aria-label="Outside conversation" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, color: 'var(--t-text)', background: 'var(--t-chat-surface-bg)', fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.5 }}>
      <header style={{ paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16, borderBottom: '1px solid var(--t-divider-subtle)', overflowWrap: 'anywhere' }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.25 }}>{tab.label}</div>
        <div>{getRuntimeCapability(runtime).label} · Read only</div>
        <div style={{ color: 'var(--t-text-secondary)', fontSize: 12 }}>{sessionKey}</div>
        {tab.repo?.localPath ? <div style={{ color: 'var(--t-text-secondary)', fontSize: 12 }}>{tab.repo.localPath}</div> : null}
        <div style={{ color: 'var(--t-text-secondary)', fontSize: 12 }}>
          {slice.lastUpdated > 0 ? <>Last synced <time dateTime={new Date(slice.lastUpdated).toISOString()}>{new Date(slice.lastUpdated).toLocaleString()}</time></> : 'No transcript sync yet.'}
          {' '}Continue in the original client.
        </div>
      </header>
      {slice.status === 'error' ? (
        <div role="status" style={{ paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16 }}>
          Transcript unavailable. Retained output may be out of date.{' '}
          <button type="button" onClick={() => { if (active) void bootstrapTranscripts([sessionKey], { refetchFresh: true }); }} style={{ minHeight: 44, color: 'var(--t-text)', background: 'var(--t-panel)', border: '1px solid var(--t-border)', borderRadius: 8, cursor: 'pointer' }}>Retry transcript</button>
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16 }}>
        {slice.messages.map(entry => <OutsideConversationEntry key={entry.id} entry={entry} />)}
        {slice.messages.length === 0 ? <div role="status">{slice.status === 'loading' || slice.status === 'idle' ? 'Loading transcript…' : 'No readable transcript is available yet.'}</div> : null}
      </div>
    </section>
  );
}

const OutsideConversationEntry = memo(function OutsideConversationEntry({ entry }: { entry: MobileTranscriptEntry }) {
  const { id, role, text, ...details } = entry;
  return (
    <article data-outside-transcript-entry={id} style={{ marginBottom: 16, overflowWrap: 'anywhere' }}>
      <div style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{role}</div>
      {/* Source markdown has no mutation callbacks. */}
      {renderLLMMarkdown(sanitizeTranscriptText(text), { compact: true })}
      {Object.keys(details).length > 0 ? <details>
        <summary style={{ cursor: 'pointer', color: 'var(--t-text-secondary)', fontSize: 11 }}>Source details</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{JSON.stringify(details, null, 2)}</pre>
      </details> : null}
    </article>
  );
});
