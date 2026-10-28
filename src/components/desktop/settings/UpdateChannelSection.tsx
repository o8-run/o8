'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getUpdateChannelStatus, recheckUpdateChannel, setUpdateChannel, type UpdateChannelStatus } from '@/lib/app-update/channel';
import { SettingsSelect } from './shared';
import { SettingsGroup, SettingsRow } from './grouped';

export function UpdateChannelSection() {
  const [channel, setChannel] = useState<UpdateChannelStatus['channel']>('stable');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateChannelStatus | null>(null);
  const revision = useRef(-1);
  const held = useRef(false);
  const receive = useCallback((value: UpdateChannelStatus) => {
    if (value.revision < revision.current) return;
    revision.current = value.revision;
    if (held.current && value.outcome === 'applied') recheckUpdateChannel();
    held.current = value.outcome !== 'applied';
    setChannel(value.channel); setStatus(value);
  }, []);
  useEffect(() => {
    let alive = true;
    void getUpdateChannelStatus().then(value => {
      if (alive) { receive(value); setReady(true); }
    }).catch(() => { if (alive) setError('Update preferences could not be loaded.'); });
    return () => { alive = false; };
  }, [receive]);

  const waiting = status !== null && status.outcome !== 'applied';
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const timer = setInterval(() => {
      void getUpdateChannelStatus().then(value => { if (alive) receive(value); }).catch(() => {});
    }, 500);
    return () => { alive = false; clearInterval(timer); };
  }, [waiting, receive]);

  async function save(next: string) {
    if (next !== 'stable' && next !== 'beta') return;
    setBusy(true);
    setError(null);
    try { receive(await setUpdateChannel(next)); }
    catch {
      setError('The update channel could not be saved. Try again.');
    } finally { setBusy(false); }
  }

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup header="Updates" footnote="Beta receives new releases first. Returning to Stable keeps your installed version until a newer stable release is available.">
        <SettingsRow
          label="Update channel"
          subtitle={error ?? (channel === 'preview'
            ? 'Preview build. Choose Stable or Beta for future updates.'
            : status?.outcome === 'waiting-for-save'
            ? `${channel === 'stable' ? 'Stable' : 'Beta'} saved. Applying the channel change will retry automatically.`
            : status?.outcome === 'after-install'
            ? `${channel === 'stable' ? 'Stable' : 'Beta'} saved. It will take effect when this installation finishes.`
            : status ? `${channel === 'stable' ? 'Stable' : 'Beta'} is now active.` : 'Choose when to receive new releases')}
          accessory={(
            <label>
              <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>Update channel</span>
              <SettingsSelect value={channel} onChange={next => { void save(next); }} disabled={!ready || busy} width={120}
                options={[...(channel === 'preview' ? [{ value: 'preview', label: 'Preview' }] : []),
                  { value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }]} />
            </label>
          )}
        />
      </SettingsGroup>
    </section>
  );
}
