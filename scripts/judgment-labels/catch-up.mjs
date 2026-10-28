import { summarize } from '../lib/judgment-replay-metrics.mjs';
import { fmt } from '../lib/judgment-replay-format.mjs';
import { CATCH_UP_WINDOW_MS, labelCatchUp, loadCatchUpHistory } from '../lib/judgment-replay-catch-up.mjs';

const CATCH_UP_LABEL = 'catchUp';

/** The catchUp label report: recorded per-item attention scores against operator action after the briefing. */
export function renderCatchUpReport({ rows, notes }) {
  const lines = [`catch-up receipts: ${notes.receiptsRead} (failed ${notes.failed}, without selection ${notes.withoutSelection}); unlabeled items ${notes.unlabeledItems}; window ${CATCH_UP_WINDOW_MS / 60_000} min`];
  const summary = summarize(rows);
  if (summary.n === 0) {
    lines.push(`${CATCH_UP_LABEL}: no rows`);
    return { text: lines.join('\n'), result: { skipped: 'no rows', n: 0 } };
  }
  if (summary.positives === 0 || summary.negatives === 0) {
    lines.push(`${CATCH_UP_LABEL}: ${summary.positives === 0 ? 'no positives' : 'no negatives'}, skipped (n=${summary.n} scored items)`);
    return { text: lines.join('\n'), result: { skipped: summary.positives === 0 ? 'no positives' : 'no negatives', n: summary.n } };
  }
  lines.push(`${CATCH_UP_LABEL} by p(attention): n=${summary.n} scored items (positives ${summary.positives}, negatives ${summary.negatives})  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
  lines.push('  confound: the score also set the spoken order, so operator action is partly caused by it; read this AUC as an upper bound');
  return { text: lines.join('\n'), result: summary };
}

const replayLabel = {
  name: CATCH_UP_LABEL, kind: 'recorded', order: 70,
  load: ({ dbPath }) => loadCatchUpHistory(dbPath), label: labelCatchUp,
  render: renderCatchUpReport,
};

export default replayLabel;
