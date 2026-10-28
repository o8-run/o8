#!/usr/bin/env node

/**
 * Calibration replay over the local approval history (#2438, tracker #2433).
 *
 * Thresholds on a referee answer must come from this install's own history.
 * This script reads approvals that carry a diff, gate results, and the outcome
 * ledger from the o8 database opened read-only, builds the same sanitized state
 * the product builds (`buildDiffState`), collapses duplicates by the hash of
 * that state, asks the locked `DIFF_QUESTIONS` once per distinct diff through
 * `askJudgment` (surface `calibration-replay`, so each call writes a receipt
 * like any other), and prints per label the AUC, Brier score, a reliability
 * table, and the false-alarm count at the threshold that catches every
 * positive, fit with leave-one-packet-out. The n behind every number is
 * printed with it.
 *
 * Run with:
 *   node scripts/judgment-replay.mjs [--dry-run] [--limit N] [--out results.json] [--label NAME]
 *
 * --label picks one label. `compaction` (#2465) is different in kind: it sends
 * nothing and reads the scores auto-compaction already recorded in the
 * orchestrator archives, labeled by whether later turns reused an identifier
 * from each entry (see scripts/lib/judgment-replay-compaction.mjs). `pushGate`
 * (#2441) also sends nothing: it reads recorded `push_gate` lane events,
 * labeled by whether the operator acted on the lane within 30 minutes (see
 * scripts/lib/judgment-replay-push-gate.mjs). `loop` (#2448) likewise sends
 * nothing: it scores the recorded `loop_check` answers against later operator
 * or orchestrator intervention on the lane (see
 * scripts/lib/judgment-replay-loop.mjs).
 * `wakeTriage` (#2467) also sends nothing: it scores the recorded
 * `wake_triage` lane events against what happened next on the same lane (see
 * scripts/lib/judgment-replay-wake-triage.mjs for the outcome mapping).
 * `catchUp` (#2444, #2511) also sends nothing: it scores the recorded
 * per-item attention scores in the ranking receipts against whether the
 * operator acted on the item within 30 minutes of the briefing (see
 * scripts/lib/judgment-replay-catch-up.mjs, including the ordering confound).
 * `claimUnbacked` (#2447) and `directiveCitation` (#2446) send nothing: they
 * score the recorded report-claim receipts and `directive_citations` scores
 * against a later rerun or operator rejection of the packet, versus a merge
 * (see scripts/lib/judgment-replay-claim-unbacked.mjs and
 * scripts/lib/judgment-replay-directive-citation.mjs). `all-recorded` runs
 * every label that sends nothing in one pass; it never runs gateFailed,
 * operatorRejected, or mergedClean.
 *
 * --dry-run prints each request body and sends nothing; it works with
 * judgment.provider off. Without it the script refuses to run while the
 * setting is off or no key is configured. The key is never printed.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { summarize } from './lib/judgment-replay-metrics.mjs';
import { fmt } from './lib/judgment-replay-format.mjs';
import { discoverReplayLabels } from './lib/judgment-replay-registry.mjs';

// Preserve the existing report API; discovery does not use these compatibility exports.
export { renderCompactionReport } from './judgment-labels/compaction.mjs';
export { renderPushGateReport } from './judgment-labels/push-gate.mjs';
export { renderLoopReport } from './judgment-labels/loop.mjs';
export { renderWakeTriageReport } from './judgment-labels/wake-triage.mjs';
export { renderClaimUnbackedReport } from './judgment-labels/claim-unbacked.mjs';
export { renderDirectiveCitationReport } from './judgment-labels/directive-citation.mjs';
export { renderCatchUpReport } from './judgment-labels/catch-up.mjs';

const SURFACE = 'calibration-replay';
const USD_PER_BILLION_INPUT_TOKENS = 42;
const OPERATOR_ACTORS = new Set(['desktop', 'mobile']);
const GATE_FAILURE_VERBS = ['typecheck_auto_retry', 'typecheck_escalation'];
const replayLabels = await discoverReplayLabels(new URL('./judgment-labels/', import.meta.url));
const LABELS = replayLabels.filter(entry => entry.kind === 'approval').map(entry => entry.name);
const RECORDED_LABELS = Object.fromEntries(replayLabels.filter(entry => entry.kind === 'recorded').map(entry => [entry.name, entry]));
/** Runs every recorded-answer label in one pass; never the approval labels, which send calls. */
const ALL_RECORDED_LABEL = 'all-recorded';
const USAGE = `usage: node scripts/judgment-replay.mjs [--dry-run] [--limit N] [--out results.json] [--label ${[...replayLabels.map(entry => entry.name), ALL_RECORDED_LABEL].join('|')}]`;
const TSX_MARKER = 'O8_JUDGMENT_REPLAY_TSX_LOADER';

