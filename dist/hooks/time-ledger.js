#!/usr/bin/env node
'use strict';

/**
 * Time ledger hook. Agents cannot feel wall time, so o8 keeps the clock.
 *
 * - PostToolUse / PostToolUseFailure (Bash): record how long the command took,
 *   per repository, and tell the agent when a run was long.
 * - PreToolUse (Bash): when the command's median run is slow, stop a managed
 *   agent once and state the cost and what changed since the last run. The
 *   same command sent again starts. A paired operator session gets the same
 *   text as context and is never stopped.
 * - SessionStart: list the slowest commands in this repository.
 *
 * The ledger is one JSON file in the repository's Git common directory, so
 * every worktree of a repository shares it and Git never tracks it. The hook
 * fails open: any error lets the command run.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER_VERSION = 1;
const MAX_RUNS_PER_COMMAND = 20;
const MAX_COMMANDS = 300;
const MIN_RECORD_MS = 10_000;
const NOTE_MS = 30_000;
const SNAPSHOT_MS = 60_000;
const LIST_MS = 60_000;
const ACK_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_GATE_MS = 5 * 60_000;
const SKIPPED_SEGMENT = /^(cd|pushd|popd|export|source|\.|set|unset|echo|printf|true|:)(\s|$)/;
const WRAPPER = /^(time|nice|command|nohup|caffeinate(\s+-\w+)*|timeout\s+\S+|gtimeout\s+\S+)\s+/;

function gateMs() {
  const override = Number(process.env.O8_TIME_GATE_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_GATE_MS;
}

/** An o8 session or an o8 packet worker; anything else is the operator's own session. */
function isManagedAgent() {
  return process.env.O8_MANAGED_SESSION === '1' || Boolean(process.env.O8_OWNED_RUN_MARKER);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: options.timeout ?? 4_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: options.env ?? process.env,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Reduce a shell command to the part that costs time, so the same build run
 * from another worktree, with another output filter, lands on one key.
 */
function normalizeCommand(command, cwd) {
  if (typeof command !== 'string') return null;
  let text = command.split('\n')[0].trim();
  if (!text) return null;
  if (cwd) text = text.split(cwd).join('.');
  const segments = text.split(/\s*(?:&&|;)\s*/).map((segment) => {
    let part = segment.split(/\s\|\s/)[0];
    part = part.replace(/\s\d?>>?&?\s?\S+/g, ' ').trim();
    for (;;) {
      const next = part.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '').replace(WRAPPER, '');
      if (next === part) break;
      part = next;
    }
    return part.replace(/\s+/g, ' ').trim();
  }).filter((part) => part && !SKIPPED_SEGMENT.test(part));
  if (segments.length === 0) return null;
  return segments.join(' && ').slice(0, 200);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Median of the passing runs; a command that has never passed uses every run. */
function commandStats(entry) {
  const runs = entry && Array.isArray(entry.runs) ? entry.runs : [];
  const passing = runs.filter((run) => run.ok);
  const sample = passing.length > 0 ? passing : runs;
  return { medianMs: median(sample.map((run) => run.ms)), count: sample.length };
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function ledgerPath(cwd) {
  const commonDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return commonDir ? path.join(commonDir, 'o8', 'time-ledger.json') : null;
}

function emptyLedger() {
  return { version: LEDGER_VERSION, commands: {}, pending: {}, acks: {} };
}

function readLedger(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== LEDGER_VERSION) return emptyLedger();
    return { ...emptyLedger(), ...parsed };
  } catch {
    return emptyLedger();
  }
}

function pruneLedger(ledger, now) {
  for (const [id, stamp] of Object.entries(ledger.pending)) {
    if (now - stamp.at > PENDING_TTL_MS) delete ledger.pending[id];
  }
  for (const [id, at] of Object.entries(ledger.acks)) {
    if (now - at > ACK_TTL_MS) delete ledger.acks[id];
  }
  const keys = Object.keys(ledger.commands);
  if (keys.length > MAX_COMMANDS) {
    const lastRun = (key) => ledger.commands[key].runs.at(-1)?.at ?? 0;
    keys.sort((a, b) => lastRun(a) - lastRun(b));
    for (const key of keys.slice(0, keys.length - MAX_COMMANDS)) delete ledger.commands[key];
  }
}

