import { reconcileProblemDossiers } from './service';
import { recurring } from '@/lib/background-work/ledger';
import { getSqlite } from '@/lib/db';
import { controlPlaneStamp } from '@/lib/orchestrator/control-plane';
import { laneEpoch } from '@/lib/orchestrator/settled-missions';

/** The heal-bot tick period, so dossiers settle on the same cadence either way. */
export const DOSSIER_RECONCILE_MS = 60_000;

/**
 * Everything a reconcile pass reads, as one string: dossiers, remedies, the
 * supervisor evidence it promotes, mission records, lanes and lane events, and
 * the current-mission file. A pass with the same inputs would do nothing new.
 */
export function dossierReconcileInputs(): string {
  const row = getSqlite().prepare(`
    SELECT
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM problem_dossiers) AS dossiers,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM problem_remedies) AS remedies,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) || ':' || COALESCE(MAX(last_seen_at), '')
         FROM supervisor_inbox
        WHERE kind IN ('verification_failed', 'bounded_retry_exhausted', 'packet_no_changes')) AS inbox,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM missions) AS missions
  `).get() as Record<string, string>;
  return [row.dossiers, row.remedies, row.inbox, row.missions, laneEpoch(), controlPlaneStamp()].join('|');
}

/** The earliest moment a suppressed dossier's cooldown runs out, or null. */
function nextCooldownDue(): number | null {
  const row = getSqlite().prepare(`
    SELECT MIN(cooldown_until) AS due FROM problem_dossiers
    WHERE status = 'suppressed' AND operator_stopped_at IS NULL AND cooldown_until IS NOT NULL
  `).get() as { due: string | null };
  if (!row.due) return null;
  const due = Date.parse(row.due.includes('T') ? row.due : `${row.due.replace(' ', 'T')}Z`);
  return Number.isFinite(due) ? due : 0;
}

/**
 * Reopens expired suppressions and advances remedy state on an interval. The
 * problem-dossiers GET only reads, so this keeps dossiers current when the
 * heal-bot is off. A running heal-bot reconciles each tick, so those ticks skip.
 *
 * A pass is skipped while its inputs are unchanged since the last pass and no
 * suppression cooldown has come due; the inputs are read after each pass, so
 * the pass's own writes do not count as a change.
 */
export function startProblemDossierReconcile(options: {
  healBotRunning: () => boolean;
  periodMs?: number;
}): () => void {
  let inFlight = false;
  let lastInputs: string | null = null;
  const timer = recurring('problem-dossier-reconcile', () => {
    if (inFlight || options.healBotRunning()) return;
    try {
      const due = nextCooldownDue();
      if (lastInputs !== null && lastInputs === dossierReconcileInputs() && (due === null || due > Date.now())) return;
    } catch {
      // Unreadable inputs: run the pass.
    }
    inFlight = true;
    reconcileProblemDossiers()
      .then(() => { lastInputs = dossierReconcileInputs(); })
      .catch((error) => {
        lastInputs = null;
        console.warn('[problems] Dossier reconciliation failed:', error instanceof Error ? error.message : error);
      })
      .finally(() => { inFlight = false; });
  }, options.periodMs ?? DOSSIER_RECONCILE_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
