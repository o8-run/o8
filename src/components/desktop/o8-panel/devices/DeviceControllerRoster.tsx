'use client';

import type { CSSProperties } from 'react';
import type { DeviceState } from '@/lib/devices/types';

export interface DeviceControlAction {
  action: 'take-control' | 'handoff' | 'release-control';
  deviceId: string;
  expectedSession: string | null;
  targetSession?: string;
}
const button: CSSProperties = { border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-glass-muted)', color: 'var(--t-text)',
  paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, fontSize: 11.5, fontWeight: 300, cursor: 'pointer' };

/** Static input attribution also respects reduced motion: no polling animation. */
export function DeviceControllerRoster({ state, disabled, onAction }: { state: DeviceState; disabled: boolean; onAction: (action: DeviceControlAction) => void }) {
  const devices = state.devices?.filter(device => device.platform === 'ios' && device.state === 'running') ?? [];
  return <section aria-label="Device controllers" style={{ flexShrink: 0, maxHeight: '30vh', overflowY: 'auto', scrollbarWidth: 'none',
    paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16, borderBottom: '1px solid var(--t-divider-subtle)', color: 'var(--t-text)', fontSize: 11.5 }}>
    <p style={{ marginTop: 0, marginBottom: 8, color: 'var(--t-text-muted)' }}>Viewing is passive. Take operator control of each open simulator before using the viewer.</p>
    {devices.map(device => {
      const row = state.controllers?.find(value => value.deviceId === device.id);
      const expectedSession = row?.active?.session ?? null;
      const busy = disabled || Boolean(row?.busy);
      return <div key={device.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, paddingBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{device.name} · {row?.active?.label ?? 'No controller'}</span>
          <button type="button" style={button} disabled={busy} onClick={() => onAction({ action: row?.active?.kind === 'operator' ? 'release-control' : 'take-control', deviceId: device.id, expectedSession })}>
            {row?.active?.kind === 'operator' ? 'Release operator control' : 'Take operator control'}
          </button>
        </div>
        {row?.waiting.map(waiter => <div key={waiter.session} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--t-text-muted)' }}>Waiting · {waiter.label}</span>
          <button type="button" style={button} disabled={busy} onClick={() => onAction({ action: 'handoff', deviceId: device.id, expectedSession, targetSession: waiter.session })}>Hand off control</button>
        </div>)}
        {row?.lastInput ? <div aria-label="Last agent input" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /></svg>
          <span>{row.lastInput.label} · {row.lastInput.action}{row.lastInput.x !== undefined ? ` at ${row.lastInput.x}, ${row.lastInput.y}` : ''}</span>
        </div> : null}
        {row?.error ? <p role="alert" style={{ marginTop: 0, marginBottom: 0 }}>{row.error}</p> : null}
      </div>;
    })}
    {!devices.length ? <span>No running iOS simulators. Android control remains unavailable here.</span> : null}
  </section>;
}
