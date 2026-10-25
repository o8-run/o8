import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorktreeRootLayout } from './root-layout';

export const WARM_ENTRY_BYTES = 4 * 1024 ** 3;
export const WARM_ENTRY_COUNT = 2;

/** An arbitrary installer requires a kernel-enforced filesystem bound, not a poll. */
export async function assertWarmFilesystemBudget(repoRoot: string): Promise<void> {
  let candidate = resolveWorktreeRootLayout(repoRoot).primaryBase;
  for (;;) {
    try {
      const volume = await statfs(candidate);
      const capacity = Number(volume.blocks) * Number(volume.bsize);
      if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > WARM_ENTRY_BYTES) throw new Error('Warm preparation requires a bounded filesystem of at most four GiB.');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === path.dirname(candidate)) throw error;
      candidate = path.dirname(candidate);
    }
  }
}
