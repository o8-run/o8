'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DeviceState } from '@/lib/devices/types';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { PanelToolIcon } from '../panel-tools';
import { DeviceAgentControls } from './DeviceAgentControls';
import { DeviceControllerRoster, type DeviceControlAction } from './DeviceControllerRoster';

const button: CSSProperties = { border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-glass-muted)', color: 'var(--t-text)', paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, fontSize: 11.5, fontWeight: 300, cursor: 'pointer' };
const muted: CSSProperties = { color: 'var(--t-text-muted)', fontSize: 11.5, lineHeight: 1.6, margin: 0 };

/** Inspection is passive. Only an explicit operator action installs or starts helpers. */
export function DevicePanel({ active }: { active: boolean }) {
  const [state, setState] = useState<DeviceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [mutating, setMutating] = useState(false);
  const request = useRef<AbortController | null>(null);
  const live = useRef(active);
  const read = useCallback(async (action?: 'start' | 'stop' | 'refresh' | 'install' | DeviceControlAction, tool?: 'hub' | 'agent') => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPending(true);
    setMutating(Boolean(action));
    if (action) setError(null);
    const deadline = window.setTimeout(() => {
      controller.abort();
      if (request.current === controller && live.current) {
        setError('Device tools took too long to respond. Refresh to try again.');
        setPending(false);
        setMutating(false);
      }
    }, 15_000);
    try {
      const response = await fetch('/api/panel/devices', action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(typeof action === 'object' ? action : { action, ...(tool ? { tool } : {}) }), signal: controller.signal } : { signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? 'Device tools could not be reached.');
      if (!controller.signal.aborted && live.current) { setState(value as DeviceState); setError(null); }
    } catch (failure) {
      if (!controller.signal.aborted && live.current) setError(failure instanceof Error ? failure.message : 'Device tools could not be reached.');
    } finally { if (request.current === controller) request.current = null; window.clearTimeout(deadline); if (!controller.signal.aborted && live.current) { setPending(false); setMutating(false); } }
  }, []);
  useEffect(() => {
    live.current = active;
    if (active) void read();
    return () => { live.current = false; request.current?.abort(); };
  }, [active, read]);
  useEffect(() => {
    if (!active || pending || !['installing', 'starting', 'running'].includes(state?.phase ?? '')) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden') void read();
    }, error ? 30_000 : state?.phase === 'running' ? 5_000 : 1_500);
    return () => window.clearTimeout(timer);
  }, [active, error, pending, read, state]);
  useEffect(() => {
    const resume = () => { if (active && document.visibilityState === 'visible' && !request.current) void read(); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [active, read]);
  const busy = mutating || (pending && !state) || state?.phase === 'installing' || state?.phase === 'starting';
  const running = state?.phase === 'running' && state.embedUrl;
  const openDevices = state?.devices?.filter(device => device.state === 'running') ?? [];
  const manualControl = !mutating && !error && openDevices.length > 0 && openDevices.every(device => device.platform === 'ios' && state?.controllers?.some(row => row.deviceId === device.id && row.active?.kind === 'operator' && !row.busy && !row.error));
  return <section aria-label="Device workspace" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
      <PanelToolIcon tool="device" size={16} />
      <span style={{ flex: 1, fontSize: 12, fontWeight: 300 }}>Devices</span>
      <button type="button" disabled={busy} onClick={() => { void read('refresh'); }} style={button}>Refresh</button>
      {running ? <button type="button" disabled={busy} title="Stop the viewer helper. Your simulators stay open." onClick={() => { void read('stop'); }} style={button}>Stop viewer</button> : null}
    </header>
    {!running && (error || state?.error) ? <div role="alert" style={{ ...muted, paddingTop: 10, paddingRight: 16, paddingBottom: 10, paddingLeft: 16, color: 'var(--t-text)' }}>{error ?? state?.error}</div> : null}
    {running && state ? <DeviceAgentControls state={state} statusMessage={error ?? state.error} disabled={busy} onInstall={() => { void read('install', 'agent'); }} compact /> : null}
    {running && state ? <DeviceControllerRoster state={state} disabled={busy} onAction={action => { void read(action); }} /> : null}
    {running && active ? <div inert={!manualControl} style={{ display: 'flex', flex: 1, minHeight: 0, pointerEvents: manualControl ? 'auto' : 'none' }}><iframe title={manualControl ? 'Live device controls — Operator' : 'Live device viewer — passive'} src={state.embedUrl} tabIndex={manualControl ? 0 : -1} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" style={{ flex: 1, minHeight: 0, width: '100%', border: 0, background: 'var(--t-bg)' }} /></div> : <div style={{ overflowY: 'auto', scrollbarWidth: 'none', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ paddingTop: 12 }}>
        <div style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', borderRadius: 14, background: 'var(--t-glass-muted)', color: 'var(--t-accent)', marginBottom: 18 }}><PanelToolIcon tool="device" size={25} /></div>
        <h2 style={{ fontSize: 20, fontWeight: 300, marginTop: 0, marginRight: 0, marginBottom: 8, marginLeft: 0, color: 'var(--t-text)' }}>Build for the screen in your hand.</h2>
        <p style={muted}>Run your installed iOS simulators and Android emulators here. See the app, interact with it, and capture what needs work.</p>
      </div>
      {!state ? <p role="status" style={muted}>{pending ? 'Checking device tools…' : 'Refresh to check your device tools.'}</p> : <>
        <div style={{ border: '1px solid var(--t-divider)', borderRadius: 12, overflow: 'hidden' }}>
          {(['ios', 'android'] as const).map((platform, index) => <div key={platform} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14, borderTop: index ? '1px solid var(--t-divider-subtle)' : undefined }}>
            <span aria-hidden="true" style={{ width: 6, height: 6, marginTop: 6, borderRadius: '50%', background: state.platforms[platform].available ? 'var(--t-accent)' : 'var(--t-text-faint)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13.5, fontWeight: 300, marginBottom: 3 }}>{platform === 'ios' ? 'iOS Simulator' : 'Android Emulator'}</div><p style={muted}>{state.platforms[platform].detail}</p></div>
            {!state.platforms[platform].available ? <button type="button" onClick={() => { void openExternalUrl(platform === 'ios' ? 'https://developer.apple.com/xcode/' : 'https://developer.android.com/studio/run/emulator'); }} style={{ ...button, paddingTop: 6, paddingRight: 8, paddingBottom: 6, paddingLeft: 8 }}>Setup guide</button> : null}
          </div>)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
          <button type="button" disabled={busy} onClick={() => { void read(state.tools.hub.installed ? 'start' : 'install', state.tools.hub.installed ? undefined : 'hub'); }} style={{ ...button, background: 'var(--t-accent)', color: 'var(--t-success-contrast)' , opacity: busy ? 0.6 : 1 }}>
            {state.phase === 'installing' ? 'Setting up…' : state.phase === 'starting' ? 'Opening devices…' : state.tools.hub.installed ? 'Open device workspace' : 'Set up device viewer'}
          </button>
          <p role="status" style={muted}>{state.stage ?? (state.tools.hub.installed ? 'Use the panel maximize button for more room.' : 'Downloads the device viewer helper only. SDKs and simulator images are installed separately.')}</p>
        </div>
        <DeviceAgentControls state={state} disabled={busy} onInstall={() => { void read('install', 'agent'); }} />
      </>}
    </div>}
  </section>;
}
