import { summarize } from '../lib/judgment-replay-metrics.mjs';
import { fmt } from '../lib/judgment-replay-format.mjs';
import { labelCompaction, loadCompactionHistory } from '../lib/judgment-replay-compaction.mjs';

const COMPACTION_LABEL = 'compaction';

/** The compaction label report: recorded p(needed) against later-turn reuse, one fold per compaction. */
export function renderCompactionReport({ rows, notes }) {
  const lines = [];
  lines.push(`archives read: ${notes.archivesRead}; with scorer and later turns: ${notes.scored}; without scorer: ${notes.withoutScorer}; without later turns: ${notes.withoutLaterTurns}`);
  lines.push(`entries without any identifier (counted not needed): ${notes.entriesWithoutIdentifiers}`);
  const summary = summarize(rows);
  if (summary.positives === 0 || summary.negatives === 0) {
    lines.push(`${COMPACTION_LABEL}: ${summary.positives === 0 ? 'no positives' : 'no negatives'}, skipped (n=${summary.n} scored entries)`);
    return { text: lines.join('\n'), result: { skipped: summary.positives === 0 ? 'no positives' : 'no negatives', n: summary.n } };
  }
  lines.push(`${COMPACTION_LABEL} by p(needed): n=${summary.n} scored entries (positives ${summary.positives}, negatives ${summary.negatives})`);
  lines.push(`  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
  lines.push('  reliability   bin        n  mean_p  observed');
  for (const bin of summary.reliability) {
    const range = `${bin.low.toFixed(1)}-${bin.high.toFixed(1)}`;
    lines.push(`                ${range.padEnd(9)} ${String(bin.n).padStart(3)}  ${fmt(bin.meanPredicted, 2).padStart(6)}  ${fmt(bin.observedRate, 2).padStart(8)}`);
  }
  const lopo = summary.leaveOnePacketOut;
  lines.push(`  keep-every-needed threshold, leave-one-compaction-out (${lopo.scoredFolds} of ${lopo.folds} compactions scored): kept but unneeded ${lopo.falseAlarms} of ${lopo.negativesEvaluated}, dropped but needed ${lopo.misses} of ${lopo.positivesEvaluated}`);
  return { text: lines.join('\n'), result: summary };
}

const replayLabel = {
  name: COMPACTION_LABEL, kind: 'recorded', order: 10,
  source: ({ dataDir }) => dataDir,
  load: ({ dataDir }) => loadCompactionHistory(dataDir),
  label: history => labelCompaction(history.archives, history.threads),
  render: renderCompactionReport,
};

export default replayLabel;
