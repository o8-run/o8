/** Best-effort speech-correlated inactivity, not a speech detector or billing ledger. */
export interface LiveActivityUsage {
  providerConnectedSeconds: number | null;
  providerUsageFinal: boolean;
  recognizedSpeechSecondsDiagnostic: number;
}
export class LiveActivity {
  private lastSpeech: number;
  private lastNarration = -Infinity;
  private seen = new Set<string>();
  readonly idleMs: number;
  private inputEnd = 0;
  private outputEnd = 0;
  private lastInputSpeech = -Infinity;
  private lastOutputSpeech = -Infinity;
  private lastAudibleOutput = -Infinity;
  private intervals: Array<[number, number]> = [];
  private providerSeconds: number | null = null;
  private providerFinal = false;
  private ready = false;
  constructor(private readonly started: number, idleMs = 30_000) {
    this.lastSpeech = started;
    this.idleMs = Number.isFinite(idleMs) ? Math.min(60_000, Math.max(15_000, idleMs)) : 30_000;
  }
  markReady(now: number) {
    if (!this.ready) { this.ready = true; this.lastSpeech = Math.max(this.lastSpeech, now); }
  }
  narrationDelivered(now: number) { this.lastNarration = Math.max(this.lastNarration, now); }
  observe(event: Record<string, unknown>, now: number) {
    const usage = event.usage as { seconds?: unknown } | undefined;
    if (!this.providerFinal && (event.type === 'session.usage.updated' || event.type === 'session.closed')
      && typeof usage?.seconds === 'number' && Number.isFinite(usage.seconds) && usage.seconds >= (this.providerSeconds ?? 0)) {
      this.providerSeconds = usage.seconds; this.providerFinal = event.type === 'session.closed';
    }
    const input = event.type === 'session.input_transcript.delta';
    if (!input && event.type !== 'session.output_transcript.delta') return;
    if (typeof event.event_id !== 'string' || this.seen.has(event.event_id) || this.seen.size >= 4096) return;
    if (typeof event.delta !== 'string' || !/[\p{L}\p{N}]/u.test(event.delta)
      || typeof event.start_ms !== 'number' || typeof event.end_ms !== 'number'
      || !Number.isSafeInteger(event.start_ms) || !Number.isSafeInteger(event.end_ms)
      || event.start_ms < 0 || event.end_ms <= event.start_ms) return;
    this.seen.add(event.event_id);
    const elapsed = Math.max(0, now - this.started);
    // Reject future intervals rather than letting malformed timestamps keep a session alive.
    if (event.end_ms > elapsed) return;
    this.intervals.push([event.start_ms, event.end_ms]);
    this.intervals.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const interval of this.intervals) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    this.intervals = merged;
    const previousEnd = input ? this.inputEnd : this.outputEnd;
    if (input) this.inputEnd = Math.max(this.inputEnd, event.end_ms);
    else this.outputEnd = Math.max(this.outputEnd, event.end_ms);
    // Replayed/stale fragments may improve duration evidence, but never buy fresh idle time.
    if (event.end_ms <= previousEnd || elapsed - event.end_ms > 10_000) return;
    const speechAt = this.started + event.end_ms;
    this.lastSpeech = Math.max(this.lastSpeech, speechAt);
    if (input) this.lastInputSpeech = speechAt; else this.lastOutputSpeech = speechAt;
  }
  shouldClose(now: number, inputEnergy: boolean, outputAudible: boolean): boolean {
    if (outputAudible) this.lastAudibleOutput = now;
    if (now - Math.max(this.lastSpeech, this.lastNarration) < this.idleMs) return false;
    // Energy only corroborates recognized speech for a finite grace; noise never resets a clock.
    if (inputEnergy && now - this.lastInputSpeech < this.idleMs + 5_000) return false;
    if (now - this.lastAudibleOutput < 1_000 && now - this.lastOutputSpeech < this.idleMs + 15_000) return false;
    return true;
  }
  get usage(): LiveActivityUsage {
    return { providerConnectedSeconds: this.providerSeconds, providerUsageFinal: this.providerFinal,
      recognizedSpeechSecondsDiagnostic: this.intervals.reduce((sum, [start, end]) => sum + end - start, 0) / 1000 };
  }
}
