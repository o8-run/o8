import { AsyncLocalStorage } from 'node:async_hooks';
import type { OwnedSessionRecord } from './types';

/** Restrictive request-local fence, checked inside the owned session's existing mutation lock. */
const fence = new AsyncLocalStorage<{
  active: boolean;
  surfaceId: string;
  validate: (session: OwnedSessionRecord | null) => Promise<void>;
}>();

export function withOwnedActionFence<T>(surfaceId: string, validate: (session: OwnedSessionRecord | null) => Promise<void>, operation: () => Promise<T>): Promise<T> {
  const context = { active: true, surfaceId, validate };
  return fence.run(context, async () => {
    try { return await operation(); } finally { context.active = false; }
  });
}

export async function assertOwnedActionFence(surfaceId: string, session: OwnedSessionRecord | null): Promise<void> {
  const current = fence.getStore();
  if (!current?.active) return;
  if (current.surfaceId !== surfaceId) throw new Error('The reviewed terminal session changed.');
  await current.validate(session);
}
