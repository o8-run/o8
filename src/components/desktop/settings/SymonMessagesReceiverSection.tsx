'use client';

import { useEffect, useRef, useState } from 'react';
import type { MessagesReceiverStatus } from '@/lib/symon/messages-receiver/receiver';
import { isNonMacShell } from '@/lib/desktop/host-platform';
import { SettingsGroup } from './grouped';
import { RamsButton } from './shared';

const STATE_LABELS: Record<MessagesReceiverStatus['state'], string> = {
  off: 'Off', unsupported: 'Requires macOS', missing_permission: 'Needs macOS permission',
  unavailable: 'Messages are unavailable', listening: 'Listening for new authorized messages',
};
const HANDLE = /^(?:\+[1-9]\d{6,14}|[^\s@]{1,64}@[^\s@]{1,190})$/;

export function SymonMessagesReceiverSection({ onEnabledChange, mutationLocked = false, acquireMutation, releaseMutation, onWriteSettled }: {
  onEnabledChange?: (enabled: boolean | null) => void;
  mutationLocked?: boolean;
  acquireMutation?: () => boolean;
  releaseMutation?: () => void;
  onWriteSettled?: (error: string | null) => void;
}) {
  const [status, setStatus] = useState<MessagesReceiverStatus | null>(null);
  const [handlesText, setHandlesText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const handles = [...new Set(handlesText.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))];
  const valid = handles.length <= 20 && handles.every((handle) => HANDLE.test(handle));
  const changed = status !== null && handles.join('\n') !== status.handles.join('\n');
  const unsupported = isNonMacShell() || status?.state === 'unsupported';

  async function request(input?: { enabled: boolean; handles: string[] }) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    if (input?.enabled && unsupported) return;
    if (input && (mutationLocked || acquireMutation?.() === false)) return;
    let mutationError: string | null = null;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/panel/symon/messages-receiver', {
        cache: 'no-store', signal,
        ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
      });
      const data = await response.json() as MessagesReceiverStatus & { ok?: boolean };
      if (!response.ok || !data || !data.ok || typeof data.enabled !== 'boolean' || !Array.isArray(data.handles)
        || !data.handles.every((handle) => typeof handle === 'string') || !(data.state in STATE_LABELS)) throw new Error();
      if (signal.aborted) return;
      setStatus(data);
      setHandlesText(data.handles.join('\n'));
      setConfirm(false);
      onEnabledChange?.(data.enabled);
    } catch {
      mutationError = input ? 'Could not save the receiver. Check its status before trying again.' : 'Native Messages receiver status is unavailable.';
      if (!signal.aborted) {
        setStatus(null);
        setConfirm(false);
        onEnabledChange?.(null);
        setError(mutationError);
      }
    } finally {
      if (!signal.aborted) setBusy(false);
      if (input) {
        onWriteSettled?.(mutationError);
        releaseMutation?.();
      }
    }
  }

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    void request();
    return () => active.abort();
    // The parent state callback is stable. Reading is independent of later renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The receiver reads the macOS Messages database, so off macOS there is
  // nothing to set up. Keep the section only while a saved receiver is still
  // enabled, so it can be turned off. The status read above still runs and
  // reports to onEnabledChange, which the bridge section relies on.
  if (unsupported && status?.enabled !== true) return null;

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup header="Native Messages receiver" footnote="Off by default. Only the senders you authorize can reach Symon. Enabling starts with new messages; old messages are never answered.">
        <div style={{ paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p role="status" style={{ margin: 0, fontSize: 13.5, fontWeight: 300, color: 'var(--t-text)' }}>
            {busy ? 'Reading or saving receiver…' : status ? `${status.enabled ? 'Enabled' : 'Disabled'} · ${STATE_LABELS[status.state]}` : 'Status unavailable'}
          </p>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>
            This Mac must be signed in to Messages. Grant Full Disk Access to o8 in macOS System Settings and allow o8 to control Messages when macOS asks. Permission setup is manual; enabling here does not grant permission.
          </p>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--t-text)' }}>
            Authorized senders (up to 20)
            <textarea aria-label="Authorized Messages senders" rows={3} value={handlesText} disabled={!status || busy || confirm || mutationLocked}
              onChange={(event) => setHandlesText(event.target.value)}
              placeholder="One international phone number or email per line"
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'var(--t-input-bg)', color: 'var(--t-text)', border: '1px solid var(--t-panel-border)', borderRadius: 8, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, fontFamily: 'inherit', fontSize: 12 }} />
          </label>
          {!valid ? <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>Use up to 20 international numbers such as +15555550100, or email addresses.</p> : null}
          {unsupported ? <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>Native Messages replies require macOS. You can still disable a saved receiver.</p> : null}
          {error ? <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>{error}</p> : null}
          {confirm ? (
            <div role="group" aria-label="Confirm native receiver" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text)', lineHeight: 1.5 }}>
                Enable replies to these {handles.length} authorized senders? This disables the existing OpenClaw / CLI iMessage bridge so only one receiver answers. New replies can use your model allowance. macOS permissions still need manual setup.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <RamsButton busy={busy} disabled={mutationLocked || unsupported} onClick={() => { void request({ enabled: true, handles }); }}>Confirm enable</RamsButton>
                <RamsButton variant="ghost" disabled={busy || mutationLocked} onClick={() => setConfirm(false)}>Cancel</RamsButton>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <RamsButton disabled={!status || busy || mutationLocked || (!status.enabled && (unsupported || !valid || !handles.length))}
                onClick={() => { if (status?.enabled) void request({ enabled: false, handles: status.handles }); else setConfirm(true); }}>
                {status?.enabled ? 'Disable receiver' : 'Enable receiver'}
              </RamsButton>
              <RamsButton variant="ghost" disabled={!status || busy || mutationLocked || !valid || !changed || (status.enabled && (unsupported || !handles.length))}
                onClick={() => { if (status?.enabled) setConfirm(true); else void request({ enabled: false, handles }); }}>Save senders</RamsButton>
              <RamsButton variant="ghost" disabled={busy || mutationLocked} onClick={() => { void request(); }}>Refresh status</RamsButton>
            </div>
          )}
        </div>
      </SettingsGroup>
    </section>
  );
}
