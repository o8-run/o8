'use client';

export function VisualCaptureControls(props: { elapsedMs: number; busy: boolean; onUndo: () => void; onCancel: () => void; onFinish: () => void }) {
  const seconds = Math.floor(props.elapsedMs / 1000);
  const button = { border: 0, background: 'transparent', color: 'var(--t-text-muted)', paddingTop: 6, paddingRight: 8, paddingBottom: 6, paddingLeft: 8, fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: props.busy ? 'default' : 'pointer' } as const;
  return <div data-visual-capture-controls="true" role="group" aria-label="Visual capture controls" style={{ position: 'fixed', top: 24, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 6,
    paddingTop: 4, paddingRight: 6, paddingBottom: 4, paddingLeft: 12, borderRadius: 13, background: 'color-mix(in srgb, var(--t-panel) 90%, transparent)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--t-divider-subtle)', color: 'var(--t-text)', boxShadow: '0 4px 20px rgba(0,0,0,0.12)', fontFamily: 'var(--font-sans-system)', fontSize: 10, fontWeight: 300, cursor: 'default', whiteSpace: 'nowrap' }}>
    <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--t-brand-orange)' }} />
    <span aria-label="Capture duration" style={{ minWidth: 30, fontVariantNumeric: 'tabular-nums', color: 'var(--t-text-muted)' }}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
    <span style={{ color: 'var(--t-text-muted)', paddingRight: 5 }}>⇧ to draw</span>
    <button type="button" aria-label="Undo last mark" title="Undo last mark" disabled={props.busy} onClick={props.onUndo} style={button}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8" /></svg>
    </button>
    <button type="button" disabled={props.busy} onClick={props.onCancel} style={button}>Cancel</button>
    <button type="button" disabled={props.busy} onClick={props.onFinish} title="Add capture to this chat" style={{ ...button, color: 'var(--t-text)', borderRadius: 8, background: 'var(--t-hover)' }}>{props.busy ? 'Finishing…' : 'Finish'}</button>
  </div>;
}
