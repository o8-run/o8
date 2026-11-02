import { summarize } from '../lib/judgment-replay-metrics.mjs';
import { fmt } from '../lib/judgment-replay-format.mjs';
import { labelPushGate, loadPushGateHistory, PUSH_GATE_PROVISIONAL_BAND, PUSH_GATE_WINDOW_MS } from '../lib/judgment-replay-push-gate.mjs';

const PUSH_GATE_LABEL = 'pushGate';

/** The push gate label report: recorded p(attention now) against operator action within the window. */
export function renderPushGateReport({ rows, notes }) {
  const lines = [];
  lines.push(`push_gate events read: ${notes.gatesRead}; without p: ${notes.withoutP}; window ${PUSH_GATE_WINDOW_MS / 60_000} min`);
  const summary = summarize(rows);
  const suppressed = rows.filter((row) => !row.operatorGated && row.p <= PUSH_GATE_PROVISIONAL_BAND);
  const falseSuppressions = suppressed.filter((row) => row.y === 1).length;
  if (summary.positives === 0 || summary.negatives === 0) {
    lines.push(`${PUSH_GATE_LABEL}: ${summary.positives === 0 ? 'no positives' : 'no negatives'}, skipped AUC (n=${summary.n} recorded pushes)`);
  } else {
    lines.push(`${PUSH_GATE_LABEL} by p(attention now): n=${summary.n} recorded pushes (positives ${summary.positives}, negatives ${summary.negatives})`);
    lines.push(`  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
  }
  lines.push(`  PROVISIONAL band p <= ${PUSH_GATE_PROVISIONAL_BAND}, not operator-gated: would suppress ${suppressed.length} of ${summary.n}, false suppressions (operator acted) ${falseSuppressions}`);
  return { text: lines.join('\n'), result: { ...summary, wouldSuppress: suppressed.length, falseSuppressions } };
}

const replayLabel = {
  name: PUSH_GATE_LABEL, kind: 'recorded', order: 20,
  load: ({ dbPath }) => loadPushGateHistory(dbPath), label: labelPushGate,
  render: renderPushGateReport,
};

export default replayLabel;
