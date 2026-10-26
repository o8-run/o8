'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AcpEnvironmentInventory, AcpEnvironmentVariable } from '@/lib/acp/connection-environment';
import { RamsButton } from './shared';

const fieldStyle = {
  width: '100%', boxSizing: 'border-box' as const,
  borderTopWidth: 1, borderBottomWidth: 1, borderLeftWidth: 1, borderRightWidth: 1,
  borderTopStyle: 'solid' as const, borderBottomStyle: 'solid' as const,
  borderLeftStyle: 'solid' as const, borderRightStyle: 'solid' as const,
  borderTopColor: 'var(--t-border)', borderBottomColor: 'var(--t-border)',
  borderLeftColor: 'var(--t-border)', borderRightColor: 'var(--t-border)',
  borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomLeftRadius: 8, borderBottomRightRadius: 8,
  paddingTop: 10, paddingBottom: 10, paddingLeft: 10, paddingRight: 10,
  backgroundColor: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12,
};
const endpoint = '/api/runtime/acp-connection?environment=1';
export function LocalAcpEnvironment() {
  const [inventory, setInventory] = useState<AcpEnvironmentInventory | null>(null);
  const [variables, setVariables] = useState<AcpEnvironmentVariable[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const action = useRef<AbortController | null>(null);
  const connectionEpoch = useRef(0);
  const accept = (next: AcpEnvironmentInventory) => {
    setInventory(next); setVariables(next.variables); setStale(false);
  };
  const read = useCallback(async () => {
    if (action.current) return;
    const controller = new AbortController(); action.current = controller;
    const epoch = connectionEpoch.current;
    setBusy(true);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.variables)) throw new Error(payload.error || 'Could not read the connection environment.');
      if (!controller.signal.aborted && epoch === connectionEpoch.current) { accept(payload); setNotice(''); }
    } catch (error) {
      if (!controller.signal.aborted && epoch === connectionEpoch.current) setNotice(error instanceof Error ? error.message : 'Could not read the connection environment.');
    } finally { if (action.current === controller) action.current = null; if (!controller.signal.aborted) setBusy(false); }
  }, []);
  useEffect(() => {
    void read();
    const changed = () => {
      connectionEpoch.current += 1; setStale(true);
      setNotice('The connection changed. Reload its environment before saving this draft.');
    };
    window.addEventListener('o8:acp-connection-changed', changed);
    return () => { action.current?.abort(); action.current = null; window.removeEventListener('o8:acp-connection-changed', changed); };
  }, [read]);
  const save = async () => {
    if (!inventory || stale || action.current) return;
    const controller = new AbortController(); action.current = controller; setBusy(true);
    const epoch = connectionEpoch.current;
    try {
      const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: { connectionId: inventory.connectionId, revision: inventory.revision,
          variables: variables.map(v => ({ name: v.name, secret: v.secret, ...(v.value !== undefined ? { value: v.value } : {}) })) } }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save the connection environment.');
      if (!controller.signal.aborted && epoch === connectionEpoch.current) { accept(payload); setNotice('Saved for new Local ACP processes. Running conversations keep their current environment.'); }
    } catch (error) {
      if (!controller.signal.aborted && epoch === connectionEpoch.current) setNotice(error instanceof Error ? error.message : 'Could not save the connection environment.');
    } finally { if (action.current === controller) action.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const update = (index: number, patch: Partial<AcpEnvironmentVariable>) => {
    setVariables(previous => previous.map((v, i) => i === index ? { ...v, ...patch } : v));
  };
  return <section aria-label="Local ACP environment" style={{ marginTop: 24 }}>
    <h3 style={{ fontSize: 13, fontWeight: 400 }}>Connection environment</h3>
    <p style={{ color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Applies to checks and new conversations for this saved Local ACP executable and arguments. Saved values override inherited values. Removing an override restores inheritance. Other connections and running agents keep their environment.</p>
    <p style={{ color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Secrets use the encrypted credential store and are never read back here. Leave a saved secret blank to keep it. Process controls, executable paths and provider credentials use their existing setup controls.</p>
    <p style={{ color: 'var(--t-text-muted)', lineHeight: 1.5 }}>When secrets are saved, conversation output appears after each turn finishes so secrets split across messages can be masked.</p>
    <fieldset disabled={busy || stale || !inventory} style={{ borderTopWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0, borderRightWidth: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, display: 'grid', rowGap: 12, columnGap: 12 }}>
      {variables.map((variable, index) => <div key={index} style={{ display: 'grid', rowGap: 8, columnGap: 8 }}>
        <label>Variable name<input aria-label={`Environment name ${index + 1}`} style={fieldStyle} value={variable.name} autoComplete="off" onChange={event => update(index, { name: event.target.value, ...(variable.secret ? { configured: false } : {}) })} /></label>
        <label style={{ display: 'flex', alignItems: 'center', rowGap: 8, columnGap: 8 }}><input type="checkbox" checked={variable.secret} onChange={event => update(index, { secret: event.target.checked, value: '', configured: false })} />Secret</label>
        <label>Value<input aria-label={`Environment value ${index + 1}`} style={fieldStyle} type={variable.secret ? 'password' : 'text'} autoComplete="off" value={variable.value ?? ''} placeholder={variable.configured ? 'Saved secret · leave blank to keep' : ''}
          onChange={event => update(index, { value: variable.secret && variable.configured && event.target.value === '' ? undefined : event.target.value })} /></label>
        <RamsButton variant="ghost" onClick={() => setVariables(previous => previous.filter((_, i) => i !== index))}>Remove variable {index + 1}</RamsButton>
      </div>)}
      <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: 8, columnGap: 8 }}>
        <RamsButton variant="ghost" disabled={variables.length >= 32} onClick={() => setVariables(previous => [...previous, { name: '', secret: false, value: '' }])}>Add variable</RamsButton>
        <RamsButton variant="ghost" busy={busy} onClick={() => void save()}>Save environment</RamsButton>
      </div>
    </fieldset>
    <RamsButton variant="ghost" disabled={busy} onClick={() => void read()}>Reload environment</RamsButton>
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
