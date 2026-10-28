import { summarize } from '../lib/judgment-replay-metrics.mjs';
import { fmt } from '../lib/judgment-replay-format.mjs';
import { labelLoopChecks, loadLoopHistory } from '../lib/judgment-replay-loop.mjs';

const LOOP_LABEL = 'loop';

/** The loop label report: recorded p(loop) against later intervention on the lane. */
export function renderLoopReport({ rows, notes }) {
  const lines = [`loop checks read: ${notes.checksRead}; unlabeled (no intervention and no merge): ${notes.unlabeled}`];
  const summary = summarize(rows);
  if (summary.positives === 0 || summary.negatives === 0) {
    lines.push(`${LOOP_LABEL}: ${summary.positives === 0 ? 'no positives' : 'no negatives'}, skipped (n=${summary.n} labeled checks)`);
    return { text: lines.join('\n'), result: { skipped: summary.positives === 0 ? 'no positives' : 'no negatives', n: summary.n } };
  }
  lines.push(`${LOOP_LABEL} by p(loop): n=${summary.n} labeled checks (positives ${summary.positives}, negatives ${summary.negatives})`);
  lines.push(`  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
  return { text: lines.join('\n'), result: summary };
}

const replayLabel = {
  name: LOOP_LABEL, kind: 'recorded', order: 30,
  load: ({ dbPath }) => loadLoopHistory(dbPath), label: history => labelLoopChecks(history.events, history.outcomes),
  render: renderLoopReport,
};

export default replayLabel;
