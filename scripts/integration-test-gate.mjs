#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { splitIntegrationFiles } from './lib/integration-shards.mjs';
import { classifyAgainstBaseline, loadRedBaseline } from './lib/red-baseline.mjs';

const root = process.cwd();
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const classification = JSON.parse(readFileSync(join(root, 'tests/test-classification.json'), 'utf8'));
const testPlan = process.env.O8_INTEGRATION_TEST_MODE === '1' && process.env.O8_INTEGRATION_TEST_PLAN
  ? JSON.parse(readFileSync(process.env.O8_INTEGRATION_TEST_PLAN, 'utf8'))
  : null;
const integrationConfig = testPlan?.config ?? 'config/vitest/vitest.integration.config.ts';
const shard = /^(\d+)\/(\d+)$/.exec(process.env.O8_INTEGRATION_SHARD ?? '');
const manifestFiles = testPlan?.files ?? classification.resourceOwning.map((entry) => entry.path);
// O8_INTEGRATION_SHARD=k/n packs longest-first by measured seconds so slow
// files clustered in manifest order cannot overload the last weekly shard.
// Test plans use the same packing with an optional fixture weights file.
const allFiles = shard
  ? splitIntegrationFiles(manifestFiles, JSON.parse(readFileSync(
    testPlan?.weightsPath ?? join(root, 'tests/integration-weights.json'), 'utf8',
  )), Number(shard[2]))[Number(shard[1]) - 1].files
  : manifestFiles;
const filters = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const files = filters.length === 0
  ? allFiles
  : allFiles.filter((path) => filters.some((filter) => path === filter || path.includes(filter)));
const RETAIN_RECEIPT = '.o8-test-run-retain.json';
const heartbeatMs = Number(process.env.O8_TEST_GATE_HEARTBEAT_MS || 60_000);
const configuredFileTimeoutMs = Number(process.env.O8_TEST_GATE_FILE_TIMEOUT_MS);
const fileTimeoutMs = Number.isFinite(configuredFileTimeoutMs) && configuredFileTimeoutMs > 0
  ? configuredFileTimeoutMs
  : 15 * 60_000;
let activeChild = null;
let activeMarker = null;
let interruptedBy = null;

