/**
 * Background-work ledger: one place that names every recurring server loop
 * and, when `O8_BACKGROUND_LEDGER=1`, records what each one costs at rest.
 *
 * Per loop name it records runs, main-thread milliseconds (the synchronous
 * part of each run plus every async continuation the run started), the
 * slowest run, child processes spawned by command and their wall time, and
 * whether runs reported a change (a run that resolves to `true` or `false`).
 * With the flag unset the helpers are plain `setInterval` and a direct call,
 * and no hooks are installed.
 */
import { AsyncLocalStorage, createHook, executionAsyncResource } from 'node:async_hooks';
import { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { admitRun, idleGateStats, type LoopClass } from './idle-gate';

export interface LedgerEntry {
  name: string;
  runs: number;
  mainMs: number;
  maxRunMainMs: number;
  wallMs: number;
  children: number;
  childWallMs: number;
  childCommands: Record<string, number>;
  changedRuns: number;
  unchangedRuns: number;
  /** Timer ticks skipped because the server was at rest. */
  pausedTicks: number;
}

interface Run {
  entry: LedgerEntry;
  mainMs: number;
}

const entries = new Map<string, LedgerEntry>();
const registered = new Set<string>();
const context = new AsyncLocalStorage<Run>();
let installed = false;
let active: Run | null = null;
let activeSince = 0;

export function ledgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.O8_BACKGROUND_LEDGER === '1';
}

function entryFor(name: string): LedgerEntry {
  let entry = entries.get(name);
  if (!entry) {
    entry = {
      name, runs: 0, mainMs: 0, maxRunMainMs: 0, wallMs: 0,
      children: 0, childWallMs: 0, childCommands: {}, changedRuns: 0, unchangedRuns: 0, pausedTicks: 0,
    };
    entries.set(name, entry);
  }
  return entry;
}

/** Charge the main thread's time since the last switch to the run that owned it. */
function switchTo(next: Run | null): void {
  const now = performance.now();
  if (active) {
    const elapsed = now - activeSince;
    active.mainMs += elapsed;
    active.entry.mainMs += elapsed;
  }
  active = next;
  activeSince = now;
}

/*
 * A watcher, server, socket or timer that a run creates outlives the run. Its
 * async context is the run's, so without this every later callback (a file
 * event, a socket read, an interval tick) would be charged to that loop, even
 * while the idle gate pauses it. Such a resource is charged to its own entry,
 * "<loop> › <kind>", and so is any work its callbacks start. A loop run that
 * one of its callbacks starts is still charged to that loop.
 */
const LONG_LIVED_KINDS: Record<string, string> = {
  FSEVENTWRAP: 'fs watcher', STATWATCHER: 'fs watcher', TCPWRAP: 'socket', PIPEWRAP: 'socket',
  TCPSERVERWRAP: 'server', PIPESERVERWRAP: 'server', UDPWRAP: 'socket', SIGNALWRAP: 'signal', TTYWRAP: 'tty',
};
/** A timer at least this long is deferred work, not a step of the run that set it. */
const LONG_TIMER_MS = 1_000;
const rehomed = new WeakMap<object, Run>();
/** The re-homed callback running now, and the loop context it was created in. */
let rehomedNow: { run: Run; creator: Run | undefined } | null = null;
let spawning = false;

function longLivedKind(type: string, resource: unknown): string | null {
  if (type === 'Timeout') {
    const timer = resource as { _repeat?: unknown; _idleTimeout?: number };
    if (timer._repeat) return 'interval';
    return (timer._idleTimeout ?? 0) >= LONG_TIMER_MS ? 'timer' : null;
  }
  // A child process's stdio pipes carry the run's own output.
  if (spawning && type === 'PIPEWRAP') return null;
  return LONG_LIVED_KINDS[type] ?? null;
}

function install(): void {
  if (installed) return;
  installed = true;
  createHook({
    init(_asyncId, type, _triggerAsyncId, resource) {
      const store = context.getStore();
      if (rehomedNow && store === rehomedNow.creator) {
        // Work a re-homed callback starts stays with it.
        rehomed.set(resource, rehomedNow.run);
        return;
      }
      if (!store) return;
      const kind = longLivedKind(type, resource);
      if (kind) rehomed.set(resource, { entry: entryFor(`${store.entry.name} › ${kind}`), mainMs: 0 });
    },
    before() {
      const resource = executionAsyncResource();
      const run = rehomed.get(resource);
      if (run) {
        rehomedNow = { run, creator: context.getStore() };
        switchTo(run);
        return;
      }
      rehomedNow = null;
      switchTo(context.getStore() ?? null);
    },
    after() { rehomedNow = null; switchTo(null); },
  }).enable();
  // Every child process (spawn, exec, execFile) starts through this method.
  // Synchronous spawns do not, but they block the main thread, which is charged.
  const prototype = ChildProcess.prototype as unknown as { spawn: (this: ChildProcess, options: unknown) => unknown };
  const spawn = prototype.spawn;
  prototype.spawn = function ledgerSpawn(this: ChildProcess, options: unknown) {
    // Charged to whoever is running now, which a re-homed callback replaces.
    const run = active ?? context.getStore();
    spawning = true;
    let result: unknown;
    try { result = spawn.call(this, options); } finally { spawning = false; }
    if (run) {
      const command = basename(String((options as { file?: string } | undefined)?.file ?? 'unknown'));
      run.entry.children += 1;
      run.entry.childCommands[command] = (run.entry.childCommands[command] ?? 0) + 1;
      const started = performance.now();
      this.once('exit', () => { run.entry.childWallMs += performance.now() - started; });
    }
    return result;
  };
}

