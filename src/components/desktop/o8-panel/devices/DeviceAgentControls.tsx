'use client';

import { useState } from 'react';
import type { DeviceState } from '@/lib/devices/types';

/** The viewer shares a real device; displaying it does not acquire an agent session. */
export function DeviceAgentControls({ state, disabled, onInstall, compact = false, statusMessage }: {
  state: DeviceState; disabled: boolean; onInstall: () => void; compact?: boolean; statusMessage?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const copy = async () => {
    const instructions = [
      'Use the o8_device agent tool to test an iOS simulator already open in Devices.',
      'Call status, then acquire with the chosen deviceId. Your controller session is assigned automatically to this conversation and worker.',
      'Use press, swipe, scroll, type and snapshot with that deviceId. If occupied, ask its controller for an explicit handoff to your waiting session. Never reuse another worker’s session or bypass the device authority with a raw helper.',
      'Call release when finished or cancelled. The Devices panel shows the controller and waiting workers. Manual viewer input requires the operator to take control; request a handoff to resume agent input.',
    ].join('\n\n');
    try { await navigator.clipboard.writeText(instructions); setCopied(true); setError(false); }
    catch { setError(true); }
  };
  const buttonStyle = { border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-glass-muted)', color: 'var(--t-text)', paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, fontSize: 11.5, cursor: 'pointer' };
  const content = <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, paddingTop: 8, maxHeight: compact ? '30vh' : undefined, overflowY: 'auto', scrollbarWidth: 'none', fontSize: 11.5, lineHeight: 1.6, color: 'var(--t-text-muted)' }}>
    <p style={{ margin: 0 }}>This is a shared phone. Each connected agent receives its own controller session automatically. Occupied devices require an explicit handoff.</p>
    <p style={{ margin: 0 }}>Viewing is passive. Taking operator control pauses agent input until you hand control back.</p>
    {state.tools.agent.installed && state.agentCommand ? <button type="button" onClick={() => { void copy(); }} style={buttonStyle}>{copied ? 'Instructions copied' : 'Copy agent instructions'}</button>
      : compact ? <p style={{ margin: 0 }}>Stop the viewer to set up agent controls. The simulator will stay open.</p>
        : <button type="button" disabled={disabled} onClick={onInstall} style={buttonStyle}>Set up agent controls</button>}
    {error ? <span role="alert">Could not copy. Check clipboard access and try again.</span> : null}
  </div>;
  return compact ? <details style={{ paddingTop: 7, paddingRight: 16, paddingBottom: 7, paddingLeft: 16, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
    <summary title={statusMessage ?? undefined} style={{ fontSize: 11.5, color: 'var(--t-text-muted)', cursor: 'pointer' }}><span role="status">{statusMessage ? 'Connection delayed' : 'Shared device'}</span> · Agent controls</summary>{content}
  </details> : <div style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 16 }}><div style={{ fontSize: 12 }}>Agent controls</div>{content}</div>;
}