if (files.length === 0) {
  console.error('[integration-gate] no resource-owning test matched the requested filters');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Vitest compares filters with canonical discovered paths. Resolve aliases
// first, and report unavailable selections before starting a child.
function resolveFilterPath(file) {
  const absolute = isAbsolute(file) ? file : join(root, file);
  try {
    return { path: realpathSync(absolute), errorCode: null };
  } catch (error) {
    return { path: absolute, errorCode: error?.code ?? 'UNKNOWN' };
  }
}

// ps includes process environments and can exceed spawnSync's 1 MiB default.
// Bound the snapshot at 64 MiB; timeouts, larger output, and failed scans must
// still leave process-tree settlement unconfirmed.
const MARKER_SCAN_MAX_BUFFER = 64 * 1024 * 1024;

let lastMarkerProbeDiagnostic = null;

function markerPids(marker) {
  if (!marker || process.platform === 'win32') return null;
  // `axeww -o` is accepted by both BSD ps and Linux procps; the older
  // `eww -axo` form exits 1 on Linux runners, failing every file (#2391).
  const receipt = spawnSync('ps', ['axeww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: MARKER_SCAN_MAX_BUFFER,
    windowsHide: true,
  });
  if (receipt.error || receipt.status !== 0) {
    lastMarkerProbeDiagnostic = {
      errorCode: receipt.error?.code ?? null,
      exitStatus: receipt.status ?? null,
      signal: receipt.signal ?? null,
      stdoutBytes: typeof receipt.stdout === 'string' ? Buffer.byteLength(receipt.stdout) : 0,
    };
    return null;
  }
  lastMarkerProbeDiagnostic = null;
  const needle = `O8_TEST_FILE_MARKER=${marker}`;
  return (receipt.stdout ?? '').split('\n').flatMap((line) => {
    if (!line.includes(needle)) return [];
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
    return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  });
}

function describeProbeDiagnostic(diagnostic) {
  if (!diagnostic) return 'process scan unavailable';
  const parts = [
    diagnostic.errorCode ? `errorCode=${diagnostic.errorCode}` : null,
    diagnostic.exitStatus !== null && diagnostic.exitStatus !== undefined ? `exitStatus=${diagnostic.exitStatus}` : null,
    diagnostic.signal ? `signal=${diagnostic.signal}` : null,
    `stdoutBytes=${diagnostic.stdoutBytes}`,
  ].filter(Boolean);
  return `process scan unavailable (${parts.join(', ')})`;
}

function groupAlive(child) {
  if (!child?.pid || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function childAlive(child) {
  if (!child?.pid) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function remainingTreePids(child, marker, markerState = markerPids(marker)) {
  const pids = new Set(markerState ?? []);
  if (groupAlive(child) && child?.pid) pids.add(child.pid);
  return [...pids].sort((a, b) => a - b);
}

async function settle(child, marker, firstSignal = 'SIGTERM') {
  if (!child?.pid) return { confirmed: false, remainingPids: [], probeUnavailable: false, diagnostic: null };
  for (const [signal, waitMs] of [
    [firstSignal, 500],
    ['SIGTERM', 750],
    ['SIGKILL', 1_000],
  ]) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          encoding: 'utf8',
          timeout: 5_000,
          windowsHide: true,
        });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {}
    if (process.platform === 'win32') {
      try { child.kill(signal); } catch {}
    }
    for (const pid of markerPids(marker) ?? []) {
      try { process.kill(pid, signal); } catch {}
    }
    await sleep(waitMs);
    if (process.platform === 'win32' && !childAlive(child)) {
      return { confirmed: true, remainingPids: [], probeUnavailable: false, diagnostic: null };
    }
    const remaining = markerPids(marker);
    if (!groupAlive(child) && remaining !== null && remaining.length === 0) {
      return { confirmed: true, remainingPids: [], probeUnavailable: false, diagnostic: null };
    }
  }
  if (process.platform === 'win32') {
    const alive = childAlive(child);
    return {
      confirmed: !alive,
      remainingPids: alive ? [child.pid] : [],
      probeUnavailable: false,
      diagnostic: null,
    };
  }
  const remaining = markerPids(marker);
  const alive = groupAlive(child);
  const confirmed = !alive && remaining !== null && remaining.length === 0;
  const probeUnavailable = !confirmed && !alive && remaining === null;
  return {
    confirmed,
    remainingPids: confirmed ? [] : remainingTreePids(child, marker, remaining),
    probeUnavailable,
    diagnostic: probeUnavailable ? lastMarkerProbeDiagnostic : null,
  };
}

function timeoutSeconds(timeoutMs) {
  const seconds = timeoutMs / 1_000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

function writeTimeoutReceipt(fixtureRoot, file, timeoutMs) {
  const receiptPath = join(fixtureRoot, RETAIN_RECEIPT);
  try {
    writeFileSync(receiptPath, `${JSON.stringify({
      retainedAt: new Date().toISOString(),
      reason: 'test_gate_file_timeout',
      file,
      timeoutMs,
    })}\n`, { flag: 'wx' });
    return receiptPath;
  } catch (error) {
    console.error(
      `[integration-gate] could not write timeout receipt for ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function retainedReceipts(directory, results = []) {
  if (!existsSync(directory)) return results;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) retainedReceipts(path, results);
    else if (entry.isFile() && entry.name === RETAIN_RECEIPT) results.push(path);
  }
  return results;
}

function parseReport(reportPath, file) {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const failedFile = report.testResults?.find((result) => result.status === 'failed');
    const failedAssertion = failedFile?.assertionResults?.find((result) => result.status === 'failed');
    return {
      total: Number(report.numTotalTests ?? 0),
      passed: Number(report.numPassedTests ?? 0),
      failed: Number(report.numFailedTests ?? 0),
      pending: Number(report.numPendingTests ?? 0),
      firstFailure: failedAssertion?.fullName || failedAssertion?.title || failedFile?.name || file,
    };
  } catch {
    return { total: 0, passed: 0, failed: 0, pending: 0, firstFailure: file };
  }
}

function appendBounded(current, chunk, limit = 2 * 1024 * 1024) {
  const next = `${current}${String(chunk)}`;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

/**
 * Base for per-file fixture roots.
 *
 * NOT `os.tmpdir()`. On macOS that resolves to a 49-character
 * `/var/folders/<...>/T/` path, and the fixture root nests twice more before a
 * child process gets to create anything: the gate's own directory, then the
 * suite's `o8-test-data-run-*` (which `tests/global-test-data-dir.ts` also
 * assigns to TMPDIR). By the time tsx builds its IPC pipe at
 * `$TMPDIR/tsx-<uid>/<pid>.pipe` the path is 118 characters, past the 104-char
 * limit for unix socket paths — so every cross-process test died with
 * EADDRINUSE before its own logic ran. Measured: a 114-char TMPDIR reproduces
 * it; the default passes clean.
 *
 * A short base keeps the same nesting inside budget (58 characters).
 */
const FIXTURE_BASE = process.platform === 'win32' ? tmpdir() : '/tmp';

async function runFile(file, index) {
  const startedAt = Date.now();
  const resolved = resolveFilterPath(file);
  if (resolved.errorCode) {
    const durationMs = Date.now() - startedAt;
    const error = `selected file cannot be resolved (${resolved.errorCode}): ${resolved.path}`;
    console.log(`[integration-gate] ${index + 1}/${files.length} FAIL ${file} · 0/0 passed · ${(durationMs / 1000).toFixed(1)}s · ${error}`);
    return {
      file,
      code: 1,
      signal: null,
      error,
      durationMs,
      retained: [],
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      firstFailure: file,
    };
  }
  const fixtureRoot = mkdtempSync(join(FIXTURE_BASE, 'o8g-'));
  const reportPath = join(fixtureRoot, 'vitest-report.json');
  const marker = randomUUID().replace(/-/g, '');
  const env = {
    ...process.env,
    CORTEX_IDE_DATA_DIR: fixtureRoot,
    O8_TEST_FIXTURE_SWEEP_PARENT: fixtureRoot,
    O8_TEST_FILE_MARKER: marker,
    O8_TEST_GATE_REPORT_PATH: reportPath,
  };
  delete env.O8_DATA_DIR;
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [
    vitest,
    'run',
    '--config',
    integrationConfig,
    resolved.path,
  ], {
    cwd: root,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChild = child;
  activeMarker = marker;
  child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
  const heartbeat = setInterval(() => {
    console.log(`[integration-gate] ${index + 1}/${files.length} ${file} heartbeat (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }, Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 60_000);
  heartbeat.unref();
  const outcome = await new Promise((resolve) => {
    let decided = false;
    const finish = (value) => {
      if (decided) return;
      decided = true;
      clearTimeout(hardTimeout);
      resolve(value);
    };
    const hardTimeout = setTimeout(() => {
      if (decided) return;
      decided = true;
      const reason = `timeout after ${timeoutSeconds(fileTimeoutMs)}s`;
      writeTimeoutReceipt(fixtureRoot, file, fileTimeoutMs);
      void settle(child, marker).then((treeSettlement) => {
        if (!treeSettlement.confirmed) {
          const namedPids = treeSettlement.remainingPids.length > 0
            ? treeSettlement.remainingPids.join(', ')
            : String(child.pid ?? 'unknown');
          console.error(
            `[integration-gate] TIMEOUT TREE UNCONFIRMED for ${file}; pids still reachable or unverifiable: ${namedPids}`,
          );
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({
          code: 1,
          signal: null,
          error: new Error(reason),
          timedOut: true,
          treeSettlement,
        });
      }).catch((error) => {
        const namedPids = remainingTreePids(child, marker);
        console.error(
          `[integration-gate] TIMEOUT TREE CLEANUP FAILED for ${file}; pids ${namedPids.join(', ') || child.pid || 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({
          code: 1,
          signal: null,
          error: new Error(reason),
          timedOut: true,
          treeSettlement: { confirmed: false, remainingPids: namedPids },
        });
      });
    }, fileTimeoutMs);
    child.once('error', (error) => finish({ code: 1, signal: null, error, timedOut: false }));
    child.once('exit', (code, signal) => finish({
      code: code ?? 1,
      signal,
      error: null,
      timedOut: false,
    }));
  });
  clearInterval(heartbeat);
  const markerState = markerPids(marker);
  const treeSettlement = outcome.treeSettlement ?? (process.platform === 'win32'
    ? (!childAlive(child)
        ? { confirmed: true, remainingPids: [] }
        : await settle(child, marker))
    : (groupAlive(child) || markerState === null || markerState.length > 0
        ? await settle(child, marker)
        : { confirmed: true, remainingPids: [] }));
  if (!treeSettlement.confirmed) {
    outcome.code = 1;
    const treeError = treeSettlement.probeUnavailable
      ? `integration fixture process tree could not be confirmed stopped; ${describeProbeDiagnostic(treeSettlement.diagnostic)}; process group exited`
      : `integration fixture process tree could not be confirmed stopped; pids: ${treeSettlement.remainingPids.join(', ') || child.pid || 'unknown'}`;
    outcome.error = new Error(outcome.timedOut && outcome.error
      ? `${outcome.error.message}; ${treeError}`
      : treeError);
  }
  if (activeChild === child) {
    activeChild = null;
    activeMarker = null;
  }
  const report = parseReport(reportPath, file);
  if (outcome.timedOut) {
    report.failed = Math.max(1, report.failed);
    report.firstFailure = `${file}: ${outcome.error.message}`;
  }
  let retained = retainedReceipts(fixtureRoot);
  if (outcome.timedOut && retained.length === 0) {
    writeTimeoutReceipt(fixtureRoot, file, fileTimeoutMs);
    retained = retainedReceipts(fixtureRoot);
  }
  if (retained.length === 0 && !outcome.timedOut) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } else if (outcome.timedOut && retained.length === 0) {
    console.error(`[integration-gate] timeout fixture retained without a readable receipt under ${fixtureRoot}`);
  }
  const durationMs = Date.now() - startedAt;
  const passed = outcome.code === 0 && !outcome.signal;
  const failureReason = !passed && outcome.error ? ` · ${outcome.error.message}` : '';
  console.log(`[integration-gate] ${index + 1}/${files.length} ${passed ? 'PASS' : 'FAIL'} ${file} · ${report.passed}/${report.total} passed · ${(durationMs / 1000).toFixed(1)}s${failureReason}`);
  if (!passed) {
    if (stdout.trim()) process.stdout.write(`${stdout.trimEnd()}\n`);
    if (stderr.trim()) process.stderr.write(`${stderr.trimEnd()}\n`);
  }
  if (retained.length > 0) {
    console.error(`[integration-gate] retained ${retained.length} timeout receipt${retained.length === 1 ? '' : 's'} under ${fixtureRoot}`);
  }
  return {
    file,
    code: outcome.code,
    signal: outcome.signal,
    error: outcome.error?.message ?? null,
    durationMs,
    retained,
    ...report,
  };
}

const requestInterrupt = (signal) => {
  if (interruptedBy) return;
  interruptedBy = signal;
  void settle(activeChild, activeMarker, signal);
};
const onSigint = () => requestInterrupt('SIGINT');
const onSigterm = () => requestInterrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

const results = [];
const startedAt = Date.now();
try {
  for (let index = 0; index < files.length && !interruptedBy; index += 1) {
    results.push(await runFile(files[index], index));
  }
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

const failures = results.filter((result) => result.code !== 0 || result.signal);
// O8_INTEGRATION_BASELINE names files already red on the CI runner (#2391).
// They still run; their failures are reported but do not fail the gate.
const baselinePath = process.env.O8_INTEGRATION_BASELINE;
const baseline = loadRedBaseline(baselinePath);
if (baselinePath && !baseline) {
  console.error(`[integration-gate] baseline ${baselinePath} unavailable; every failure counts`);
}
const verdict = classifyAgainstBaseline(
  results.map((result) => ({ file: result.file, failed: result.code !== 0 || Boolean(result.signal) })),
  baseline,
);
for (const file of verdict.baselineRed) console.log(`[integration-gate] baseline red ${file}`);
for (const file of verdict.nowGreen) {
  console.log(`[integration-gate] baseline file now green, remove it from the list: ${file}`);
}
const gatingFailures = failures.filter((result) => verdict.newRed.includes(result.file));
const totals = results.reduce((sum, result) => ({
  total: sum.total + result.total,
  passed: sum.passed + result.passed,
  failed: sum.failed + result.failed,
  pending: sum.pending + result.pending,
}), { total: 0, passed: 0, failed: 0, pending: 0 });
console.log(`[integration-gate] summary: ${results.length}/${files.length} files, ${totals.passed}/${totals.total} tests passed, ${failures.length} failed files, ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ran ${verdict.ran} · green ${verdict.green.length} · baseline red ${verdict.baselineRed.length} · new red ${verdict.newRed.length}`);
if (failures[0]) console.error(`[integration-gate] first cause: ${(gatingFailures[0] ?? failures[0]).firstFailure}`);

if (process.env.O8_TEST_GATE_REPORT_PATH) {
  writeFileSync(process.env.O8_TEST_GATE_REPORT_PATH, JSON.stringify({
    numTotalTests: totals.total,
    numPassedTests: totals.passed,
    numFailedTests: totals.failed,
    numPendingTests: totals.pending,
    testResults: failures.map((failure) => ({
      name: failure.file,
      status: 'failed',
      assertionResults: [{
        title: failure.firstFailure,
        fullName: failure.firstFailure,
        status: 'failed',
      }],
    })),
  }));
}

if (interruptedBy) process.exit(130);
process.exit(gatingFailures.length > 0 ? 1 : 0);
