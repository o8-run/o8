// Runtime adapters without push events retain the eight-second safety bound.
// Recent changes and explicit signals keep fast polling.
const QUIET_AFTER_MS = 60_000;
const QUIET_POLL_MS = 8_000;
export class HistoryPollCadence {
  private readonly states = new Map<string, { readAt: number; changedAt: number }>();
  due(key: string, now = Date.now()): boolean {
    const state = this.states.get(key);
    return !state || now < state.readAt || now < state.changedAt
      || now - state.changedAt < QUIET_AFTER_MS || now - state.readAt >= QUIET_POLL_MS;
  }
  record(key: string, changed: boolean, now = Date.now()): void {
    const previous = this.states.get(key);
    this.states.set(key, {
      readAt: now,
      changedAt: changed || !previous || now < previous.changedAt ? now : previous.changedAt,
    });
  }
  activity(key: string): void {
    const previous = this.states.get(key);
    this.states.set(key, { readAt: previous?.readAt ?? 0, changedAt: Date.now() });
  }
  retain(keys: Set<string>): void {
    for (const key of this.states.keys()) if (!keys.has(key)) this.states.delete(key);
  }
  async refresh(keys: string[], publish: (key: string) => Promise<unknown>, concurrency: number): Promise<void> {
    const due = keys.filter(key => this.due(key));
    let nextIndex = 0;
    const next = async () => {
      while (nextIndex < due.length) {
        const key = due[nextIndex++];
        await publish(key);
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, due.length) }, next));
  }
}