/**
 * Predictors a threshold may read (DIFF_QUESTION_USE marks only these two).
 * Each maps an answer set to the probability of the bad outcome, or null for
 * an abstain.
 */
const PREDICTORS = {
  'risk/4': (answers) => (answers.risk && !answers.risk.abstain ? answers.risk.score / 4 : null),
  '1-docsOnly': (answers) => (answers.docsOnly ? 1 - answers.docsOnly.noul : null),
};

export function parseReplayArgs(argv) {
  const options = { dryRun: false, limit: null, out: null, label: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--limit' || arg === '--out' || arg === '--label') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      index += 1;
      if (arg === '--out') options.out = value;
      else if (arg === '--label') {
        if (!Object.hasOwn(RECORDED_LABELS, value) && value !== ALL_RECORDED_LABEL && !LABELS.includes(value)) return { error: `unknown label: ${value}` };
        options.label = value;
      }
      else {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1) return { error: '--limit must be a positive integer' };
        options.limit = limit;
      }
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  return { options };
}

const parseJson = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value));

/** Rows from a query, or [] with a note when the table or column is missing in this database. */
function safeAll(db, sql, notes, what) {
  try {
    return db.prepare(sql).all();
  } catch (error) {
    notes.push(`${what} unavailable (${error instanceof Error ? error.message : 'query failed'})`);
    return [];
  }
}

function approvalDiffInput(diff) {
  if (!diff || typeof diff !== 'object') return null;
  const listed = Array.isArray(diff.files) ? diff.files.filter((file) => file && typeof file.path === 'string') : [];
  const text = typeof diff.after === 'string' && diff.after.includes('diff --git')
    ? diff.after
    : listed.map((file) => (typeof file.patch === 'string' ? file.patch : '')).filter(Boolean).join('\n');
  if (!text.trim()) return null;
  return { files: listed.map((file) => ({ path: file.path, renamed: file.status === 'R' })), text };
}

/**
 * Labels per approval, 1 (bad outcome), 0, or null (unknown):
 * - gateFailed: the approval's own gate result failed, or a post-rebase
 *   verification failure was recorded on its lane before the lane's next
 *   approval. Negative only when the approval was approved with no failure.
 * - operatorRejected: resolved by desktop or mobile; positive when rejected.
 * - mergedClean: the packet's outcome row says merged_clean = 0 (positive) or
 *   1, attached to the packet's last approved approval.
 */
