import { reconcileProblemDossiers } from './service';

/** The heal-bot tick period, so dossiers settle on the same cadence either way. */
export const DOSSIER_RECONCILE_MS = 60_000;

/**
 * Reopens expired suppressions and advances remedy state on an interval. The
 * problem-dossiers GET only reads, so this keeps dossiers current when the
 * heal-bot is off. A running heal-bot reconciles each tick, so those ticks skip.
 */
export function startProblemDossierReconcile(options: {
  healBotRunning: () => boolean;
  periodMs?: number;
}): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || options.healBotRunning()) return;
    inFlight = true;
    reconcileProblemDossiers()
      .catch((error) => console.warn('[problems] Dossier reconciliation failed:', error instanceof Error ? error.message : error))
      .finally(() => { inFlight = false; });
  }, options.periodMs ?? DOSSIER_RECONCILE_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
