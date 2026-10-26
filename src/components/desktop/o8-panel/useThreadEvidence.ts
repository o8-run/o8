'use client';
import { useEffect, useState } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import type { ThreadEvidence } from '@/lib/threads/types';
export function useThreadEvidence(task: TaskPoolTask, active: boolean, revision: number) {
  const key = JSON.stringify([task.id, task.repoPath, revision]);
  const [snapshot, setSnapshot] = useState<{ key: string; evidence?: ThreadEvidence; error?: string } | null>(null);
  useEffect(() => {
    if (!active || document.visibilityState === 'hidden' || !task.repoPath || !task.thread) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ taskId: task.id, repoPath: task.repoPath });
    void ipcFetch(`/api/panel/threads?${query}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const payload = await response.json() as { task?: TaskPoolTask; error?: string };
      if (!response.ok) throw new Error(payload.error || 'Thread evidence is unavailable.');
      if (!payload.task?.thread || payload.task.id !== task.id || payload.task.repoPath !== task.repoPath) throw new Error('Thread evidence identity did not match. Refresh this thread.');
      if (!controller.signal.aborted) setSnapshot({ key, evidence: payload.task.thread });
    }).catch(error => { if (!controller.signal.aborted) setSnapshot({ key, error: error instanceof Error ? error.message : 'Thread evidence is unavailable.' }); });
    return () => controller.abort();
  }, [active, key, task.id, task.repoPath, task.thread]);
  return { evidence: snapshot?.key === key && snapshot.evidence ? snapshot.evidence : task.thread, error: snapshot?.key === key ? snapshot.error : null };
}
