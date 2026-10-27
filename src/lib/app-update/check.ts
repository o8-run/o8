'use client';

import type { Update } from '@tauri-apps/plugin-updater';
import { acceptNativeUpdateCheck, rememberUpdateCheck, type UpdateCheckTicket } from './check-order';
export type CheckedUpdate = Update & UpdateCheckTicket & { installExits: boolean };

/** All desktop checks share the native timeout, privacy, and fallback policy. */
export async function check(): Promise<CheckedUpdate | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const ticket = await invoke<UpdateCheckTicket>('begin_update_check');
  if (!rememberUpdateCheck(ticket)) return null;
  const reportContext = { checkedAt: new Date().toISOString(), ...ticket };
  let metadata: (ConstructorParameters<typeof Update>[0] & { installExits: boolean }) | null;
  try { metadata = await invoke<typeof metadata>('check_app_update', { ticket }); }
  catch (error) {
    if (!await acceptNativeUpdateCheck(ticket)) return null;
    void report({ ...reportContext, updatePending: false, checkOutcome: 'failed', checkError: String(error) });
    throw error;
  }
  if (!await acceptNativeUpdateCheck(ticket)) return null;
  void report({ ...reportContext, updatePending: Boolean(metadata), version: metadata?.version,
    checkOutcome: metadata ? 'available' : 'current', info: metadata });
  if (!metadata) return null;
  const { Update: DesktopUpdate } = await import('@tauri-apps/plugin-updater');
  if (!await acceptNativeUpdateCheck(ticket)) return null;
  return Object.assign(new DesktopUpdate(metadata), ticket, { installExits: metadata.installExits });
}

async function report(state: Record<string, unknown>) {
  await fetch('/api/panel/app/update-state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state) }).catch(() => {});
}
