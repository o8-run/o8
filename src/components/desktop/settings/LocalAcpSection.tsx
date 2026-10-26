'use client';

import { useEffect, useRef, useState } from 'react';
import { RamsButton } from './shared';
import { AcpRegistryPicker } from './AcpRegistryPicker';
import { RuntimeBillingRow } from './RuntimeBillingRow';
import { LocalAcpEnvironment } from './LocalAcpEnvironment';

const fieldStyle = { width: '100%', boxSizing: 'border-box' as const, border: '1px solid var(--t-border)', borderRadius: 8, padding: 10, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12 };
export function LocalAcpSection() {
  const [name, setName] = useState('Local ACP');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [useOpenRouter, setUseOpenRouter] = useState(false);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const action = useRef<AbortController | null>(null);
  const commandField = useRef<HTMLInputElement>(null);
  const begin = () => { if (action.current) return null; const controller = new AbortController(); action.current = controller; return controller; };
  const finish = (controller: AbortController) => { if (action.current === controller) action.current = null; };
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    let alive = true;
    fetch('/api/runtime/acp-connection').then(async response => {
      if (!response.ok) throw new Error('Could not read ACP connection.');
      const data = await response.json();
      if (!alive) return;
      setLocked(data.envLocked === true);
      if (data.connection) {
        setName(data.connection.name); setCommand(data.connection.command); setArgs(data.connection.args.join('\n'));
        setUseOpenRouter(data.connection.useOpenRouter); setSaved(true); setConfigured(true);
      }
    }).catch(() => { if (alive) setNotice('Could not read ACP connection. Reopen this section to retry.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const save = async () => {
    if (locked) return;
    const controller = begin(); if (!controller) return;
    setBusy(true); setNotice('Saving connection…');
    try {
      const response = await fetch('/api/runtime/acp-connection', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connection: { name, command, args: args ? args.split('\n') : [], useOpenRouter } }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save connection.');
      if (controller.signal.aborted) return;
      setSaved(true); setConfigured(true); setNotice('Saved. Choose Local ACP in the composer for a new conversation.');
      window.dispatchEvent(new Event('o8:acp-connection-changed'));
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Could not save connection.'); }
    finally { finish(controller); if (!controller.signal.aborted) setBusy(false); }
  };
  const dirty = () => { setSaved(false); setConfirmRemove(false); };
  const checkModels = async () => {
    const controller = begin(); if (!controller) return;
    setChecking(true); setNotice('Starting the agent to check its connection…');
    try {
      const response = await fetch('/api/orchestrator/backend-models?backend=acp&refresh=1', { signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data.error || !data.available) throw new Error(data.error || 'The agent could not connect. Check its command and sign-in.');
      if (controller.signal.aborted) return;
      setNotice(data.total ? `Connected. The agent offers ${data.total} models in the composer.` : 'Connected. This agent uses its own default model.');
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Could not check the connection.'); }
    finally { finish(controller); if (!controller.signal.aborted) setChecking(false); }
  };
  const remove = async () => {
    const controller = begin(); if (!controller) return;
    setBusy(true);
    try {
      const response = await fetch('/api/runtime/acp-connection', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connection: null }) });
      if (!response.ok) throw new Error('Could not disconnect the agent.');
      if (controller.signal.aborted) return;
      setConfigured(false); setSaved(false); setConfirmRemove(false); setCommand(''); setArgs('');
      setNotice('Disconnected for new conversations. Existing conversations keep their running agent.');
      window.dispatchEvent(new Event('o8:acp-connection-changed'));
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Could not disconnect.'); }
    finally { finish(controller); if (!controller.signal.aborted) setBusy(false); }
  };
  return <div style={{ marginTop: 20, color: 'var(--t-text)', fontSize: 12 }}>
    <p style={{ color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Connect an installed ACP agent for conversations. The agent manages its tools, sign-in, and permissions. Saving does not start it.</p>
    <RuntimeBillingRow runtimeId="acp" />
    <RamsButton variant="ghost" disabled={loading || busy || checking || locked} onClick={() => setRegistryOpen(value => !value)}>Browse agents</RamsButton>
    {registryOpen ? <AcpRegistryPicker onClose={() => { setRegistryOpen(false); queueMicrotask(() => commandField.current?.focus()); }} onChoose={connection => {
      setName(connection.name); setCommand(connection.command); setArgs(connection.args.join('\n')); setUseOpenRouter(false);
      setSaved(false); setRegistryOpen(false); queueMicrotask(() => commandField.current?.focus()); setNotice('Prepared. Save this connection, then check it. Your current connection stays active until you save.');
    }} /> : null}
    {locked ? <p>Controlled by O8_ACP_COMMAND in your environment.</p> : null}
    <fieldset disabled={loading || busy || checking || locked || registryOpen} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      <label>Name<input style={fieldStyle} value={name} onChange={event => { setName(event.target.value); dirty(); }} /></label>
      <label>Executable<input ref={commandField} style={fieldStyle} value={command} placeholder="agent executable or full path" onChange={event => { setCommand(event.target.value); dirty(); }} /></label>
      <label>Arguments, one per line<textarea style={{ ...fieldStyle, minHeight: 76 }} value={args} placeholder="acp" onChange={event => { setArgs(event.target.value); dirty(); }} /></label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={useOpenRouter} onChange={event => { setUseOpenRouter(event.target.checked); dirty(); }} />Share the saved OpenRouter key when My API key pays</label>
      <p style={{ color: 'var(--t-text-muted)', margin: 0 }}>Use one literal argument per line. Keep secrets out of arguments. OpenRouter sharing requires both this option and My API key billing.</p>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}><RamsButton variant="primary" busy={busy} disabled={!command.trim() || !name.trim()} onClick={() => void save()}>Save connection</RamsButton><RamsButton variant="ghost" disabled={!saved} onClick={() => void checkModels()}>Check connection</RamsButton></div>
    {configured ? <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>{confirmRemove ? <><span>Disconnect for new conversations? </span><RamsButton variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</RamsButton><RamsButton variant="ghost" onClick={() => void remove()}>Disconnect</RamsButton></> : <RamsButton variant="ghost" onClick={() => setConfirmRemove(true)}>Remove connection</RamsButton>}</div> : null}
    </fieldset>
    {configured && !locked ? <LocalAcpEnvironment /> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <p style={{ color: 'var(--t-text-muted)' }}>Check starts the agent and reads its capabilities without sending a prompt.</p>
  </div>;
}
