import { composerQueueRepoKey, listQueuedComposerSends } from '@/lib/orchestrator/composer-queue';

type Target = { repoPath: string; threadId: string };
const preparing = new Set<string>();
const keyFor = (target: Target) => `${composerQueueRepoKey(target.repoPath)}\0${target.threadId}`;

export function immediateComposerSendPending(target: Target): boolean {
  return preparing.has(keyFor(target));
}

/** Reserve before asynchronous preparation; another window cannot overtake saved work. */
export async function withImmediateComposerSend(target: Target, send: () => Promise<void>): Promise<void> {
  const key = keyFor(target);
  if (preparing.has(key)) throw new Error('This chat is preparing another message. Use Send next.');
  preparing.add(key);
  try {
    if ((await listQueuedComposerSends(target)).length) throw new Error('This chat has saved messages ahead of this one. Use Send next or remove the held message.');
    await send();
  } finally { preparing.delete(key); }
}

export function orchestratorContinuationAbortKey(repoPath: string, backend: string, agent: string, threadId: string | null): string {
  return `${composerQueueRepoKey(repoPath)}::${backend}::${agent}::${threadId ?? ''}`;
}
