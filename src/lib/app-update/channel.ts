'use client';
import { invalidateUpdateChecks } from './check-order';
export type UpdateChannel = 'stable' | 'beta';
export async function getUpdateChannel(): Promise<UpdateChannel> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<UpdateChannel>('read_update_channel');
}
export async function setUpdateChannel(channel: UpdateChannel): Promise<UpdateChannel> {
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<UpdateChannel>('set_update_channel', { channel });
  invalidateUpdateChecks();
  const { check } = await import('./check');
  void check().catch(() => {});
  return result;
}