function writeLedger(file, ledger, now) {
  pruneLedger(ledger, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/**
 * Hash the working tree, tracked and untracked, into a Git tree object. It
 * works on a private copy of the index, so it never takes the repository's
 * index lock and never changes what is staged.
 */
function snapshotTree(cwd) {
  const indexPath = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  if (!indexPath) return null;
  const temporaryIndex = path.join(os.tmpdir(), `o8-time-ledger-index-${process.pid}-${Date.now()}`);
  try {
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, temporaryIndex);
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    if (git(cwd, ['add', '-A'], { env, timeout: 8_000 }) === null) return null;
    return git(cwd, ['write-tree'], { env }) || null;
  } catch {
    return null;
  } finally {
    fs.rmSync(temporaryIndex, { force: true });
    fs.rmSync(`${temporaryIndex}.lock`, { force: true });
  }
}

function changedSince(cwd, previousTree) {
  if (!previousTree) return null;
  const currentTree = snapshotTree(cwd);
  if (!currentTree) return null;
  if (currentTree === previousTree) return { files: 0, lines: 0 };
  const stat = git(cwd, ['diff', '--shortstat', previousTree, currentTree]);
  if (stat === null) return null;
  const count = (pattern) => Number((stat.match(pattern) || [])[1] || 0);
  return {
    files: count(/(\d+) files? changed/),
    lines: count(/(\d+) insertions?/) + count(/(\d+) deletions?/),
  };
}

function describeChange(change) {
  if (!change) return '';
  if (change.files === 0) return ' Nothing has changed since its last run.';
  return ` ${plural(change.lines, 'line')} in ${plural(change.files, 'file')} changed since its last run.`;
}

/**
 * Commands this repository has timed at least twice at half the cost or less.
 * They are what an agent has already used here, so no ladder has to be declared.
 */
function shorterCommands(ledger, key, medianMs) {
  return Object.entries(ledger.commands)
    .filter(([other]) => other !== key)
    .map(([other, entry]) => ({ key: other, stats: commandStats(entry) }))
    .filter((row) => row.stats.count >= 2 && row.stats.medianMs * 2 <= medianMs)
    .sort((a, b) => b.stats.count - a.stats.count || a.stats.medianMs - b.stats.medianMs)
    .slice(0, 3);
}

function slowCommandText(key, stats, change, stopped, shorter) {
  const cost = `o8 clock: \`${key}\` takes about ${formatDuration(stats.medianMs)} here `
    + `(median of ${plural(stats.count, 'run')}).${describeChange(change)}`;
  const options = shorter.length > 0
    ? ` Shorter commands run here: ${shorter
      .map((row) => `\`${row.key}\` (${formatDuration(row.stats.medianMs)})`).join(', ')}.`
    : '';
  return stopped
    ? `${cost}${options} Finish every pending edit first, or run a narrower check. Send the same command again to start it.`
    : `${cost}${options} Batch pending edits before the next run.`;
}

function emit(eventName, fields) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, ...fields } })}\n`);
}