export function labelApprovals(approvals, laneEvents, outcomes) {
  const failuresByLane = new Map();
  for (const event of laneEvents) {
    const list = failuresByLane.get(event.lane_id) ?? [];
    list.push(toMs(event.timestamp));
    failuresByLane.set(event.lane_id, list);
  }
  const byLane = new Map();
  for (const approval of approvals) {
    if (!approval.lane_id) continue;
    const list = byLane.get(approval.lane_id) ?? [];
    list.push(approval);
    byLane.set(approval.lane_id, list);
  }
  const outcomeByPacket = new Map();
  for (const outcome of outcomes) outcomeByPacket.set(outcome.packet_id, outcome.merged_clean);
  const lastApprovedByPacket = new Map();
  for (const approval of approvals) {
    if (approval.packet_id && approval.status === 'approved') lastApprovedByPacket.set(approval.packet_id, approval.id);
  }

  const labels = new Map();
  for (const approval of approvals) {
    const gate = parseJson(approval.gate_result_json);
    let gateFailed = gate && gate.passed === false ? 1 : null;
    if (gateFailed === null && approval.lane_id) {
      const siblings = byLane.get(approval.lane_id);
      const next = siblings.find((other) => other.created_at > approval.created_at);
      const failed = (failuresByLane.get(approval.lane_id) ?? [])
        .some((at) => at >= approval.created_at && (!next || at < next.created_at));
      if (failed) gateFailed = 1;
    }
    if (gateFailed === null && approval.status === 'approved') gateFailed = 0;

    const resolution = parseJson(approval.resolution_json);
    const operatorRejected = resolution && OPERATOR_ACTORS.has(resolution.actor)
      ? (resolution.action === 'rejected' || approval.status === 'rejected' ? 1 : 0)
      : null;

    let mergedClean = null;
    if (approval.packet_id && lastApprovedByPacket.get(approval.packet_id) === approval.id && outcomeByPacket.has(approval.packet_id)) {
      mergedClean = outcomeByPacket.get(approval.packet_id) === 0 ? 1 : 0;
    }
    labels.set(approval.id, { gateFailed, operatorRejected, mergedClean });
  }
  return labels;
}

/** Read everything the replay needs from a read-only connection. Writes nothing. */
export async function loadReplayHistory(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const notes = [];
  try {
    const approvals = safeAll(db, `
      SELECT id, packet_id, lane_id, status, created_at, diff_json, gate_result_json, resolution_json
      FROM approvals WHERE diff_json IS NOT NULL ORDER BY created_at, id
    `, notes, 'approvals');
    const laneEvents = safeAll(db, `
      SELECT lane_id, verb, timestamp FROM lane_events
      WHERE verb IN (${GATE_FAILURE_VERBS.map((verb) => `'${verb}'`).join(', ')})
    `, notes, 'lane events');
    const outcomes = safeAll(db, `
      SELECT packet_id, merged_clean FROM session_outcomes
      WHERE packet_id IS NOT NULL AND merged_clean IS NOT NULL
      ORDER BY completed_at, id
    `, notes, 'session outcomes');
    return { approvals, laneEvents, outcomes, notes };
  } finally {
    db.close();
  }
}

/** Collapse approvals into distinct diffs by the hash of the sanitized state. */
export function collapseDiffs(approvals, labels, buildDiffState) {
  const groups = new Map();
  let withoutDiffText = 0;
  for (const approval of approvals) {
    const input = approvalDiffInput(parseJson(approval.diff_json));
    if (!input) { withoutDiffText += 1; continue; }
    const built = buildDiffState(input.files, input.text);
    const hash = createHash('sha256').update(JSON.stringify(built.state)).digest('hex');
    let group = groups.get(hash);
    if (!group) {
      group = { hash, built, approvalIds: [], packets: [], labels: {}, conflicts: [] };
      groups.set(hash, group);
    }
    group.approvalIds.push(approval.id);
    const packet = approval.packet_id ?? `approval:${approval.id}`;
    if (!group.packets.includes(packet)) group.packets.push(packet);
    const approvalLabels = labels.get(approval.id);
    for (const label of LABELS) {
      const value = approvalLabels[label];
      if (value === null) continue;
      const previous = group.labels[label];
      if (previous !== undefined && previous !== value && !group.conflicts.includes(label)) group.conflicts.push(label);
      group.labels[label] = Math.max(previous ?? 0, value);
    }
  }
  return { groups: [...groups.values()], withoutDiffText };
}


/**
 * A dedup group whose approvals span several packets is folded under its
 * first packet on purpose: identical sanitized states are one observation, so
 * the group must sit in exactly one leave-one-packet-out fold, never in both
 * the training set and the held-out set.
 */
