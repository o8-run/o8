import { AsyncLocalStorage } from 'node:async_hooks';
import { withResourceLease } from '@/lib/leases/resource-lease-guard';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';

const chains = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Task transitions and every owned resume share the existing durable lease. */
export async function withStandingLaneMutation<T>(laneId: string, action: () => Promise<T>): Promise<T> {
  if (held.getStore()?.has(laneId)) return action();
  return chainOnKey(chains, laneId, async () => {
    const result = await withResourceLease({ resource: `standing-lane:${laneId}`,
      owner: { id: `standing-lane:${process.pid}`, label: 'Standing worker lane', pid: process.pid },
      actor: 'system:standing-lane', maxWaitMs: 15000 }, () => held.run(new Set([...(held.getStore() ?? []), laneId]), action));
    if (result.state !== 'completed') throw new Error(result.refusal.message);
    return result.value;
  });
}
