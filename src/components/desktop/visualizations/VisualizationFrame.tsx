'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RamsButton } from '@/components/desktop/settings/shared';
import { useTheme } from '@/lib/theme/context';
import { visualizationSrcdoc, type VisualizationTheme } from '@/lib/visualizations/document';
import { VISUALIZATION_LIMITS, type VisualizationDocument, type VisualizationReference } from '@/lib/visualizations/types';
import { cachedVisualization, loadVisualization } from './document-cache';
import { readVisualizationTheme } from './theme';
import { VISUALIZATION_STATE_EVENT, readVisualizationState, writeVisualizationState } from './view-state';
import { VisualizationQuestion } from './VisualizationQuestion';
import { useVisualizationVersions } from './useVisualizationVersions';

export function VisualizationFrame({ reference: original, expanded = false }: { reference: VisualizationReference; expanded?: boolean }) {
  const version = useVisualizationVersions(original);
  return <VisualizationDocumentFrame key={version.reference.id} version={version} expanded={expanded} />;
}

function VisualizationDocumentFrame({ version, expanded }: { version: ReturnType<typeof useVisualizationVersions>; expanded: boolean }) {
  const reference = version.reference;
  const stateId = reference.rootId ?? reference.id;
  const identity = useId();
  const nonce = `${identity}:${reference.id}`;
  const { paletteId, workspaceGlass, surface } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<VisualizationTheme | null>(null);
  const [doc, setDoc] = useState<VisualizationDocument | undefined>(() => cachedVisualization(reference.id));
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(reference.height);
  const [ready, setReady] = useState(false);
  const [controls, setControls] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [srcdoc, setSrcdoc] = useState('');
  const [question, setQuestion] = useState<string | null>(null);

  useEffect(() => {
    const theme = readVisualizationTheme();
    themeRef.current = theme;
    // Updating theme preserves the page's filters and other interactive state.
    frameRef.current?.contentWindow?.postMessage({ type: 'o8-visualization:theme', nonce, theme }, '*');
  }, [paletteId, workspaceGlass, surface, nonce]);

  useEffect(() => {
    if (!doc) return;
    let stopped = false;
    void visualizationSrcdoc(doc.html, nonce, themeRef.current ?? readVisualizationTheme(), readVisualizationState(stateId)).then(source => {
      if (!stopped) setSrcdoc(source);
    }).catch(() => { if (!stopped) setError('This browser could not prepare the visualization.'); });
    return () => { stopped = true; };
  }, [doc, nonce, stateId]);

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; state: Record<string, unknown> }>).detail;
      if (detail?.id === stateId) frameRef.current?.contentWindow?.postMessage({ type: 'o8-visualization:state', nonce, value: detail.state }, '*');
    };
    const storage = (event: StorageEvent) => {
      if (event.key === `o8:visualization-view:v1:${stateId}`) frameRef.current?.contentWindow?.postMessage({ type: 'o8-visualization:state', nonce, value: readVisualizationState(stateId) }, '*');
    };
    window.addEventListener(VISUALIZATION_STATE_EVENT, sync);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(VISUALIZATION_STATE_EVENT, sync); window.removeEventListener('storage', storage); };
  }, [nonce, stateId]);

  useEffect(() => {
    let stopped = false;
    // Every saved card enters the bounded queue, even outside the viewport.
    void loadVisualization(reference.id, () => {
      const card = cardRef.current;
      if (!card?.isConnected) return Infinity;
      const rect = card.getBoundingClientRect();
      return Math.hypot(Math.max(0, -rect.bottom, rect.top - window.innerHeight),
        Math.max(0, -rect.right, rect.left - window.innerWidth));
    }).then(document => {
      if (!stopped) { setDoc(document); setError(null); }
    }).catch(reason => { if (!stopped) setError(reason instanceof Error ? reason.message : 'This visualization is unavailable.'); });
    return () => { stopped = true; };
  }, [reference.id, attempt]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== 'null' || event.data?.nonce !== nonce) return;
      if (event.data.type === 'o8-visualization:state') { writeVisualizationState(stateId, event.data.value); return; }
      if (event.data.type === 'o8-visualization:question') {
        if (typeof event.data.value === 'string' && event.data.value.trim() && event.data.value.length <= 4000
          // WebKit does not carry transient activation across both opaque frames.
          // Focus limits proposals; the host's Add to chat action owns draft changes.
          && document.activeElement === frameRef.current) setQuestion(event.data.value.trim());
        return;
      }
      if (event.data.type !== 'o8-visualization:height' || typeof event.data.height !== 'number' || !Number.isFinite(event.data.height)) return;
      setHeight(Math.min(expanded ? 4000 : VISUALIZATION_LIMITS.maxHeight, Math.max(VISUALIZATION_LIMITS.minHeight, Math.ceil(event.data.height))));
      setReady(true);
      if (themeRef.current) frameRef.current?.contentWindow?.postMessage({ type: 'o8-visualization:theme', nonce, theme: themeRef.current }, '*');
      frameRef.current?.contentWindow?.postMessage({ type: 'o8-visualization:state', nonce, value: readVisualizationState(stateId) }, '*');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [nonce, expanded, stateId]);

  useEffect(() => {
    if (!doc || ready) return;
    const timer = window.setTimeout(() => setError('The visualization did not finish loading. Retry it or rebuild it from this chat.'), 15_000);
    return () => window.clearTimeout(timer);
  }, [doc, ready, attempt]);

  const open = useCallback(() => window.dispatchEvent(new CustomEvent('o8:open-visualization', { detail: reference })), [reference]);
  const buttonStyle: React.CSSProperties = { border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-bg-elevated)',
    color: 'var(--t-text-primary)', font: '12px var(--font-sans-system)', paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8, cursor: 'pointer',
    backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' };

  return <div ref={cardRef} data-o8-visualization={reference.id} style={{ position: 'relative', width: '100%', minWidth: 0, minHeight: error ? 96 : height }}
    onMouseEnter={() => setControls(true)} onMouseLeave={() => setControls(false)} onFocusCapture={() => setControls(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControls(false); }}>
    {error ? <div role="status" style={{ paddingTop: 16, paddingBottom: 16, color: 'var(--t-text-muted)', fontSize: 13 }}>
      <div>{error}</div>
      <div style={{ marginTop: 10 }}><RamsButton variant="ghost" onClick={() => { setError(null); setReady(false); setDoc(undefined); setSrcdoc(''); setAttempt(value => value + 1); }}>Retry visualization</RamsButton>
        <RamsButton variant="ghost" onClick={() => setQuestion(`Rebuild the saved visualization “${reference.title}” from this chat. Its source (${reference.id}) is unavailable or could not load. Use the original data and requirements in the conversation, and ask me for anything missing.`)}>Rebuild visualization</RamsButton></div>
    </div> : <>
      {srcdoc ? <iframe key={`${reference.id}:${attempt}`} ref={frameRef} title={reference.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
        srcDoc={srcdoc} style={{ display: 'block', border: 0, width: '100%', height, background: 'transparent', opacity: ready ? 1 : 0 }} /> : null}
      {!ready ? <div role="status" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--t-text-muted)', fontSize: 12, background: 'var(--t-bg-hover)', borderRadius: 10 }}>Loading visualization…</div> : null}
      {ready ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 12, marginTop: 6, opacity: controls || expanded ? 1 : 0,
        pointerEvents: controls || expanded ? 'auto' : 'none' }}>
        {version.versions.length > 1 ? <select aria-label="Visualization version" value={version.chosen} onChange={event => version.choose(event.target.value)} style={{ ...buttonStyle, fontSize: 11 }}>
          <option value="">Latest (v{version.latest.version ?? 1})</option>
          {version.versions.map(ref => <option key={ref.id} value={ref.id}>v{ref.version ?? 1}{ref.id === version.latest.id ? ' (current)' : ''}</option>)}
        </select> : null}
        <RamsButton variant="ghost" onClick={() => setQuestion(`Refine this visualization. Read it with o8_visualization_read (id: ${reference.id}), then revise the latest version with revisionOf. Keep its data and control keys. My requested change: `)}>Refine visual</RamsButton>
        {!expanded ?
        <button aria-label={`Open ${reference.title} in workspace`} style={{ ...buttonStyle, display: 'flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: 0, paddingTop: 4, paddingBottom: 4, paddingLeft: 0, paddingRight: 0, fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }} onClick={open}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg>
          Open in workspace
        </button> : null}
      </div> : null}
    </>}
    {question ? <VisualizationQuestion title={reference.title} question={question} onClose={() => setQuestion(null)} /> : null}
  </div>;
}
