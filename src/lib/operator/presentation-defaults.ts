/**
 * Presentation, notification and rail operator defaults (#2147, #2150).
 *
 * Two settings, one gap: o8 can put something in front of an audience that the
 * app itself cannot see — a satellite overlay window, a coach card, a count
 * pill, or a native macOS banner outside the window entirely.
 *
 * - `presentation.quiet_mode` (`presentationQuietMode`) is the whole-app switch.
 *   While it is on, every suppressible surface stays down. Transient by nature —
 *   it persists so a caller can read it back and so it survives a reload during
 *   a long recording, but the operator is expected to turn it off again.
 * - `notifications.review_ready` (`notificationsReviewReady`) is the standing
 *   preference for the native "ready for review" banner. Shaped like the
 *   `broadcast.*` flags, but default **on**: the banner already shipped
 *   unconditionally, so an existing install must not lose it by upgrading.
 *
 * What "critical" means — the surfaces quiet mode never touches — is defined
 * once in `src/lib/presentation/quiet-mode-policy.ts`.
 */

export type ReviewReadyNotifications = 'off' | 'on';

export interface PresentationDefaults {
  /** Whole-app suppression switch for screen shares, demos, and recordings. */
  presentationQuietMode: boolean;
  /** Explicit Settings choices; discovery alone never adds a bot to the rail. */
  botRailEnabledIds: string[];
  /** Native "ready for review" banner. Quiet mode forces this off while active. */
  notificationsReviewReady: ReviewReadyNotifications;
}

export const PRESENTATION_FALLBACK: PresentationDefaults = {
  presentationQuietMode: false,
  botRailEnabledIds: [],
  notificationsReviewReady: 'on',
};

export function isReviewReadyNotifications(value: unknown): value is ReviewReadyNotifications {
  return value === 'off' || value === 'on';
}

export function isBotRailEnabledIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);
}

/** Shared normalization for the existing Settings mutation path. */
export function botRailUpdate(body: Record<string, unknown>): Partial<PresentationDefaults> {
  if (body.botRailEnabledIds === undefined) return {};
  if (!isBotRailEnabledIds(body.botRailEnabledIds)) throw new Error('botRailEnabledIds must be an array of non-empty bot ids.');
  return { botRailEnabledIds: [...new Set(body.botRailEnabledIds)] };
}

export function resolveStoredPresentation(
  stored: Partial<PresentationDefaults>,
): Partial<PresentationDefaults> {
  const result: Partial<PresentationDefaults> = {};
  if (isBotRailEnabledIds(stored.botRailEnabledIds)) result.botRailEnabledIds = [...new Set(stored.botRailEnabledIds)];
  if (typeof stored.presentationQuietMode === 'boolean') {
    result.presentationQuietMode = stored.presentationQuietMode;
  }
  if (isReviewReadyNotifications(stored.notificationsReviewReady)) {
    result.notificationsReviewReady = stored.notificationsReviewReady;
  }
  return result;
}

export function resolvePresentationDefaults(
  stored: Partial<PresentationDefaults>,
): PresentationDefaults {
  return { ...PRESENTATION_FALLBACK, ...resolveStoredPresentation(stored) };
}

export function presentationSettingSources(
  stored: Partial<PresentationDefaults>,
): Record<keyof PresentationDefaults, 'file' | 'default'> {
  return {
    botRailEnabledIds: stored.botRailEnabledIds !== undefined ? 'file' : 'default',
    presentationQuietMode: stored.presentationQuietMode !== undefined ? 'file' : 'default',
    notificationsReviewReady: stored.notificationsReviewReady !== undefined ? 'file' : 'default',
  };
}

export function applyPresentationUpdate(
  stored: Partial<PresentationDefaults>,
  update: Partial<PresentationDefaults>,
): void {
  Object.assign(stored, botRailUpdate(update));
  if (update.presentationQuietMode !== undefined) {
    if (typeof update.presentationQuietMode !== 'boolean') {
      throw new Error('presentationQuietMode must be boolean.');
    }
    stored.presentationQuietMode = update.presentationQuietMode;
  }
  if (update.notificationsReviewReady !== undefined) {
    if (!isReviewReadyNotifications(update.notificationsReviewReady)) {
      throw new Error('notificationsReviewReady must be "off" or "on".');
    }
    stored.notificationsReviewReady = update.notificationsReviewReady;
  }
}

/**
 * The one place the two settings combine. Quiet mode outranks the standing
 * preference, exactly as `presentation::should_deliver_review_notification`
 * does on the Rust side — the native banner and the server-side push must never
 * disagree about whether a notification is suppressed.
 */
export function shouldDeliverReviewNotification(values: Pick<PresentationDefaults, 'presentationQuietMode' | 'notificationsReviewReady'>): boolean {
  if (values.presentationQuietMode) return false;
  return values.notificationsReviewReady === 'on';
}
