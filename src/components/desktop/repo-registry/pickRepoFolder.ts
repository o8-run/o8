'use client';

import { requestPrompt } from '@/components/shared/ConfirmToastHost';

export async function pickRepoFolder(title: string, promptMessage: string, promptFallback = true) {
  let folderPath: string | null = null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, title });
    if (typeof result === 'string') folderPath = result;
  } catch {
    try {
      const response = await fetch('/api/panel/browse-folder', { method: 'POST' });
      const data = await response.json() as { path?: string | null; unavailable?: boolean };
      if (!response.ok || data.unavailable) throw new Error('Folder picker unavailable.');
      if (typeof data.path === 'string') folderPath = data.path;
    } catch (error) {
      if (!promptFallback) throw error;
      const typedPath = await requestPrompt({ title, message: promptMessage, placeholder: '/path/to/folder' });
      folderPath = typedPath?.trim() || null;
    }
  }
  return folderPath || null;
}
