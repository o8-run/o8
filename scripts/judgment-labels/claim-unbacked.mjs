import { summarize } from '../lib/judgment-replay-metrics.mjs';
import { fmt } from '../lib/judgment-replay-format.mjs';
import { CLAIM_PREDICTORS, labelClaimUnbacked, loadClaimUnbackedHistory } from '../lib/judgment-replay-claim-unbacked.mjs';

const CLAIM_UNBACKED_LABEL = 'claimUnbacked';

/** The claimUnbacked label report: each recorded claim answer against a later rerun or rejection. */
export function renderClaimUnbackedReport({ rows, notes }) {
  const lines = [`report-claim receipts: ${notes.receiptsRead} (failed calls ${notes.failedCalls}, unlabeled ${notes.unlabeled}); labeled reports: rerun after ${notes.rerun}, rejected after ${notes.rejected}, merged without either ${notes.merged}`];
  const result = {};
  for (const predictor of CLAIM_PREDICTORS) {
    const summary = summarize(rows.filter((row) => row.predictor === predictor));
    if (summary.positives === 0 || summary.negatives === 0) {
      lines.push(`${CLAIM_UNBACKED_LABEL} by ${predictor}: ${summary.positives === 0 ? 'no positives' : 'no negatives'}, skipped (n=${summary.n} labeled reports)`);
      result[predictor] = { skipped: summary.positives === 0 ? 'no positives' : 'no negatives', n: summary.n };
      continue;
    }
    lines.push(`${CLAIM_UNBACKED_LABEL} by ${predictor}: n=${summary.n} labeled reports (positives ${summary.positives}, negatives ${summary.negatives})  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
    result[predictor] = summary;
  }
  return { text: lines.join('\n'), result };
}

const replayLabel = {
  name: CLAIM_UNBACKED_LABEL, kind: 'recorded', order: 50,
  load: ({ dbPath }) => loadClaimUnbackedHistory(dbPath), label: labelClaimUnbacked,
  render: renderClaimUnbackedReport,
};

export default replayLabel;
