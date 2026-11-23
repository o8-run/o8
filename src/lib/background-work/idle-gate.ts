/**
 * Idle gate: background loops registered through the ledger pause while the
 * server is at rest and run once, at once, when it wakes.
 *
 * At rest means all of: no agent session running or launching, no recent work
 * progress (a launch or other change the headless tick reports), and no client
 * activity for IDLE_AFTER_MS. Client activity is any request or client message,
 * except the server's own requests (`x-o8-background: 1`) and a read that
 * carries `x-o8-foreground: 0` (a window behind another app).
 *
 * A loop is "idle-safe" unless it is registered as "always" with a written
 * reason. An idle-safe loop may also declare a `busy` check: while it returns
 * true (queued work, a job outstanding elsewhere) the loop keeps running at
 * rest, and pauses again once it has nothing left.
 *
 * Entering rest runs every idle-safe loop once more if it has not run since the
 * last session ended or the last client activity, so nothing is left unsaved
 * or half-reaped before the loops pause. `O8_IDLE_GATE=0` turns the gate off.
 */
export type LoopClass = 'idle-safe' | 'always';

export interface IdleGateSignals {
  /**
   * Truthy while any agent or worker session is running or launching. A string
   * names what is live (for the gate's statistics); `true` is an unnamed one.
   */
  liveSessions: () => boolean | string | null;
}

/** What kept the gate awake, for the background ledger and `bench:idle`. */
export interface IdleGateStats {
  awakeMs: number;
  restingMs: number;
  /** Activity that woke or kept the gate awake, by source (a request is `METHOD /path`). */
  activity: Record<string, number>;
  /** Requests that did not count: the server's own, and reads from a window behind another app. */
  ignored: Record<string, number>;
  /** Session checks that found something live, by what was live. */
  live: Record<string, number>;
}

const STAT_KEYS_MAX = 60;
const stats: IdleGateStats = { awakeMs: 0, restingMs: 0, activity: {}, ignored: {}, live: {} };
let statsAt = Date.now();

function count(map: Record<string, number>, key: string): void {
  if (map[key] === undefined && Object.keys(map).length >= STAT_KEYS_MAX) key = 'other';
  map[key] = (map[key] ?? 0) + 1;
}

/** A request path without its query string, with long ids folded so the counts stay few. */
function requestKey(method: string | undefined, path: string | undefined): string {
  const bare = (path ?? '').split('?')[0].replace(/\/[^/]{24,}/g, '/:id');
  return `${method ?? '?'} ${bare || '/'}`;
}

export function idleGateStats(now = Date.now()): IdleGateStats {
  accrue(now);
  return { awakeMs: stats.awakeMs, restingMs: stats.restingMs,
    activity: { ...stats.activity }, ignored: { ...stats.ignored }, live: { ...stats.live } };
}

function accrue(now: number): void {
  const elapsed = Math.max(0, now - statsAt);
  statsAt = now;
  if (resting) stats.restingMs += elapsed;
  else stats.awakeMs += elapsed;
}

/** Headers for a request the server sends to itself, so it never counts as client activity. */
export const SELF_REQUEST_HEADERS = Object.freeze({ 'x-o8-background': '1' });

export const IDLE_AFTER_MS = 60_000;
export const CHECK_EVERY_MS = 5_000;
const SESSION_CACHE_MS = 2_000;

interface Loop {
  run: () => void;
  lastRunAt: number;
}

const loops = new Map<string, Loop>();
const paused = new Set<string>();
let signals: IdleGateSignals | null = null;
let lastActivityAt = Date.now();
let sessionsCheckedAt = 0;
let sessionsLive = false;
let sessionEndedAt = 0;
let resting = false;
let checker: NodeJS.Timeout | null = null;

export function idleGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.O8_IDLE_GATE !== '0';
}

