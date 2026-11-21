/**
 * Event-loop lag watchdog for the ws-server process.
 *
 * ws-server multiplexes every mobile realtime client, PTY data pump, and
 * orchestrator stream on a single event loop (port 3002). Incident #1498: a
 * sync FS walk wedged the loop for minutes and every client froze silently.
 * This watchdog measures loop lag with the classic timer-drift method — a
 * fixed-cadence timer whose callback should fire every `intervalMs`; the amount
 * it fires *late* is the time the loop spent blocked. On sustained lag it logs
 * `[ws-health]` and keeps rolling counters queryable in-process (exposed on the
 * existing `/health` HTTP endpoint).
 *
 * Opt-in CPU sampling (O8_WS_CPU_EVIDENCE=1) rotates every 15 seconds; only
 * bounded module/function summaries are retained when lag is observed (at most
 * one capture per 30 seconds). Fixed handler labels are always available.
 * Raw profiles are discarded. Lag and wedge detection always remain active.
 */

import { wsHandlersSince, wsInFlightHandlers, type WsHealthHandler } from './handler-activity';
import { performance } from 'node:perf_hooks';
import { WsCpuSampler, type WsCpuEvidence } from './cpu-evidence';
import { recurring } from '@/lib/background-work/ledger';

export interface WsHealthStats {
  /** Wall-clock time the watchdog started sampling (epoch ms). */
  startedAt: number;
  /** Total samples taken since start. */
  samples: number;
  /** Lag of the most recent sample (ms, floored at 0). */
  lastSampleLagMs: number;
  /** Worst single-sample lag observed since start (ms). */
  maxLagMs: number;
  /** Consecutive samples currently over threshold (resets on a healthy one). */
  consecutiveHighSamples: number;
  /** Number of distinct wedge episodes detected (one per onset). */
  wedgeCount: number;
  /** Epoch ms of the last wedge onset, or null if never wedged. */
  lastWedgeAt: number | null;
  /** Lag (ms) recorded at the last wedge onset. */
  lastWedgeLagMs: number | null;
  /** Whether the loop is currently inside a wedge episode. */
  wedged: boolean;
  intervalMs: number;
  thresholdMs: number;
  sustainedSamples: number;
  /** Last lag capture; sampled overlap is diagnostic evidence, not causality. */
  cpuEvidence: WsCpuEvidence;
  inFlightHandlers: WsHealthHandler[];
  lastLagHandlers: WsHealthHandler[];
  lastWedgeHandlers: WsHealthHandler[];
}

export interface WsWatchdogOptions {
  /** Sampling cadence in ms. Default 1000. */
  intervalMs?: number;
  /** A single sample above this lag (ms) counts as "high". Default 250. */
  thresholdMs?: number;
  /** Consecutive high samples that constitute a wedge. Default 3. */
  sustainedSamples?: number;
  /** Monotonic clock (ms). Default `performance.now`. Injectable for tests. */
  nowMs?: () => number;
  /** Wall clock (epoch ms). Default `Date.now`. Injectable for tests. */
  wallClock?: () => number;
  /** setInterval-like scheduler. Default global setInterval. Injectable for tests. */
  scheduler?: (cb: () => void, ms: number) => { unref?: () => void };
  /** clearInterval-like canceller. Default global clearInterval. */
  cancelScheduler?: (handle: unknown) => void;
  /** Log sink. Default console.log. */
  log?: (msg: string) => void;
  /** Override the sampler; otherwise profiling requires O8_WS_CPU_EVIDENCE=1. */
  cpuSampler?: Pick<WsCpuSampler, 'start' | 'stop' | 'capture' | 'getEvidence'> | false;
}

export class WsWatchdog {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly sustainedSamples: number;
  private readonly nowMs: () => number;
  private readonly wallClock: () => number;
  private readonly scheduler: (cb: () => void, ms: number) => { unref?: () => void };
  private readonly cancelScheduler: (handle: unknown) => void;
  private readonly log: (msg: string) => void;
  private readonly cpuSampler: WsWatchdogOptions['cpuSampler'];
  private capturePending = false;
  private lastCaptureAt = -Infinity;

  private timer: { unref?: () => void } | null = null;
  private expected = 0;

  private stats: WsHealthStats;

