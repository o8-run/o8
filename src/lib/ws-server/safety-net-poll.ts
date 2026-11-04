const IDLE_MS = 60_000;

type Revision = string | number | undefined;
interface Checkpoint {
  revision: Revision;
  syncedAt: number;
  idleSince: number;
}

/** Successful push/initial reads also satisfy the safety net. */
export class SafetyNetPoll {
  private readonly checkpoints = new WeakMap<object, Checkpoint>();

  due(client: object, revision: Revision, now = Date.now()): boolean {
    const checkpoint = this.checkpoints.get(client);
    if (!checkpoint) return true;
    // A known revision is authoritative; an unobserved revision bypasses idle backoff.
    if (revision !== undefined) return revision !== checkpoint.revision;
    return now - checkpoint.idleSince < IDLE_MS || now - checkpoint.syncedAt >= IDLE_MS;
  }

  record(client: object, revision: Revision, changed: boolean, now = Date.now()): void {
    const previous = this.checkpoints.get(client);
    this.checkpoints.set(client, {
      revision,
      syncedAt: now,
      idleSince: !previous || changed || revision !== previous.revision ? now : previous.idleSince,
    });
  }

  forget(client: object): void {
    this.checkpoints.delete(client);
  }
}

/** Share only concurrent safety reads; event-driven requests keep their own path. */
export function coalesceSafetyNetSync<T>(fetch: (body: Record<string, unknown>) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (body: Record<string, unknown>): Promise<T> => {
    const key = JSON.stringify(body);
    const existing = pending.get(key);
    if (existing) return existing;
    const request = fetch(body).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
