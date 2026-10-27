'use client';
import { invalidateUpdateChecks } from './check-order';
export type UpdateChannel = 'stable' | 'beta';
export interface UpdateChannelStatus {
  channel: UpdateChannel;
  outcome: 'applied' | 'after-install' | 'waiting-for-save';
  revision: number;
}
export async function getUpdateChannel(): Promise<UpdateChannel> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<UpdateChannel>('read_update_channel');
}
export async function getUpdateChannelStatus(): Promise<UpdateChannelStatus> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<UpdateChannelStatus>('read_update_channel_status');
}
export function recheckUpdateChannel(): void {
  invalidateUpdateChecks();
  void import('./check').then(({ check }) => check()).catch(() => {});
}
export async function setUpdateChannel(channel: UpdateChannel): Promise<UpdateChannelStatus> {
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<UpdateChannelStatus>('set_update_channel', { channel });
  invalidateUpdateChecks();
  if (result.outcome === 'applied') recheckUpdateChannel();
  return result;
}
