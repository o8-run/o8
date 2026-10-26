import type { ProjectThread } from './types';

export type ThreadGrouping = 'A' | 'B' | 'C';
/** Mission containers retain exact child identities; a child is never inferred from its title. */
export function groupThreads(tasks: ProjectThread[], model: ThreadGrouping): ProjectThread[] {
  if (model === 'C') return tasks;
  const missions = tasks.filter(task => task.thread.kind === 'mission');
  if (model === 'A') return missions;
  const children = new Set(missions.flatMap(task => task.thread.childIds));
  return tasks.filter(task => task.thread.kind === 'mission' || !children.has(task.id)
    && (task.thread.kind !== 'session' || task.thread.sessionKey?.startsWith('llm-chat:')) && task.thread.kind !== 'handoff');
}
export interface ThreadReplaySnapshot { at: string; tasks: ProjectThread[]; attentionIds: string[] }
export function replayThreadModels(snapshots: ThreadReplaySnapshot[]) {
  return (['A', 'B', 'C'] as const).map(model => {
    let missedAttention = 0, duplicates = 0, orphans = 0;
    const rowsPerDay: Record<string, number> = {};
    for (const snapshot of snapshots) {
      const rows = groupThreads(snapshot.tasks, model);
      const represented = new Set(rows.flatMap(row => [row.id, ...row.thread.childIds]));
      missedAttention += snapshot.attentionIds.filter(id => !represented.has(id)).length;
      const sessions = rows.filter(row => row.thread.kind !== 'mission').map(row => row.thread.sessionKey).filter(Boolean);
      duplicates += sessions.length - new Set(sessions).size;
      orphans += rows.filter(row => !row.summary && !row.blockedReason && !row.lastEventLabel && !row.thread.history.length && !row.thread.artifacts.length && !row.thread.merges.length).length;
      const day = snapshot.at.slice(0, 10);
      rowsPerDay[day] = (rowsPerDay[day] ?? 0) + rows.length;
    }
    return { model, missedAttention, duplicates, orphans, rowsPerDay };
  });
}
