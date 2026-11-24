/**
 * Park report: with `O8_PARK_NODE=1` under the launcher, Node asks the
 * launcher to stop it once nothing needs Node, and o8d starts it again on
 * demand. Node may be parked only when the idle gate is resting and every
 * check below has stayed clear for PARK_AFTER_MS (default five minutes).
 *
 * Each check names what keeps Node up, or returns null. The reasons are kept
 * for the background ledger (`park`) and logged when they change, so a
 * reading shows why Node stayed up. Off unless both the switch and the
 * launcher socket are set: no timer runs and nothing is asked.
 */
import { createConnection } from 'node:net';

import { idleGateResting } from './idle-gate';

export type ParkCheck = () => string | null;

export interface ParkReport {
  enabled: boolean;
  parkAfterMs: number;
  /** What keeps Node up now; empty once everything is clear. */
  blockers: string[];
  /** When every check last became clear, or null while something blocks. */
  clearSince: string | null;
  /** Checks that found a reason, by reason, since the report started. */
  blockedBy: Record<string, number>;
  /** The last answer from the launcher to a park request. */
  lastRequest: { at: string; result: string } | null;
}

export const PARK_AFTER_MS_DEFAULT = 5 * 60_000;
const CHECK_EVERY_MS_DEFAULT = 30_000;
const REQUEST_DEADLINE_MS = 2_000;
const REPLY_MAX_BYTES = 4_096;

let checks: Record<string, ParkCheck> = {};
let checker: NodeJS.Timeout | null = null;
let blockers: string[] = [];
let clearSince: number | null = null;
let blockedBy: Record<string, number> = {};
let lastRequest: ParkReport['lastRequest'] = null;
let requesting = false;
/** The launcher answered: it is stopping Node, or parking is off. Either way, ask no more. */
let answered = false;
let logged = '';

export function parkingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.O8_PARK_NODE === '1' && Boolean(env.O8_LAUNCHER_SOCKET);
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parkAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive(env.O8_PARK_AFTER_MS, PARK_AFTER_MS_DEFAULT);
}

/** Every reason Node cannot be parked right now. */
export function parkBlockers(): string[] {
  const found: string[] = [];
  if (!idleGateResting()) found.push('idle gate awake');
  for (const [name, check] of Object.entries(checks)) {
    let reason: string | null;
    try { reason = check(); } catch { reason = `${name} check failed`; }
    if (reason) found.push(reason);
  }
  return found;
}

/** One check pass: record the reasons, and ask to park once clear for long enough. */
export function evaluatePark(now = Date.now()): void {
  blockers = parkBlockers();
  for (const reason of blockers) blockedBy[reason] = (blockedBy[reason] ?? 0) + 1;
  if (blockers.length > 0) clearSince = null;
  else clearSince ??= now;
  const summary = blockers.join(', ');
  if (summary !== logged) {
    logged = summary;
    console.log(summary ? `[park] Node stays up: ${summary}` : '[park] nothing needs Node');
  }
  if (clearSince === null || answered || requesting || now - clearSince < parkAfterMs()) return;
  requesting = true;
  console.log(`[park] asking the launcher to park Node (clear for ${Math.round((now - clearSince) / 1000)}s)`);
  void requestPark().then((result) => {
    requesting = false;
    lastRequest = { at: new Date().toISOString(), result };
    // The launcher stops Node after answering (or restarts it if the stop fails): ask once.
    if (result === 'parking') { answered = true; return; }
    console.log(`[park] the launcher did not park Node: ${result}`);
    // Parking is off in the launcher: stop asking. Any other failure waits a full period again.
    if (result === 'Parking is off') answered = true;
    clearSince = null;
  });
}

/** Ask the launcher to park Node; resolves with its state or its error, never rejects. */
function requestPark(): Promise<string> {
  return new Promise((resolve) => {
    const peer = createConnection({ path: process.env.O8_LAUNCHER_SOCKET! });
    let bytes = '';
    let done = false;
    const timer = setTimeout(() => finish('no answer'), REQUEST_DEADLINE_MS);
    function finish(result: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.destroy();
      resolve(result);
    }
    peer.on('error', () => finish('launcher unavailable'));
    peer.on('connect', () => peer.end(JSON.stringify({ op: 'park-node' })));
    peer.on('data', (chunk) => {
      bytes += chunk.toString();
      if (bytes.length > REPLY_MAX_BYTES) return finish('reply too long');
      if (bytes.includes('\n')) parse();
    });
    peer.on('end', parse);
    function parse() {
      try {
        const reply = JSON.parse(bytes.split('\n')[0]) as { ok?: unknown; state?: unknown; error?: unknown };
        if (reply.ok === true && typeof reply.state === 'string') return finish(reply.state);
        finish(typeof reply.error === 'string' ? reply.error : 'refused');
      } catch { finish('unreadable reply'); }
    }
  });
}

export function parkReport(): ParkReport {
  return {
    enabled: parkingEnabled(),
    parkAfterMs: parkAfterMs(),
    blockers: [...blockers],
    clearSince: clearSince === null ? null : new Date(clearSince).toISOString(),
    blockedBy: { ...blockedBy },
    lastRequest,
  };
}

/** Install the checks and, with parking on, start asking. Idempotent. */
export function startParkReport(input: Record<string, ParkCheck>): void {
  checks = input;
  if (checker || !parkingEnabled()) return;
  console.log(`[park] on: Node asks to be parked after ${Math.round(parkAfterMs() / 1000)}s with nothing to do`);
  checker = setInterval(() => evaluatePark(), positive(process.env.O8_PARK_CHECK_MS, CHECK_EVERY_MS_DEFAULT));
  checker.unref();
}

/** Tests only. */
export function resetParkReport(): void {
  if (checker) clearInterval(checker);
  checker = null;
  checks = {};
  blockers = [];
  clearSince = null;
  blockedBy = {};
  lastRequest = null;
  requesting = false;
  answered = false;
  logged = '';
}
