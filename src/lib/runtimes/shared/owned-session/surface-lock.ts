import { realpathSync } from 'node:fs';
import { canonicalWorktreeNamespace } from '@/lib/worktree/root-layout';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';

const key = Symbol.for('o8.ownedSession.surfaceOpChains');
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Promise<unknown>> };
const chains = globals[key] ??= new Map<string, Promise<unknown>>();

function canonicalRoot(root: string): string {
  try { return realpathSync.native(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return canonicalWorktreeNamespace(root);
  }
}

/** A surviving callback and a reloaded store must serialize the same metadata. */
export function withOwnedSurfaceLock<T>(root: string, surfaceId: string, action: () => Promise<T>): Promise<T> {
  const identity = JSON.stringify([canonicalRoot(root), surfaceId]);
  const run = chainOnKey(chains, identity, action);
  const tail = chains.get(identity)!;
  void tail.then(() => {
    if (chains.get(identity) === tail) chains.delete(identity);
  });
  return run;
}