function handlePreToolUse(input, file, now) {
  const cwd = input.cwd || process.cwd();
  const toolInput = input.tool_input || {};
  const key = normalizeCommand(toolInput.command, cwd);
  if (!key) return;
  const ledger = readLedger(file);
  const stamp = () => {
    if (input.tool_use_id) ledger.pending[input.tool_use_id] = { key, at: now };
    writeLedger(file, ledger, now);
  };
  const entry = ledger.commands[key];
  const stats = commandStats(entry);
  if (toolInput.run_in_background === true || stats.count === 0 || stats.medianMs < gateMs()) {
    stamp();
    return;
  }
  const change = changedSince(cwd, entry.tree);
  const shorter = shorterCommands(ledger, key, stats.medianMs);
  if (!isManagedAgent()) {
    stamp();
    emit('PreToolUse', { additionalContext: slowCommandText(key, stats, change, false, shorter) });
    return;
  }
  const ackId = `${input.session_id || 'session'}:${key}`;
  if (ledger.acks[ackId] && now - ledger.acks[ackId] <= ACK_TTL_MS) {
    delete ledger.acks[ackId];
    stamp();
    return;
  }
  ledger.acks[ackId] = now;
  writeLedger(file, ledger, now);
  emit('PreToolUse', {
    permissionDecision: 'deny',
    permissionDecisionReason: slowCommandText(key, stats, change, true, shorter),
  });
}

function handlePostToolUse(input, file, now, ok) {
  const cwd = input.cwd || process.cwd();
  const toolInput = input.tool_input || {};
  const key = normalizeCommand(toolInput.command, cwd);
  if (!key) return;
  const ledger = readLedger(file);
  const pending = input.tool_use_id ? ledger.pending[input.tool_use_id] : undefined;
  if (input.tool_use_id) delete ledger.pending[input.tool_use_id];
  const measured = Number(input.duration_ms);
  const ms = Number.isFinite(measured) && measured >= 0
    ? Math.round(measured)
    : pending ? now - pending.at : null;
  const known = ledger.commands[key];
  if (ms === null || toolInput.run_in_background === true || (!known && ms < MIN_RECORD_MS)) {
    if (pending) writeLedger(file, ledger, now);
    return;
  }
  const entry = known || { runs: [], tree: null };
  entry.runs = [...entry.runs, { ms, ok, at: now }].slice(-MAX_RUNS_PER_COMMAND);
  if (ms >= SNAPSHOT_MS) entry.tree = snapshotTree(cwd) || entry.tree;
  ledger.commands[key] = entry;
  writeLedger(file, ledger, now);
  if (ok && ms >= NOTE_MS) {
    const stats = commandStats(entry);
    emit('PostToolUse', {
      additionalContext: `o8 clock: \`${key}\` took ${formatDuration(ms)} `
        + `(median ${formatDuration(stats.medianMs)} over ${plural(stats.count, 'run')}).`,
    });
  }
}

function handleSessionStart(file) {
  const ledger = readLedger(file);
  const slow = Object.entries(ledger.commands)
    .map(([key, entry]) => ({ key, stats: commandStats(entry) }))
    .filter((row) => row.stats.medianMs >= LIST_MS)
    .sort((a, b) => b.stats.medianMs - a.stats.medianMs)
    .slice(0, 5);
  if (slow.length === 0) return;
  const lines = slow.map((row) => `- \`${row.key}\`: about ${formatDuration(row.stats.medianMs)}`);
  emit('SessionStart', {
    additionalContext: `o8 clock, the slowest commands in this repository:\n${lines.join('\n')}\n`
      + 'Batch your edits before you run one, and prefer the narrowest check that proves the change.',
  });
}

async function main() {
  try {
    if (process.env.O8_TIME_LEDGER === '0') return;
    const input = JSON.parse(await readStdin());
    const file = ledgerPath(input.cwd || process.cwd());
    if (!file) return;
    const now = Date.now();
    const event = input.hook_event_name;
    if (event === 'SessionStart') handleSessionStart(file);
    else if (input.tool_name !== 'Bash') return;
    else if (event === 'PreToolUse') handlePreToolUse(input, file, now);
    else if (event === 'PostToolUse') handlePostToolUse(input, file, now, true);
    else if (event === 'PostToolUseFailure') handlePostToolUse(input, file, now, false);
  } catch {
    // Fail open: a clock that cannot read or write must never stop a command.
  }
}

if (require.main === module) {
  void main().then(() => process.exit(0));
}

module.exports = { commandStats, formatDuration, median, normalizeCommand };
