'use client';

import { useEffect, useState } from 'react';
import { getUpdateChannel, setUpdateChannel, type UpdateChannel } from '@/lib/app-update/channel';
import { SettingsSelect } from './shared';
import { SettingsGroup, SettingsRow } from './grouped';

export function UpdateChannelSection() {
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getUpdateChannel().then(value => {
      if (alive) { setChannel(value); setReady(true); }
    }).catch(() => { if (alive) setError('Update preferences could not be loaded.'); });
    return () => { alive = false; };
  }, []);

  async function save(next: string) {
    if (next !== 'stable' && next !== 'beta') return;
    setBusy(true);
    setError(null);
    try { setChannel(await setUpdateChannel(next)); }
    catch {
      // Saving may have succeeded even if the immediate update check failed.
      setChannel(await getUpdateChannel().catch(() => channel));
      setError('The update check could not finish. Retry from Updates.');
    } finally { setBusy(false); }
  }

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup header="Updates" footnote="Beta receives new releases first. Returning to Stable keeps your installed version until a newer stable release is available.">
        <SettingsRow
          label="Update channel"
          subtitle={error ?? 'Choose when to receive new releases'}
          accessory={(
            <label>
              <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>Update channel</span>
              <SettingsSelect value={channel} onChange={next => { void save(next); }} disabled={!ready || busy} width={120}
                options={[{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }]} />
            </label>
          )}
        />
      </SettingsGroup>
    </section>
  );
}
