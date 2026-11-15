/** The native draw-on-screen ink contract shared by the route and the page feed.
 * The native panel reports captured points as [stroke, x, y, t]: the stroke's
 * index in the session, x and y normalized (0..1) to the monitor it covers,
 * and t in milliseconds since that stroke began, as the web overlay records. */
import timing from './ink-timing.json';

export const INK_TIMING = timing;
/** The classic shell's limits for one session (spatial_ink_window.rs). */
export const INK_MAX_STROKES = 128;
export const INK_MAX_POINTS = 8192;
/** Points one reply may carry; the rest follow on the next frame. */
export const INK_REPLY_POINTS = 2048;
/** Why the native panel let the pointer go on its own. */
export const INK_DISARMS = ['release', 'handoff', 'escape', 'lease', 'error', 'bound', 'display'] as const;
export type InkDisarm = typeof INK_DISARMS[number];
export type InkPoint = [stroke: number, x: number, y: number, t: number];
/** The monitor the shell covered, in top-left desktop points. */
export interface InkMonitor { x: number; y: number; width: number; height: number }
export interface InkReply { native: boolean; capturing?: boolean; disarmed?: InkDisarm; points?: InkPoint[]; next?: number }

const count = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const optional = (value: unknown) => value === undefined || typeof value === 'boolean';

export function monitorValid(value: unknown): value is InkMonitor {
  if (!value || typeof value !== 'object') return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  const finite = [x, y, width, height].every(v => typeof v === 'number' && Number.isFinite(v));
  return finite && Math.abs(x as number) <= 100_000 && Math.abs(y as number) <= 100_000
    && (width as number) > 0 && (width as number) <= 100_000 && (height as number) > 0 && (height as number) <= 100_000;
}

/** Shape check for an ink request; the native side validates again. */
export function inkRequestValid(body: Record<string, unknown>): boolean {
  if (body.action === 'prepare') return true;
  if (!count(body.session, Number.MAX_SAFE_INTEGER)) return false;
  if (body.from !== undefined && !count(body.from, INK_MAX_POINTS)) return false;
  if (body.action === 'arm') return monitorValid(body.monitor) && optional(body.reducedMotion);
  if (body.action === 'release') return optional(body.handoff) && optional(body.immediate);
  return true;
}

export function pointValid(value: unknown): value is InkPoint {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [stroke, x, y, t] = value;
  return count(stroke, INK_MAX_STROKES - 1) && [x, y, t].every(v => typeof v === 'number' && Number.isFinite(v))
    && x >= 0 && x <= 1 && y >= 0 && y <= 1 && t >= 0 && t <= 3_600_000;
}

/** A native receipt reduced to what the page may act on. A malformed point
 * list is a failed reply, so the page takes the session back. */
export function inkReply(reply: Record<string, unknown> | null | undefined): InkReply {
  if (!reply || reply.ok !== true && reply.ok !== false) return { native: false };
  const points = reply.points ?? [];
  const next = reply.next;
  if (!Array.isArray(points) || points.length > INK_REPLY_POINTS || !points.every(pointValid)) return { native: false };
  if (next !== undefined && !count(next, INK_MAX_POINTS)) return { native: false };
  const disarmed = INK_DISARMS.find(reason => reason === reply.disarmed);
  return {
    native: reply.ok === true, capturing: reply.capturing === true,
    ...(disarmed ? { disarmed } : {}), ...(points.length ? { points: points as InkPoint[] } : {}),
    ...(next !== undefined ? { next: next as number } : {}),
  };
}
