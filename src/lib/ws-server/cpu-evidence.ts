import { Session } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import { basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recurring } from '@/lib/background-work/ledger';

const MODULE_FILE = fileURLToPath(import.meta.url);

export interface WsCpuFrame { file: string; line: number; functionName: string; sampledMicros: number }
export interface WsCpuEvidence {
  status: 'sampling' | 'sampled' | 'unavailable' | 'stopped';
  windowStartedAt?: number;
  capturedAt?: number;
  sampleCount?: number;
  frames: WsCpuFrame[];
}

/** Only repository module basenames leave the profiler. Never retain raw profiles,
 * absolute paths, URLs, arguments or inspector errors in the health payload.
 * Samples identify overlapping CPU work, not a proven production root cause.
 */
export function summarizeWsCpuProfile(profile: Profiler.Profile, root: string, windowStartedAt: number, capturedAt: number, bundleFile?: string): WsCpuEvidence {
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const frames = new Map<number, WsCpuFrame | null>();
  for (const node of profile.nodes) {
    let file = '';
    let bundled = false;
    try {
      const url = new URL(node.callFrame.url);
      if (url.protocol === 'file:' && !url.search && !url.hash) {
        const path = fileURLToPath(url);
        bundled = path === bundleFile && /[/\\]ws-server(?:-impl)?\.mjs$/.test(path);
        file = bundled ? basename(path) : relative(root, path).replaceAll('\\', '/');
      }
    } catch { /* Native and synthetic frames have no repository location. */ }
    const allowed = bundled || !isAbsolute(file) && !file.split('/').includes('..')
      && /^(?:src|scripts|tests|dist|lib)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?)$/.test(file)
      && !file.split('/').includes('node_modules');
    // Shared process/Git adapters hide the operation that requested the work.
    // Charge their native samples to the next repository caller instead.
    const adapter = ['src/lib/providers/child-process.ts', 'src/lib/providers/store-lock.ts', 'src/lib/lane/lane-git.ts'].includes(file);
    frames.set(node.id, allowed && !adapter ? {
      file: basename(file).slice(0, 96), line: node.callFrame.lineNumber + 1,
      functionName: /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(node.callFrame.functionName) ? node.callFrame.functionName : '(anonymous)',
      sampledMicros: 0,
    } : null);
  }
  const totals = new Map<number, WsCpuFrame>();
  for (const [index, sample] of (profile.samples ?? []).entries()) {
    let id: number | undefined = sample;
    const seen = new Set<number>();
    // A native leaf is charged to its nearest repository caller once, rather
    // than multiplying one sample across every frame in its stack.
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const frame = frames.get(id);
      if (frame) {
        const total = totals.get(id) ?? { ...frame };
        total.sampledMicros += Math.max(0, profile.timeDeltas?.[index] ?? 0);
        totals.set(id, total);
        break;
      }
      id = parents.get(id);
    }
  }
  return { status: 'sampled', windowStartedAt, capturedAt, sampleCount: profile.samples?.length ?? 0,
    frames: [...totals.values()].sort((a, b) => b.sampledMicros - a.sampledMicros).slice(0, 8) };
}

/** Low-frequency sampling, rotated every 15 seconds (plus any loop stall).
 * Only one profile exists at a time; summaries contain at most eight frames.
 */
export class WsCpuSampler {
  private readonly session: Session;
  private operation: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private enabled = false;
  private windowStartedAt = 0;
  private evidence: WsCpuEvidence = { status: 'sampling', frames: [] };
  private previous: WsCpuEvidence | null = null;

  constructor(private readonly root = process.cwd(), session?: Session) { this.session = session ?? new Session(); }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.evidence = { status: 'sampling', frames: [] };
    this.operation = this.operation.then(async () => {
      try {
        this.session.connect();
        await this.session.post('Profiler.enable');
        await this.session.post('Profiler.setSamplingInterval', { interval: 10_000 });
        await this.session.post('Profiler.start');
        this.windowStartedAt = Date.now();
        this.enabled = true;
      } catch { this.unavailable(); }
    });
    this.timer = recurring('cpu-evidence', () => { void this.rotate(false); }, 15_000);
    this.timer.unref();
  }

  getEvidence(): WsCpuEvidence { return { ...this.evidence, frames: this.evidence.frames.map((frame) => ({ ...frame })) }; }

  capture(since = Date.now()): Promise<WsCpuEvidence> { return this.rotate(true, since); }

  private rotate(retain: boolean, since = Date.now()): Promise<WsCpuEvidence> {
    let result = this.getEvidence();
    this.operation = this.operation.then(async () => {
      if (!this.active || !this.enabled) { result = this.getEvidence(); return; }
      try {
        const { profile } = await this.session.post('Profiler.stop');
        result = summarizeWsCpuProfile(profile, this.root, this.windowStartedAt, Date.now(), MODULE_FILE);
        if (retain) {
          // The periodic timer may run first after the same stall. Keep its
          // bounded summary only if that window overlaps this delayed gap.
          if (this.previous && this.previous.capturedAt! >= since) {
            const frames = new Map<string, WsCpuFrame>();
            for (const frame of [...this.previous.frames, ...result.frames]) {
              const key = `${frame.file}:${frame.line}:${frame.functionName}`;
              const total = frames.get(key) ?? { ...frame, sampledMicros: 0 };
              total.sampledMicros += frame.sampledMicros;
              frames.set(key, total);
            }
            result = { ...result, windowStartedAt: this.previous.windowStartedAt,
              sampleCount: (result.sampleCount ?? 0) + (this.previous.sampleCount ?? 0),
              frames: [...frames.values()].sort((a, b) => b.sampledMicros - a.sampledMicros).slice(0, 8) };
          }
          this.evidence = result;
        } else this.previous = result;
        await this.session.post('Profiler.start');
        this.windowStartedAt = Date.now();
      } catch { this.unavailable(); result = this.getEvidence(); }
    });
    return this.operation.then(() => result);
  }

  private unavailable(): void {
    this.enabled = false;
    this.previous = null;
    this.evidence = { status: 'unavailable', frames: [] };
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.session.disconnect(); } catch { /* Already disconnected. */ }
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.operation = this.operation.then(async () => {
      try { if (this.enabled) await this.session.post('Profiler.stop'); } catch { /* Shutdown must not throw. */ }
      try { this.session.disconnect(); } catch { /* Already disconnected. */ }
      this.enabled = false;
      this.previous = null;
      this.evidence = { status: 'stopped', frames: [] };
    });
    await this.operation;
  }
}
