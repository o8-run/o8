'use client';

export type UpdateChannel = 'stable' | 'beta';

export async function getUpdateChannel(): Promise<UpdateChannel> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<UpdateChannel>('get_update_channel');
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<UpdateChannel> {
  const { invoke } = await import('@tauri-apps/api/core');
  const saved = await invoke<UpdateChannel>('set_update_channel', { channel });
  const { check } = await import('./check');
  await check(saved);
  return saved;
}
