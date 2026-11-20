/**
 * Targeting Machine — observability.
 *
 * Structured `[targeting]` log lines, mirroring dispatch/routing.ts's
 * `[dispatch-routing]` recommendation logging. Triage runs seed the FUTURE
 * outcome-feedback recalibration loop (explicitly deferred — we only LOG now):
 *   - triage runs (what got scored, how high)
 *
 * The full per-file scores + signals persist durably in the targeting_scores
 * store; these lines are the greppable observability trail on top of that.
 */

import type { TargetScore } from './scorer';

/** Log a triage run — repo, count, rationale mode, and the top few by score. */
export function logTriageRun(repoPath: string, targets: TargetScore[], rationaleMode: 'llm' | 'heuristic'): void {
  const top = targets.slice(0, 5).map((t) => `${t.path}=${t.score}`).join(' ');
  console.log(
    `[targeting] triaged repo=${repoPath} files=${targets.length} rationales=${rationaleMode} top=[${top}]`,
  );
}
