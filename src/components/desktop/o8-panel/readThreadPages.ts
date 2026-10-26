import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';

/** Commit only a complete inventory; never join pages from different orderings. */
export async function readThreadPages(scope: { projectId: string | null; repoPaths: string[] }, signal: AbortSignal): Promise<TaskPoolTask[]> {
  const query = new URLSearchParams({ limit: '250' });
  scope.repoPaths.forEach(path => query.append('repoPath', path));
  if (scope.projectId) query.set('projectId', scope.projectId);
  const records = new Map<string, TaskPoolTask>();
  let offset = 0;
  for (let page = 0; ; page++) {
    if (page >= 40) throw new Error('More than 10,000 threads are available. Select a repository to narrow this view.');
    query.set('offset', String(offset));
    const response = await ipcFetch(`/api/panel/threads?${query}`, { cache: 'no-store', signal });
    const payload = await response.json() as { tasks?: TaskPoolTask[]; error?: string; nextOffset?: number | null; revision?: string };
    if (!response.ok || !Array.isArray(payload.tasks)) throw new Error(payload.error || 'Unable to load threads.');
    if (page && payload.revision !== query.get('revision')) throw new Error('Threads changed between pages. Refresh this view.');
    payload.tasks.forEach(task => records.set(task.id, task));
    if (payload.nextOffset == null) return [...records.values()];
    if (!payload.revision || !Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset) throw new Error('Thread pagination is incomplete. Refresh this view.');
    query.set('revision', payload.revision);
    offset = payload.nextOffset;
  }
}
