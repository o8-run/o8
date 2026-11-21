/**
 * Queue-change signals for the composer queue executor. o8d owns the queue and
 * sends a commit notice over the producer socket whenever a row is added,
 * promoted, cancelled or held; each listening heartbeat checks the queue at once.
 */
const listeners = new Set<() => void>();

export function onComposerQueueSignal(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function signalComposerQueueChange(): void {
  for (const listener of listeners) listener();
}
