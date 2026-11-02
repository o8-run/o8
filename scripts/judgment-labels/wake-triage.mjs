import { summarize } from '../lib/judgment-replay-metrics.mjs';
import { fmt } from '../lib/judgment-replay-format.mjs';
import { labelWakeTriage, loadWakeTriageHistory, OUTCOME_TO_OPTION, WAKE_TRIAGE_OPTIONS, WAKE_TRIAGE_WINDOW } from '../lib/judgment-replay-wake-triage.mjs';

const WAKE_TRIAGE_LABEL = 'wakeTriage';

/** The wakeTriage label report: recorded option probabilities against the lane's next outcome, per option. */
export function renderWakeTriageReport({ rows, notes }) {
  const lines = [];
  const outcomes = Object.entries(notes.outcomes).map(([outcome, n]) => `${outcome} ${n}`).join(', ');
  lines.push(`wake triage events: ${notes.recorded} (unreadable ${notes.unreadable}, abstained ${notes.abstained}); outcomes within ${WAKE_TRIAGE_WINDOW} events: ${outcomes}`);
  lines.push(`mapping: ${Object.entries(OUTCOME_TO_OPTION).map(([outcome, option]) => `${outcome} -> ${option}`).join(', ')}`);
  const result = {};
  for (const option of WAKE_TRIAGE_OPTIONS) {
    const summary = summarize(rows.filter((row) => row.option === option));
    if (summary.positives === 0 || summary.negatives === 0) {
      lines.push(`${WAKE_TRIAGE_LABEL} ${option}: ${summary.positives === 0 ? 'no positives' : 'no negatives'}, skipped (n=${summary.n})`);
      result[option] = { skipped: summary.positives === 0 ? 'no positives' : 'no negatives', n: summary.n };
      continue;
    }
    lines.push(`${WAKE_TRIAGE_LABEL} ${option}: n=${summary.n} (positives ${summary.positives}, negatives ${summary.negatives})  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
    result[option] = summary;
  }
  return { text: lines.join('\n'), result };
}

const replayLabel = {
  name: WAKE_TRIAGE_LABEL, kind: 'recorded', order: 40,
  load: ({ dbPath }) => loadWakeTriageHistory(dbPath), label: events => labelWakeTriage(events),
  render: renderWakeTriageReport,
};

export default replayLabel;