  constructor(opts: WsWatchdogOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.thresholdMs = opts.thresholdMs ?? 250;
    this.sustainedSamples = opts.sustainedSamples ?? 3;
    this.nowMs = opts.nowMs ?? (() => performance.now());
    this.wallClock = opts.wallClock ?? (() => Date.now());
    this.scheduler = opts.scheduler ?? ((cb, ms) => recurring('ws-health-watchdog', cb, ms));
    this.cancelScheduler = opts.cancelScheduler ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.log = opts.log ?? ((m) => console.log(m));
    this.cpuSampler = opts.cpuSampler ?? (process.env.O8_WS_CPU_EVIDENCE === '1' ? new WsCpuSampler() : false);

    this.stats = {
      startedAt: this.wallClock(),
      samples: 0,
      lastSampleLagMs: 0,
      maxLagMs: 0,
      consecutiveHighSamples: 0,
      wedgeCount: 0,
      lastWedgeAt: null,
      lastWedgeLagMs: null,
      wedged: false,
      intervalMs: this.intervalMs,
      thresholdMs: this.thresholdMs,
      sustainedSamples: this.sustainedSamples,
      inFlightHandlers: [],
      lastLagHandlers: [],
      lastWedgeHandlers: [],
      cpuEvidence: { status: this.cpuSampler ? 'sampling' : 'unavailable', frames: [] },
    };
  }

  start(): void {
    if (this.timer) return;
    if (this.cpuSampler) this.cpuSampler.start();
    this.stats.startedAt = this.wallClock();
    this.expected = this.nowMs() + this.intervalMs;
    this.timer = this.scheduler(() => this.tick(), this.intervalMs);
    // Never keep the process alive on the watchdog alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.cancelScheduler(this.timer);
    this.timer = null;
    if (this.cpuSampler) void this.cpuSampler.stop();
  }

  getStats(): WsHealthStats {
    return { ...this.stats, inFlightHandlers: wsInFlightHandlers(), lastLagHandlers: [...this.stats.lastLagHandlers], lastWedgeHandlers: [...this.stats.lastWedgeHandlers], cpuEvidence: this.cpuSampler ? this.cpuSampler.getEvidence() : this.stats.cpuEvidence };
  }

  /**
   * One sample. Public so tests can drive it deterministically without a real
   * timer, but production only invokes it via the scheduled interval.
   */
  tick(): void {
    const now = this.nowMs();
    const lag = Math.max(0, now - this.expected);
    // Reset the baseline from the actual fire time so lag is measured per-gap
    // and does not accumulate drift across samples.
    this.expected = now + this.intervalMs;

    const s = this.stats;
    s.samples += 1;
    s.lastSampleLagMs = lag;
    if (lag > s.maxLagMs) s.maxLagMs = lag;

    if (lag > this.thresholdMs) {
      // Capture the first delayed gap too: one long blocking call need not
      // produce three consecutive late timers. Wedge classification is unchanged.
      s.lastLagHandlers = [...new Set([
        ...(s.consecutiveHighSamples > 0 ? s.lastLagHandlers : []),
        ...wsHandlersSince(now - lag - this.intervalMs),
      ])].sort();
      if (this.cpuSampler && !this.capturePending && this.wallClock() - this.lastCaptureAt >= 30_000) {
        this.lastCaptureAt = this.wallClock();
        this.capturePending = true;
        void this.cpuSampler.capture(this.wallClock() - lag).then((evidence) => {
          if (this.timer) this.log(`[ws-health] lag sample cpuEvidence=${JSON.stringify(evidence)}`);
        }).catch(() => {}).finally(() => { this.capturePending = false; });
      }
      s.consecutiveHighSamples += 1;
      if (s.consecutiveHighSamples >= this.sustainedSamples && !s.wedged) {
        // Wedge onset — log once per episode, not per sample.
        s.wedged = true;
        s.wedgeCount += 1;
        s.lastWedgeAt = this.wallClock();
        s.lastWedgeLagMs = lag;
        s.lastWedgeHandlers = [...s.lastLagHandlers];
        this.log(
          `[ws-health] event-loop wedge detected — lag=${Math.round(lag)}ms ` +
          `(${s.consecutiveHighSamples} consecutive samples >${this.thresholdMs}ms), ` +
          `maxLag=${Math.round(s.maxLagMs)}ms, wedgeCount=${s.wedgeCount}, handlers=${JSON.stringify(s.lastLagHandlers)}`,
        );
      }
    } else {
      if (s.wedged) {
        this.log(
          `[ws-health] event-loop recovered — lastLag=${Math.round(lag)}ms, ` +
          `maxLag=${Math.round(s.maxLagMs)}ms, wedgeCount=${s.wedgeCount}`,
        );
      }
      s.consecutiveHighSamples = 0;
      s.wedged = false;
    }
  }
}