function renderLabel(label, predictor, groups, lines) {
  const labeled = groups.filter((group) => group.labels[label] !== undefined && group.answers);
  const rows = [];
  let abstained = 0;
  for (const group of labeled) {
    const p = PREDICTORS[predictor](group.answers);
    if (p === null) { abstained += 1; continue; }
    rows.push({ p, y: group.labels[label], packet: group.packets[0] });
  }
  const summary = summarize(rows);
  lines.push(`${label} by ${predictor}: n=${summary.n} distinct diffs (positives ${summary.positives}, negatives ${summary.negatives}, abstained ${abstained})`);
  lines.push(`  AUC ${fmt(summary.auc)} (n=${summary.n})  Brier ${fmt(summary.brier)} (n=${summary.n})`);
  lines.push('  reliability   bin        n  mean_p  observed');
  for (const bin of summary.reliability) {
    const range = `${bin.low.toFixed(1)}-${bin.high.toFixed(1)}`;
    lines.push(`                ${range.padEnd(9)} ${String(bin.n).padStart(3)}  ${fmt(bin.meanPredicted, 2).padStart(6)}  ${fmt(bin.observedRate, 2).padStart(8)}`);
  }
  const lopo = summary.leaveOnePacketOut;
  lines.push(`  catch-every-positive threshold, leave-one-packet-out (${lopo.scoredFolds} of ${lopo.folds} packets scored): false alarms ${lopo.falseAlarms} of ${lopo.negativesEvaluated} negatives, missed ${lopo.misses} of ${lopo.positivesEvaluated} positives, ${lopo.rowsWithoutTrainingPositive} diffs had no positive outside their packet`);
  return { predictor, abstained, ...summary };
}

/** Run one recorded label; `error` is set when its history could not be opened. */
async function runRecordedLabel(name, paths) {
  const entry = RECORDED_LABELS[name];
  let history;
  try {
    history = await entry.load(paths);
  } catch (error) {
    // Name the path this loader read: the database for most labels, the data dir for compaction.
    const source = entry.source ? entry.source(paths) : paths.dbPath;
    return { error: `cannot open ${source} read-only: ${error instanceof Error ? error.message : 'open failed'}` };
  }
  const labeled = entry.label(history);
  return { labeled, report: entry.render(labeled) };
}

export function renderReport({ groups, approvalsRead, withoutDiffText, notes, calls, only = null }) {
  const lines = [];
  const duplicates = groups.reduce((sum, group) => sum + group.approvalIds.length - 1, 0);
  lines.push(`approvals with diff_json: ${approvalsRead}; without diff text: ${withoutDiffText}`);
  lines.push(`distinct diffs by sanitized-state hash: ${groups.length} (collapsed ${duplicates} duplicate approvals)`);
  const conflicts = groups.filter((group) => group.conflicts.length > 0).length;
  if (conflicts) lines.push(`distinct diffs whose approvals disagree on a label (counted positive): ${conflicts}`);
  lines.push(`calls: ${calls.asked} asked, ${calls.answered} answered, ${calls.failed} failed`);
  for (const note of notes) lines.push(`note: ${note}`);
  lines.push('');
  const results = {};
  for (const label of only ? [only] : LABELS) {
    const answered = groups.filter((group) => group.labels[label] !== undefined && group.answers);
    const positives = answered.filter((group) => group.labels[label] === 1).length;
    const negatives = answered.length - positives;
    if (positives === 0 || negatives === 0) {
      lines.push(`${label}: ${positives === 0 ? 'no positives' : 'no negatives'}, skipped (n=${answered.length} labeled distinct diffs)`, '');
      results[label] = { skipped: positives === 0 ? 'no positives' : 'no negatives', n: answered.length };
      continue;
    }
    results[label] = Object.keys(PREDICTORS).map((predictor) => renderLabel(label, predictor, groups, lines));
    lines.push('');
  }
  const diffChars = groups.reduce((sum, group) => sum + (group.usage ? group.built.state.diff.length : 0), 0);
  const inputTokens = groups.reduce((sum, group) => sum + (group.usage?.inputTokens ?? 0), 0);
  const spendUsd = inputTokens * USD_PER_BILLION_INPUT_TOKENS / 1e9;
  lines.push(`diff chars per input token: ${inputTokens > 0 ? fmt(diffChars / inputTokens, 2) : 'n/a'} (${diffChars} chars over ${inputTokens} input tokens, n=${calls.answered} calls)`);
  lines.push(`spend: $${spendUsd.toFixed(6)} at $${USD_PER_BILLION_INPUT_TOKENS} per billion input tokens (n=${calls.answered} calls)`);
  return { text: lines.join('\n'), results, inputTokens, diffChars, spendUsd };
}

