import type { ParsedRunLog } from './types';

interface RunArtifacts {
  key: string;
  stdoutRaw: string | null;
  stderrRaw: string | null;
  parsed: ParsedRunLog;
}

/** Serialized logs detach previews from large source strings and bound all retained bytes. */
export class RunArtifactCache {
  private readonly entries = new Map<string, { payload: Buffer; bytes: number; expiresAt: number }>();
  private bytes = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly ttlMs = 60_000;

  constructor(private readonly maxBytes = 8 * 1024 * 1024, private readonly maxEntries = 48) {}

  private delete(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(id);
    }
  }

  get(id: string): RunArtifacts | undefined {
    this.expire();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.expiresAt = Date.now() + this.ttlMs;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return JSON.parse(entry.payload.toString('utf8')) as RunArtifacts;
  }

  set(id: string, value: RunArtifacts): RunArtifacts {
    this.expire();
    this.delete(id);
    const json = JSON.stringify(value);
    // First-read callers can retain previews too, so detach before returning.
    const detached = JSON.parse(json) as RunArtifacts;
    const payload = Buffer.from(json, 'utf8');
    const bytes = payload.byteLength + 2 * id.length + 256;
    if (bytes > this.maxBytes) return detached;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(id, { payload, bytes, expiresAt: Date.now() + this.ttlMs });
    this.bytes += bytes;
    if (!this.expiryTimer) this.scheduleExpiry();
    return detached;
  }

  private scheduleExpiry(): void {
    const next = Math.min(...[...this.entries.values()].map(entry => entry.expiresAt));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.expire();
      if (this.entries.size) this.scheduleExpiry();
    }, Math.max(1, next - Date.now()));
    this.expiryTimer.unref();
  }
}