function settle(run: Run, started: number, value: unknown): void {
  run.entry.wallMs += performance.now() - started;
  run.entry.maxRunMainMs = Math.max(run.entry.maxRunMainMs, run.mainMs);
  if (value === true) run.entry.changedRuns += 1;
  else if (value === false) run.entry.unchangedRuns += 1;
}

/** Run one pass of a named background loop, attributing its cost when the ledger is on. */
export function trackRun<T>(name: string, run: () => T): T {
  registered.add(name);
  if (!ledgerEnabled()) return run();
  install();
  const current: Run = { entry: entryFor(name), mainMs: 0 };
  current.entry.runs += 1;
  const started = performance.now();
  const previous = active;
  switchTo(current);
  let result: T;
  try {
    result = context.run(current, run);
  } catch (error) {
    switchTo(previous);
    settle(current, started, undefined);
    throw error;
  }
  switchTo(previous);
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    (result as unknown as Promise<unknown>).then(
      (value) => settle(current, started, value),
      () => settle(current, started, undefined),
    );
  } else {
    settle(current, started, result);
  }
  return result;
}

export interface LoopOptions {
  /** `always` keeps running while the server is at rest; it needs a written reason. */
  class?: LoopClass;
  reason?: string;
  /**
   * Idle-safe loops only: while this returns true (queued work, something
   * outstanding elsewhere) the loop keeps running at rest. Must be cheap.
   */
  busy?: () => boolean;
}

const classes = new Map<string, LoopClass>();

/**
 * Run one gated pass of a named loop: at rest an idle-safe loop is recorded as
 * paused and runs once when the server wakes. Returns false when it paused.
 */
export function gatedRun(name: string, run: () => unknown, options: LoopOptions = {}): boolean {
  registered.add(name);
  classes.set(name, options.class ?? 'idle-safe');
  if (options.class === 'always') {
    trackRun(name, run);
    return true;
  }
  if (!admitRun(name, () => { trackRun(name, run); }, options.busy)) {
    if (ledgerEnabled()) entryFor(name).pausedTicks += 1;
    return false;
  }
  trackRun(name, run);
  return true;
}

/**
 * `setInterval` for a named background loop. Same arguments after the name,
 * same timer back. Idle-safe unless `options.class` is `always`.
 */
export function recurring(name: string, run: () => unknown, intervalMs: number, options: LoopOptions = {}): NodeJS.Timeout {
  registered.add(name);
  classes.set(name, options.class ?? 'idle-safe');
  return setInterval(() => { gatedRun(name, run, options); }, intervalMs);
}

export function loopClass(name: string): LoopClass | undefined {
  return classes.get(name);
}

/** Loops ranked by main-thread time, then child processes. */
export function ledgerSnapshot(): LedgerEntry[] {
  return [...entries.values()]
    .map((entry) => ({ ...entry, childCommands: { ...entry.childCommands } }))
    .sort((a, b) => (b.mainMs + b.childWallMs / 10) - (a.mainMs + a.childWallMs / 10));
}

export function registeredLoopNames(): string[] {
  return [...registered].sort();
}

/** Reset counts (tests and bench phases). Registration is kept. */
export function resetLedger(): void {
  entries.clear();
}

/** With the ledger on, write `background-ledger.json` in the data dir and log the top loops every minute. */
export function startLedgerReporter(
  dataDir: string,
  intervalMs = Number(process.env.O8_BACKGROUND_LEDGER_INTERVAL_MS) || 60_000,
): NodeJS.Timeout | null {
  if (!ledgerEnabled()) return null;
  install();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const snapshot = ledgerSnapshot();
    const elapsedMinutes = Math.max(1 / 60, (Date.now() - startedAt) / 60_000);
    try {
      writeFileSync(join(dataDir, 'background-ledger.json'), JSON.stringify({
        startedAt: new Date(startedAt).toISOString(),
        writtenAt: new Date().toISOString(),
        registered: registeredLoopNames(),
        loops: snapshot,
        gate: idleGateStats(),
      }, null, 2));
    } catch {
      // Diagnostics only; a write failure never affects the server.
    }
    const top = snapshot.slice(0, 5)
      .map((entry) => `${entry.name} ${(entry.mainMs / elapsedMinutes).toFixed(0)}ms/min ${entry.children} spawns`)
      .join(' · ');
    console.log(`[background-ledger] ${top || 'no loop ran'}`);
  }, intervalMs);
  timer.unref();
  return timer;
}
