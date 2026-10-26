'use client';

import type { UpdateChannel } from './channel';
import type { Update } from '@tauri-apps/plugin-updater';
export type CheckedUpdate = Update & { installExits: boolean };

/** All desktop checks share the native timeout, privacy, and fallback policy. */
export async function check(channel?: UpdateChannel): Promise<CheckedUpdate | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  let metadata: (ConstructorParameters<typeof Update>[0] & { installExits: boolean; channel?: UpdateChannel | 'preview' }) | null;
  try { metadata = await invoke<typeof metadata>('check_app_update'); }
  catch (error) {
    void report({ channel, updatePending: false, checkOutcome: 'failed', checkError: String(error) });
    throw error;
  }
  void report({ channel: metadata?.channel ?? channel, updatePending: Boolean(metadata), version: metadata?.version,
    checkOutcome: metadata ? 'available' : 'current', info: metadata });
  if (!metadata) return null;
  const { Update: DesktopUpdate } = await import('@tauri-apps/plugin-updater');
  return Object.assign(new DesktopUpdate(metadata), { installExits: metadata.installExits });
}

async function report(state: Record<string, unknown>) {
  await fetch('/api/panel/app/update-state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...state, checkedAt: new Date().toISOString() }) }).catch(() => {});
}
