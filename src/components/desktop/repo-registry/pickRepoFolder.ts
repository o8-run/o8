'use client';

import { requestPrompt } from '@/components/shared/ConfirmToastHost';

export async function pickRepoFolder(title: string, promptMessage: string) {
  let folderPath: string | null = null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, title });
    if (typeof result === 'string') folderPath = result;
  } catch {
    try {
      const response = await fetch('/api/panel/browse-folder', { method: 'POST' });
      const data = await response.json() as { path?: string | null; unavailable?: boolean };
      // No picker program on this host: fall through to typed path entry.
      if (data.unavailable) throw new Error('native picker unavailable');
      if (typeof data.path === 'string') folderPath = data.path;
    } catch {
      folderPath = await requestPrompt({ title, message: promptMessage, placeholder: '/path/to/folder' });
    }
  }
  const trimmedPath = folderPath?.trim() ?? '';
  return trimmedPath || null;
}
