import { summarize } from '../lib/judgment-replay-metrics.mjs';
import { fmt } from '../lib/judgment-replay-format.mjs';
import { citationsByRule, DIRECTIVE_CITATION_REPLAY_THRESHOLD, labelDirectiveCitations } from '../lib/judgment-replay-directive-citation.mjs';
import { loadClaimUnbackedHistory } from '../lib/judgment-replay-claim-unbacked.mjs';

const DIRECTIVE_CITATION_LABEL = 'directiveCitation';

/** The directiveCitation label report: per-(file, rule) scores against the diff's outcome, with false citations per rule. */
export function renderDirectiveCitationReport({ rows, notes }) {
  const lines = [`directive_citations events: ${notes.eventsRead} (unlabeled ${notes.unlabeledEvents}, approval matched by diff fingerprint ${notes.matchedByFingerprint}); scores read: ${notes.scoresRead}`];
  const summary = summarize(rows);
  if (summary.positives === 0 || summary.negatives === 0) {
    lines.push(`${DIRECTIVE_CITATION_LABEL}: ${summary.positives === 0 ? 'no positives' : 'no negatives'}, skipped AUC (n=${summary.n} labeled scores)`);
  } else {
    lines.push(`${DIRECTIVE_CITATION_LABEL} by p(breaks rule): n=${summary.n} labeled scores (positives ${summary.positives}, negatives ${summary.negatives})`);
    lines.push(`  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
  }
  // Printed even when the AUC is skipped: the per-rule positives below rest on the same labels.
  lines.push('  caveat: the AUC, the Brier score and every per-rule positives count use labels assigned per diff, not per rule, so each rule\'s positives count is an UPPER bound and the AUC and Brier error has NO FIXED DIRECTION: neither is a clean measure of the rule-level score');
  const byRule = citationsByRule(rows);
  const falseCitations = byRule.reduce((sum, entry) => sum + entry.falseCitations, 0);
  lines.push(`  false citations at p >= ${DIRECTIVE_CITATION_REPLAY_THRESHOLD}: ${falseCitations} of ${summary.negatives} y=0 scores`);
  lines.push('  caveat: a rejection or rerun marks every rule scored on that diff y=1, including rules that were not the reason, so the two error counts are wrong in opposite directions:');
  lines.push('    false citations are a LOWER bound and citation precision is OVERSTATED: a wrongly high score on a rejected diff counts as a cited positive and leaves the y=0 pool');
  lines.push('    misses (positives minus cited positives) are an UPPER bound: rules that were not the reason count as violations the score missed');
  for (const entry of byRule) {
    lines.push(`  rule ${entry.rule}${entry.heldBack ? ' (held back)' : ''}: n=${entry.n}, positives ${entry.positives}, cited positives ${entry.cited}, false citations ${entry.falseCitations} of ${entry.n - entry.positives} y=0`);
  }
  return { text: lines.join('\n'), result: { ...summary, falseCitations, byRule } };
}

const replayLabel = {
  name: DIRECTIVE_CITATION_LABEL, kind: 'recorded', order: 60,
  load: ({ dbPath }) => loadClaimUnbackedHistory(dbPath), label: labelDirectiveCitations,
  render: renderDirectiveCitationReport,
};

export default replayLabel;