function dataPaths() {
  // Same precedence as getDataDir, resolved here so the one-time data-dir
  // migration never runs: this script must not write.
  const dataDir = process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8');
  return { dataDir, dbPath: process.env.CORTEX_IDE_DB_PATH || path.join(dataDir, 'cortex-ide.db') };
}

/**
 * Run the replay. Returns the exit code. `io.endpoint` and `io.retryBaseMs`
 * exist for the test fixture; the command line has no endpoint flag.
 */
export async function runReplay(argv, io = {}) {
  const out = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const parsed = parseReplayArgs(argv);
  if (parsed.error) { err(`[judgment-replay] ${parsed.error}`); return 1; }
  const { options } = parsed;
  if (options.help) { out(USAGE); return 0; }

  if (options.label && Object.hasOwn(RECORDED_LABELS, options.label)) {
    const run = await runRecordedLabel(options.label, dataPaths());
    if (run.error) { err(`[judgment-replay] ${run.error}`); return 1; }
    out(run.report.text);
    if (options.out) {
      writeFileSync(options.out, `${JSON.stringify({ generatedAt: new Date().toISOString(), label: options.label, notes: run.labeled.notes, result: run.report.result, rows: run.labeled.rows }, null, 2)}\n`);
      out(`wrote ${options.out}`);
    }
    return 0;
  }

  if (options.label === ALL_RECORDED_LABEL) {
    const paths = dataPaths();
    const labels = {};
    let failed = false;
    for (const name of Object.keys(RECORDED_LABELS)) {
      const run = await runRecordedLabel(name, paths);
      out(`== ${name} ==`);
      if (run.error) { err(`[judgment-replay] ${name}: ${run.error}`); failed = true; continue; }
      out(run.report.text);
      out('');
      labels[name] = { notes: run.labeled.notes, result: run.report.result, rows: run.labeled.rows };
    }
    out(`recorded labels: ${Object.entries(labels).map(([name, entry]) => `${name} ${entry.rows.length} rows`).join(', ')}`);
    out('total spend: $0.000000, no provider calls');
    if (options.out) {
      writeFileSync(options.out, `${JSON.stringify({ generatedAt: new Date().toISOString(), label: ALL_RECORDED_LABEL, spendUsd: 0, labels }, null, 2)}\n`);
      out(`wrote ${options.out}`);
    }
    return failed ? 1 : 0;
  }

  const [{ buildDiffState }, { DIFF_QUESTIONS }, { TYPESAFE_MODEL }] = await Promise.all([
    import('../src/lib/judgment/diff-state.ts'),
    import('../src/lib/judgment/questions.ts'),
    import('../src/lib/judgment/client.ts'),
  ]);

  if (!options.dryRun) {
    const { getOperatorDefaultsSync } = await import('../src/lib/operator/defaults.ts');
    if (getOperatorDefaultsSync().values.judgmentProvider === 'off') {
      err('[judgment-replay] judgment.provider is off. Turn it on in Settings (diff content leaves the machine when it is on), or pass --dry-run to print the request bodies without sending.');
      return 2;
    }
    const { readJudgmentApiKey } = await import('../src/lib/judgment/key.ts');
    if (!readJudgmentApiKey()) {
      err('[judgment-replay] no judgment key is configured (O8_JUDGMENT_API_KEY or the judgment-api-key file in the data dir).');
      return 2;
    }
  }

  const { dbPath } = dataPaths();
  let history;
  try {
    history = await loadReplayHistory(dbPath);
  } catch (error) {
    err(`[judgment-replay] cannot open ${dbPath} read-only: ${error instanceof Error ? error.message : 'open failed'}`);
    return 1;
  }
  const labels = labelApprovals(history.approvals, history.laneEvents, history.outcomes);
  const collapsed = collapseDiffs(history.approvals, labels, buildDiffState);
  const groups = options.limit ? collapsed.groups.slice(0, options.limit) : collapsed.groups;
  const calls = { asked: 0, answered: 0, failed: 0 };

  if (options.dryRun) {
    groups.forEach((group, index) => {
      out(`request ${index + 1}/${groups.length} approvals=${group.approvalIds.join(',')} packets=${group.packets.join(',')}`);
      out(JSON.stringify({ model: TYPESAFE_MODEL, state: group.built.state, questions: DIFF_QUESTIONS }));
    });
    out(`dry run: ${groups.length} request bodies printed, nothing sent (${history.approvals.length} approvals with diff_json, ${collapsed.groups.length} distinct diffs)`);
    return 0;
  }

  const { askJudgment } = await import('../src/lib/judgment/client.ts');
  for (const group of groups) {
    calls.asked += 1;
    const result = await askJudgment({
      state: group.built.state,
      questions: DIFF_QUESTIONS,
      context: {
        packetId: group.packets[0].startsWith('approval:') ? null : group.packets[0],
        approvalId: group.approvalIds[0],
        surface: SURFACE,
        truncated: group.built.truncated,
        hiddenText: group.built.hiddenText,
      },
    }, { ...(io.endpoint ? { endpoint: io.endpoint } : {}), ...(io.retryBaseMs !== undefined ? { retryBaseMs: io.retryBaseMs } : {}) });
    if (!result) { calls.failed += 1; continue; }
    calls.answered += 1;
    group.answers = result.answers;
    group.usage = result.usage;
    group.model = result.model;
    group.receiptId = result.receiptId;
  }

  const report = renderReport({
    groups,
    approvalsRead: history.approvals.length,
    withoutDiffText: collapsed.withoutDiffText,
    notes: history.notes,
    calls,
    only: options.label,
  });
  out(report.text);

  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      surface: SURFACE,
      approvalsWithDiff: history.approvals.length,
      distinctDiffs: collapsed.groups.length,
      calls,
      inputTokens: report.inputTokens,
      diffChars: report.diffChars,
      spendUsd: report.spendUsd,
      labels: report.results,
      diffs: groups.map((group) => ({
        hash: group.hash,
        approvalIds: group.approvalIds,
        packets: group.packets,
        labels: group.labels,
        conflicts: group.conflicts,
        truncated: group.built.truncated,
        hiddenText: group.built.hiddenText,
        model: group.model ?? null,
        receiptId: group.receiptId ?? null,
        usage: group.usage ?? null,
        answers: group.answers ?? null,
      })),
    }, null, 2)}\n`);
    out(`wrote ${options.out}`);
  }
  return calls.answered === 0 && calls.asked > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  if (process.env[TSX_MARKER] !== '1') {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const child = spawnSync(
      process.execPath,
      ['--conditions=react-server', '--import', 'tsx', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        env: { ...process.env, [TSX_MARKER]: '1', TSX_TSCONFIG_PATH: path.join(repoRoot, 'tsconfig.json') },
        stdio: 'inherit',
      },
    );
    process.exit(child.status ?? 1);
  }
  runReplay(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[judgment-replay] failed: ${error instanceof Error ? error.message : 'error'}\n`);
      process.exit(1);
    },
  );
}
