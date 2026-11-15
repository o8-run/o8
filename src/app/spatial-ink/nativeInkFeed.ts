/**
 * The page side of the native ink panel (experimental `native_spatial_ink`).
 *
 * The web overlay always starts an agent hold: it owns the pointer from the
 * shell's arm. `begin` asks the native panel to cover the same monitor; only
 * an acknowledged arm hands the pointer over (the shell then makes this window
 * click-through). While native owns the hold, a keep-alive frame every
 * cadence renews its lease and brings back the points it captured, so the
 * page still emits the same first-stroke and strokes events. A missed
 * deadline, a refused frame or a lost lease gives the hold back to the web,
 * with every point received so far, before the native lease runs out.
 */
import {
  INK_TIMING, type InkMonitor, type InkPoint, type InkReply,
} from '@/lib/next/spatial-ink';

export interface NormalizedInkPoint { x: number; y: number; t: number }
export type NormalizedStroke = NormalizedInkPoint[];
/** `pending`: arm sent, web still owns. `held`: native let go of the pointer on
 * its own (time bound); nobody captures and the points are kept for handoff. */
export type InkOwner = 'web' | 'pending' | 'native' | 'held' | 'done';

export interface NativeInkDeps {
  /** One request through the route; rejects on its deadline. */
  request(body: Record<string, unknown>): Promise<InkReply>;
  /** Hands the pointer to the native panel or back to this window. */
  pointer(owner: 'native' | 'web', generation: number): void;
  /** The first captured point of the hold (the shell captures the screen then). */
  firstStroke(): void;
  /** Fallback: the web paints these strokes and owns the rest of the hold. */
  adopt(strokes: NormalizedStroke[]): void;
  /** Whether the web drew anything this hold before native acknowledged. */
  webHasInk(): boolean;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface InkArm { generation: number; monitor: InkMonitor; reducedMotion: boolean }

export class NativeInkFeed {
  owner: InkOwner = 'web';
  private session = 0;
  private generation = -1;
  private strokes: NormalizedStroke[] = [];
  private next = 0;
  private firstSent = false;
  private inFlight: Promise<unknown> | null = null;
  private timer: unknown = null;

  constructor(private readonly deps: NativeInkDeps) {}

  /** Whether the native panel draws this hold (the web paints and captures nothing). */
  get nativeOwned() { return this.owner === 'native' || this.owner === 'held'; }

  async begin(arm: InkArm): Promise<void> {
    this.stop();
    const session = ++this.session;
    this.generation = arm.generation;
    this.strokes = [];
    this.next = 0;
    this.firstSent = false;
    this.owner = 'pending';
    const reply = await this.send({ action: 'arm', session, monitor: arm.monitor, reducedMotion: arm.reducedMotion });
    if (session !== this.session || this.owner !== 'pending') {
      // A newer hold, or a teardown, overtook this arm: let the panel go.
      if (reply.native) this.fire({ action: 'release', session, immediate: true });
      return;
    }
    if (!reply.native) { this.owner = 'web'; return; }
    this.absorb(reply);
    if (this.deps.webHasInk()) {
      // The operator started on the web before the panel answered: the web
      // keeps this hold, with anything the panel caught in between.
      this.owner = 'web';
      const rest = await this.send({ action: 'release', session, immediate: true, from: this.next });
      if (session === this.session) { this.absorb(rest); this.adoptAll(); }
      return;
    }
    this.owner = 'native';
    this.deps.pointer('native', this.generation);
    this.schedule();
  }

  /** At `final`: stop capture, let the panel play its flash and fade, and
   * return every stroke for the strokes event. Null when native never owned. */
  async finish(): Promise<NormalizedStroke[] | null> {
    if (!this.nativeOwned) return null;
    const session = this.session;
    this.stop();
    this.owner = 'done';
    await this.inFlight?.catch(() => undefined);
    const reply = await this.send({ action: 'release', session, handoff: true, from: this.next });
    if (session === this.session) this.absorb(reply);
    return this.strokes.filter(stroke => stroke.length > 0);
  }

  /** Terminal event or shell disarm: hide the panel at once. The shell's
   * disarm already makes the web window click-through. */
  release() {
    if (this.owner !== 'pending' && !this.nativeOwned) return;
    this.stop();
    this.fire({ action: 'release', session: this.session, immediate: true });
    this.owner = 'web';
    this.session++;
  }

  private stop() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.stop();
    if (this.owner !== 'native' && this.owner !== 'held') return;
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.keepAlive(); }, INK_TIMING.cadenceMs);
  }

  private async keepAlive() {
    const session = this.session;
    if (!this.nativeOwned) return;
    const reply = await this.send({ action: 'frame', session, from: this.next });
    if (session !== this.session || !this.nativeOwned) return;
    this.absorb(reply);
    if (reply.native) { this.schedule(); return; }
    if (reply.disarmed === 'bound') {
      // The panel's hard time bound: nobody captures for the rest of the hold.
      this.owner = 'held';
      this.stop();
      return;
    }
    this.fallback(session);
  }

  private fallback(session: number) {
    this.owner = 'web';
    this.stop();
    this.deps.pointer('web', this.generation);
    this.adoptAll();
    this.fire({ action: 'release', session, immediate: true });
  }

  private adoptAll() {
    const strokes = this.strokes.filter(stroke => stroke.length > 0);
    this.strokes = [];
    if (strokes.length) this.deps.adopt(strokes);
  }

  /** Points arrive in order from `next`; a lost reply is resent from there. */
  private absorb(reply: InkReply) {
    const points = reply.points ?? [];
    for (const [stroke, x, y, t] of points as InkPoint[]) {
      while (this.strokes.length <= stroke) this.strokes.push([]);
      this.strokes[stroke].push({ x, y, t });
    }
    if (points.length) this.next += points.length;
    if (points.length && !this.firstSent) { this.firstSent = true; this.deps.firstStroke(); }
  }

  private async send(body: Record<string, unknown>): Promise<InkReply> {
    const pending = this.deps.request(body).catch((): InkReply => ({ native: false }));
    this.inFlight = pending;
    const reply = await pending;
    if (this.inFlight === pending) this.inFlight = null;
    return reply;
  }

  private fire(body: Record<string, unknown>) {
    void this.deps.request(body).catch(() => undefined);
  }
}

/** The route request with the ink deadline: a stalled transport rejects in time
 * for the web to take the pointer back before the native lease ends. */
export function postInk(token: () => string): (body: Record<string, unknown>) => Promise<InkReply> {
  return async (body) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetch('/api/next/dictation-pill', {
          method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + token() },
          body: JSON.stringify({ ...body, surface: 'ink', deadline: Date.now() + INK_TIMING.requestMs }), signal: controller.signal,
        }).then(async response => response.ok ? response.json() as Promise<InkReply> : { native: false }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Ink deadline')); }, INK_TIMING.requestMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
}
