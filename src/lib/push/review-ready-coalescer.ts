/**
 * Review-ready notification coalescer (#2150).
 *
 * A parallel dispatch flips three packets to `awaiting_review` within a second
 * of each other, and each flip used to raise its own notification — three
 * banners sliding in over whatever the operator was doing.
 *
 * The coalescer sits at the lane-lifecycle chokepoint (`publishLaneLifecycleEvent`),
 * which EVERY dispatch path passes through on its way to `reviewing`. Putting it
 * there rather than in one caller is the whole point: mission dispatch, task
 * pool, rerun and heal-bot all reach review through the same edge, so they all
 * inherit the batching without knowing it exists.
 *
 * Shape: the first flip opens a window; every flip inside that window joins the
 * batch; when the window closes one notification goes out carrying the count. A
 * flip arriving after the flush opens a fresh window.
 *
 * The whole thing is built around injectable `schedule` / `deliver` / `now`, so
 * a test drives real batching instead of asserting on a helper in isolation.
 */

import 'server-only';

import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { shouldDeliverReviewNotification } from '@/lib/operator/presentation-defaults';
import { notifyAllInBackground } from './notify';

/**
 * How long a batch stays open. Long enough that a parallel dispatch lands in
 * one banner, short enough that a lone packet still feels immediate.
 */
export const REVIEW_READY_COALESCE_WINDOW_MS = 4_000;

/** Labels listed in the batch body before it trails off. */
const MAX_LISTED_LABELS = 3;

export interface ReviewReadyFlip {
  laneId: string;
  label: string;
  packetId?: string | null;
  repoPath?: string;
}

export interface ReviewReadyNotification {
  title: string;
  body: string;
  tag: string;
  count: number;
  laneIds: string[];
}

/**
 * Turn a batch into one notification. A single flip keeps the exact wording and
 * per-lane tag the uncoalesced path used, so nothing changes for the common case.
 */
export function composeReviewReadyNotification(flips: ReviewReadyFlip[]): ReviewReadyNotification | null {
  if (flips.length === 0) return null;
  const laneIds = flips.map((flip) => flip.laneId);
  if (flips.length === 1) {
    return {
      title: 'Ready for review',
      body: flips[0].label,
      tag: `review-ready-${flips[0].laneId}`,
      count: 1,
      laneIds,
    };
  }
  const labels = flips.map((flip) => flip.label).filter(Boolean);
  const listed = labels.slice(0, MAX_LISTED_LABELS).join(', ');
  const remaining = labels.length - Math.min(labels.length, MAX_LISTED_LABELS);
  return {
    title: `${flips.length} packets ready for review`,
    body: remaining > 0 ? `${listed} and ${remaining} more` : listed,
    // One replaceable tag: a second batch supersedes the first in the OS tray
    // instead of stacking another card next to it.
    tag: 'review-ready-batch',
    count: flips.length,
    laneIds,
  };
}

export interface ReviewReadyCoalescerDeps {
  windowMs?: number;
  /** Defaults to `setTimeout`; a test passes a manual clock. */
  schedule?: (run: () => void, ms: number) => void;
  /** Defaults to the real push fan-out. */
  deliver?: (notification: ReviewReadyNotification, flips: ReviewReadyFlip[]) => void;
  /** Defaults to the persisted operator defaults. */
  shouldDeliver?: () => boolean;
}

export interface ReviewReadyCoalescer {
  enqueue: (flip: ReviewReadyFlip) => void;
  /** Close the open window immediately. Returns what went out, if anything. */
  flush: () => ReviewReadyNotification | null;
  pendingCount: () => number;
  reset: () => void;
}

function deliverViaPush(notification: ReviewReadyNotification, flips: ReviewReadyFlip[]): void {
  const first = flips[0];
  notifyAllInBackground({
    title: notification.title,
    body: notification.body,
    tag: notification.tag,
    data: {
      kind: 'review-ready',
      count: notification.count,
      laneIds: notification.laneIds,
      laneId: first.laneId,
      packetId: first.packetId ?? undefined,
      repoPath: first.repoPath,
    },
  }, { kind: 'review_ready', laneId: first.laneId, packetId: first.packetId });
}

/**
 * Read the gate at FLUSH time, not at enqueue time: an operator who turns quiet
 * mode on mid-dispatch expects the banner that was already queued to be dropped,
 * not delivered a beat later.
 */
function shouldDeliverFromSettings(): boolean {
  try {
    return shouldDeliverReviewNotification(getOperatorDefaultsSync().values);
  } catch (error) {
    // A settings read failure must not silence a review that is genuinely ready.
    console.warn('[review-notify] settings read failed, delivering', error);
    return true;
  }
}

export function createReviewReadyCoalescer(deps: ReviewReadyCoalescerDeps = {}): ReviewReadyCoalescer {
  const windowMs = deps.windowMs ?? REVIEW_READY_COALESCE_WINDOW_MS;
  const schedule = deps.schedule ?? ((run, ms) => { setTimeout(run, ms).unref?.(); });
  const deliver = deps.deliver ?? deliverViaPush;
  const shouldDeliver = deps.shouldDeliver ?? shouldDeliverFromSettings;

  let pending: ReviewReadyFlip[] = [];
  let windowOpen = false;

  function flush(): ReviewReadyNotification | null {
    const flips = pending;
    pending = [];
    windowOpen = false;
    if (flips.length === 0) return null;
    if (!shouldDeliver()) {
      console.log(`[review-notify] suppressed ${flips.length} review-ready notification(s)`);
      return null;
    }
    const notification = composeReviewReadyNotification(flips);
    if (!notification) return null;
    deliver(notification, flips);
    return notification;
  }

  return {
    enqueue(flip) {
      // A lane can re-enter `reviewing` inside one window (a rejected packet
      // re-reviewed); it is still one thing to tell the operator about.
      if (pending.some((queued) => queued.laneId === flip.laneId)) return;
      pending.push(flip);
      if (windowOpen) return;
      windowOpen = true;
      schedule(() => { flush(); }, windowMs);
    },
    flush,
    pendingCount: () => pending.length,
    reset() {
      pending = [];
      windowOpen = false;
    },
  };
}

/** The instance the lane chokepoint uses. */
const defaultCoalescer = createReviewReadyCoalescer();

export function enqueueReviewReady(flip: ReviewReadyFlip): void {
  defaultCoalescer.enqueue(flip);
}

export function flushReviewReadyNow(): ReviewReadyNotification | null {
  return defaultCoalescer.flush();
}

export function pendingReviewReadyCount(): number {
  return defaultCoalescer.pendingCount();
}
