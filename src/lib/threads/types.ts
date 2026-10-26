import type { TaskPoolTask } from '@/lib/tasks/pool';

export type ThreadState = 'waiting' | 'review' | 'working' | 'resolved';
export interface ThreadWorker {
  sessionKey: string; name: string; runtime: string; model: string | null; status: string;
  tokens: number | null; tools: number | null; toolsTruncated: boolean; stage: string | null;
}
export interface ThreadEvidence {
  kind: 'packet' | 'lane' | 'session' | 'mission' | 'inbox' | 'approval' | 'handoff'; state: ThreadState;
  sessionKey: string | null; childIds: string[]; observedAt: string;
  requirements: Array<{ id: string; text: string; covered: boolean; verification: string; head: string | null }>;
  artifacts: Array<{ id: string; title: string; kind: string; href: string; interactive?: boolean }>;
  merges: Array<{ id: string; title: string; url: string; state: string; checks: 'pass' | 'fail' | 'running' | 'unknown'; head: string | null }>;
  workers: ThreadWorker[]; stages: Array<{ name: string; done: number; total: number }>;
  history: Array<{ id: string; at: string; label: string }>;
  truncated: boolean;
}
export type ProjectThread = Omit<TaskPoolTask, 'runtime' | 'status'> & { runtime: string; status: string; thread: ThreadEvidence };
export interface ProjectThreads {
  revision: string; schema: 'o8/project.threads/v1'; tasks: ProjectThread[];
  counts: Record<ThreadState, number>; offset: number; nextOffset: number | null; observedAt: string;
}