function liveSessions(now: number): boolean {
  if (!signals) return true;
  if (now - sessionsCheckedAt >= SESSION_CACHE_MS) {
    sessionsCheckedAt = now;
    const wasLive = sessionsLive;
    let live: boolean | string | null;
    try { live = signals.liveSessions(); } catch { live = 'session check failed'; }
    sessionsLive = Boolean(live);
    if (live) count(stats.live, typeof live === 'string' ? live : 'unnamed');
    if (wasLive && !sessionsLive) sessionEndedAt = now;
  }
  return sessionsLive;
}

/** Whether idle-safe loops should skip their next run. Never true before signals are installed. */
export function atRest(now = Date.now()): boolean {
  if (!idleGateEnabled() || !signals) return false;
  // Always read the session signal, so the moment the last session ends is recorded.
  const live = liveSessions(now);
  return now - lastActivityAt >= IDLE_AFTER_MS && !live;
}

function runLoop(name: string, now: number): void {
  const loop = loops.get(name);
  if (!loop) return;
  loop.lastRunAt = now;
  try { loop.run(); } catch { /* each loop reports its own failures */ }
}

/** Run every paused loop once and clear the pause, so nothing is stale on wake. */
function wake(now: number): void {
  resting = false;
  const names = [...paused];
  paused.clear();
  for (const name of names) runLoop(name, now);
}

/** The last pass before sleeping: every loop that has not run since things went quiet runs once. */
function enterRest(now: number): void {
  resting = true;
  const quietSince = Math.max(sessionEndedAt, lastActivityAt);
  for (const [name, loop] of loops) {
    if (loop.lastRunAt < quietSince) runLoop(name, now);
  }
}

function evaluate(now = Date.now()): void {
  accrue(now);
  const rest = atRest(now);
  if (resting && !rest) wake(now);
  else if (!resting && rest) enterRest(now);
}

/** A client request, client message, launch or other change: wake now if resting. */
export function noteActivity(now = Date.now(), source = 'activity'): void {
  accrue(now);
  count(stats.activity, source);
  lastActivityAt = now;
  if (resting) wake(now);
}

/** Classify one HTTP request: the server's own requests and a background window's reads do not count. */
export function noteRequest(headers: Record<string, string | string[] | undefined>, method: string | undefined, path?: string): void {
  if (headers['x-o8-background'] === '1') { count(stats.ignored, 'server self-request'); return; }
  const foreground = headers['x-o8-foreground'];
  const header = Array.isArray(foreground) ? foreground[0] : foreground;
  if ((method === 'GET' || method === 'HEAD') && header === '0') { count(stats.ignored, 'background window read'); return; }
  noteActivity(Date.now(), requestKey(method, path));
}

/**
 * Called by an idle-safe loop's timer. Returns true when the run should go
 * ahead; when the server is at rest and the loop is not busy it records the
 * loop as paused instead.
 */
export function admitRun(name: string, run: () => void, busy?: () => boolean): boolean {
  const now = Date.now();
  const loop = loops.get(name);
  if (loop) loop.run = run;
  else loops.set(name, { run, lastRunAt: 0 });
  evaluate(now);
  let admitted = !resting;
  if (!admitted && busy) {
    try { admitted = busy(); } catch { admitted = true; }
  }
  if (admitted) {
    loops.get(name)!.lastRunAt = now;
    paused.delete(name);
    return true;
  }
  paused.add(name);
  return false;
}

/** Install the session signal and start the wake check. Idempotent. */
export function startIdleGate(input: IdleGateSignals): void {
  signals = input;
  if (checker || !idleGateEnabled()) return;
  checker = setInterval(() => evaluate(), CHECK_EVERY_MS);
  checker.unref();
}

/** Tests only. */
export function resetIdleGate(): void {
  if (checker) clearInterval(checker);
  checker = null;
  signals = null;
  loops.clear();
  paused.clear();
  resting = false;
  lastActivityAt = Date.now();
  sessionsCheckedAt = 0;
  sessionsLive = false;
  sessionEndedAt = 0;
  Object.assign(stats, { awakeMs: 0, restingMs: 0, activity: {}, ignored: {}, live: {} });
  statsAt = Date.now();
}

export function pausedLoopNames(): string[] {
  return [...paused].sort();
}
