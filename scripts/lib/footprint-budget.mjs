import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const FOOTPRINT_BUDGET = Object.freeze({
  version: 5,
  targets: Object.freeze({
    appBundleBytes: 250 * MIB,
    updaterArchiveBytes: 75 * MIB,
    idlePhysicalBytes: 1 * GIB,
    idleCpuPercent: 5,
    nativeHostCpuPercent: 2,
    applicationServerCpuPercent: 5,
    realtimeServerCpuPercent: 5,
    webkitHelpersCpuPercent: 1,
    idleProcessSpawnsPerMinute: 0,
    persistentDataBytes: 1 * GIB,
  }),
  regressionCeilings: Object.freeze({
    appBundleBytes: 350 * MIB,
    updaterArchiveBytes: 110 * MIB,
    idlePhysicalBytes: 1536 * MIB,
    idleCpuPercent: 15,
    idleProcessChurn: 0,
    nativeHostCpuPercent: 5,
    applicationServerCpuPercent: 12,
    realtimeServerCpuPercent: 8,
    webkitHelpersCpuPercent: 10,
    nativeHostBytes: 640 * MIB,
    applicationServerBytes: 512 * MIB,
    realtimeServerBytes: 256 * MIB,
    webkitHelpersBytes: 512 * MIB,
  }),
});

const UNIT_BYTES = Object.freeze({
  B: 1,
  KB: 1024,
  MB: MIB,
  GB: GIB,
  TB: 1024 * GIB,
});

export const FOOTPRINT_SAMPLE_LIMITS = Object.freeze({
  defaultSamples: 1,
  maxSamples: 5,
});

// Churn identities are reported through a CLOSED vocabulary. A descriptor is
// only ever one of these fixed strings, so no operator command line, home path,
// token, or machine name can reach the release receipt through this field. The
// raw command is never digested either: a hash of a secret-bearing argv is still
// derived from the secret, and any fingerprint the sanitized fields could
// justify is already fully determined by those fields.
const CHILD_DESCRIPTORS = Object.freeze([
  ['applicationServer', /next-server/],
  ['realtimeServer', /ws-server\.mjs/],
  ['webkitContent', /WebKit\.WebContent/],
  ['webkitGpu', /WebKit\.GPU/],
  ['webkitNetwork', /WebKit\.Networking/],
  ['speechHelper', /speech_recognizer/],
  ['openFilesProbe', /(?:^|\/)lsof(?:\s|$)/],
  ['diskUsageProbe', /(?:^|\/)du(?:\s|$)/],
  ['processProbe', /(?:^|\/)ps(?:\s|$)/],
  ['versionControl', /(?:^|\/)git(?:\s|$)/],
  ['shell', /(?:^|\/)(?:sh|bash|zsh)(?:\s|$)/],
  ['nodeRuntime', /(?:^|\/)node(?:\s|$)/],
]);

const CHURN_IDENTITY_LIMIT = 64;

export function sanitizeCommandDescriptor(command) {
  const text = String(command ?? '');
  for (const [descriptor, pattern] of CHILD_DESCRIPTORS) {
    if (pattern.test(text)) return descriptor;
  }
  return 'unclassified';
}

// One redaction primitive for the identities the harness retains: a truncated
// SHA-256 that correlates repeat occurrences without disclosing the value.
// NOT used on process command lines — see describeChurnedProcess.
export function redactedDigest(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12);
}

export function resolveIdleSampleCount(value, limits = FOOTPRINT_SAMPLE_LIMITS) {
  if (value === undefined || value === null || String(value).trim() === '') return limits.defaultSamples;
  const count = Number(String(value).trim());
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`idle sample count must be a positive integer: ${value}`);
  }
  if (count > limits.maxSamples) {
    throw new Error(`idle sample count ${count} exceeds the bound of ${limits.maxSamples}`);
  }
  return count;
}

// Identifies the exact binary under test WITHOUT publishing its path: the digest
// covers the executable's ACTUAL BYTES plus the build identity. Size and mtime
// were not enough — a rebuild that lands the same length, or a touched file,
// would have let two different binaries share one digest and let a series claim
// samples came from one artifact when they did not. Read in bounded chunks so a
// 100 MiB Mach-O never lands in memory at once; only 16 hex chars reach receipts.
export function hashFileBytes(filePath, { chunkBytes = 1024 * 1024, io = { openSync, readSync, closeSync } } = {}) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const handle = io.openSync(filePath, 'r');
  try {
    for (;;) {
      const bytesRead = io.readSync(handle, buffer, 0, chunkBytes, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    io.closeSync(handle);
  }
  return hash.digest('hex');
}

export function computeArtifactDigest(appPath, { version = '', gitSha = '', executablePath, ...options } = {}) {
  const executable = executablePath ?? path.join(appPath, 'Contents', 'MacOS', 'o8');
  return createHash('sha256')
    .update(`${version}|${gitSha}|${hashFileBytes(executable, options)}`)
    .digest('hex')
    .slice(0, 16);
}

export function parseFootprintBytes(output) {
  const match = String(output).match(/\bFootprint:\s*([\d.]+)\s*(B|KB|MB|GB|TB)\b/);
  if (!match) throw new Error('physical footprint was absent from footprint output');
  const bytes = Number(match[1]) * UNIT_BYTES[match[2]];
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('physical footprint was invalid');
  return Math.round(bytes);
}

export function parseCpuTimeSeconds(value) {
  const match = String(value).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`invalid CPU time: ${value}`);
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24) + hours) * 60 + minutes) * 60 + seconds;
}

export function parseProcessTable(output) {
  const processes = new Map();
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      ppid: Number(match[2]),
      cpuTimeSeconds: parseCpuTimeSeconds(match[3]),
      command: match[4].trim(),
    });
  }
  return processes;
}

export function snapshotProcesses(run = execFileSync) {
  return parseProcessTable(run('ps', ['-axo', 'pid=,ppid=,lstart=,time=,command='], { encoding: 'utf8' }));
}

export function descendantPids(processes, rootPid) {
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes.values()) {
      if (!found.has(process.pid) && found.has(process.ppid)) {
        found.add(process.pid);
        changed = true;
      }
    }
  }
  return found;
}

export function webkitPids(processes) {
  return new Set([...processes.values()]
    .filter((process) => process.command.includes('/WebKit.framework/') && process.command.includes('.xpc/'))
    .map((process) => process.pid));
}

function setDifference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function classifyProcess(process, rootPid) {
  if (process.pid === rootPid) return 'nativeHost';
  if (process.command.includes('WebKit.WebContent')) return 'webkitContent';
  if (process.command.includes('WebKit.GPU')) return 'webkitGpu';
  if (process.command.includes('WebKit.Networking')) return 'webkitNetwork';
  if (process.command.includes('next-server')) return 'applicationServer';
  if (process.command.includes('ws-server.mjs')) return 'realtimeServer';
  if (process.command.includes('speech_recognizer')) return 'speechHelper';
  return 'otherChild';
}

function ownedPids(processes, rootPid, webkitBaseline) {
  const descendants = descendantPids(processes, rootPid);
  const newWebkit = setDifference(webkitPids(processes), webkitBaseline);
  return new Set([...descendants, ...newWebkit]);
}

function countProcessesByComponent(pids, processes, rootPid) {
  const counts = {};
  for (const pid of pids) {
    const process = processes.get(pid);
    if (!process) continue;
    const key = classifyProcess(process, rootPid);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function processDepthFromRoot(processes, pid, rootPid) {
  let current = processes.get(pid);
  let depth = 0;
  while (current && current.pid !== rootPid && depth < 32) {
    current = processes.get(current.ppid);
    depth += 1;
  }
  if (!current || current.pid !== rootPid) return null;
  return depth;
}

function describeChurnedProcess(process, lifecycle, processes, ownedPids, rootPid) {
  const parent = processes.get(process.ppid);
  return {
    lifecycle,
    component: classifyProcess(process, rootPid),
    descriptor: sanitizeCommandDescriptor(process.command),
    depthFromRoot: processDepthFromRoot(processes, process.pid, rootPid),
    parentComponent: parent && ownedPids.has(parent.pid) ? classifyProcess(parent, rootPid) : 'external',
  };
}

// Every churned child keeps a retained, sanitized identity so a churn verdict
// can be explained after the fact. Order is content-derived, never pid order,
// so two runs of the same behaviour produce comparable receipts.
export function buildChurnIdentities({ spawned, exited, before, after, beforeOwned, afterOwned, rootPid, limit = CHURN_IDENTITY_LIMIT }) {
  const identities = [];
  for (const pid of spawned) {
    const process = after.get(pid);
    if (process) identities.push(describeChurnedProcess(process, 'spawned', after, afterOwned, rootPid));
  }
  for (const pid of exited) {
    const process = before.get(pid);
    if (process) identities.push(describeChurnedProcess(process, 'exited', before, beforeOwned, rootPid));
  }
  identities.sort((left, right) => (
    left.lifecycle.localeCompare(right.lifecycle)
    || left.component.localeCompare(right.component)
    || left.descriptor.localeCompare(right.descriptor)
    || left.parentComponent.localeCompare(right.parentComponent)
    || ((left.depthFromRoot ?? -1) - (right.depthFromRoot ?? -1))
  ));
  return {
    identities: identities.slice(0, limit),
    truncatedIdentityCount: Math.max(0, identities.length - limit),
  };
}

export function measureDiskBytes(target, run = execFileSync) {
  const output = run('du', ['-sk', target], { encoding: 'utf8' });
  const kib = Number(String(output).trim().split(/\s+/)[0]);
  if (!Number.isFinite(kib) || kib < 0) throw new Error(`invalid disk usage for ${target}`);
  return kib * 1024;
}

export function measureProcessPhysicalBytes(pid, run = execFileSync) {
  const output = run('footprint', ['-p', String(pid)], { encoding: 'utf8' });
  return parseFootprintBytes(output);
}

function sameProcessIdentity(left, right) {
  return left?.pid === right?.pid
    && left?.ppid === right?.ppid
    && left?.command === right?.command;
}

function measureStableProcessPhysicalBytes(expected, run) {
  const beforeProbe = snapshotProcesses(run).get(expected.pid);
  if (!sameProcessIdentity(expected, beforeProbe)) return null;
  try {
    const bytes = measureProcessPhysicalBytes(expected.pid, run);
    const afterProbe = snapshotProcesses(run).get(expected.pid);
    return sameProcessIdentity(beforeProbe, afterProbe) ? bytes : null;
  } catch (error) {
    const afterFailure = snapshotProcesses(run).get(expected.pid);
    if (!sameProcessIdentity(beforeProbe, afterFailure)) return null;
    throw error;
  }
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function evaluateFootprintBudget(metrics, budget = FOOTPRINT_BUDGET) {
  const webkitBytes = (
    (metrics.components.webkitContent?.bytes ?? 0)
    + (metrics.components.webkitGpu?.bytes ?? 0)
    + (metrics.components.webkitNetwork?.bytes ?? 0)
  );
  const webkitCpuPercent = (
    (metrics.components.webkitContent?.cpuPercent ?? 0)
    + (metrics.components.webkitGpu?.cpuPercent ?? 0)
    + (metrics.components.webkitNetwork?.cpuPercent ?? 0)
  );
  const checks = [
    ['appBundleBytes', metrics.appBundleBytes, budget.regressionCeilings.appBundleBytes],
    ['idlePhysicalBytes', metrics.idlePhysicalBytes, budget.regressionCeilings.idlePhysicalBytes],
    ['idleCpuPercent', metrics.idleCpuPercent, budget.regressionCeilings.idleCpuPercent],
    ['idleProcessChurn', metrics.idleProcessChurn, budget.regressionCeilings.idleProcessChurn],
    ['nativeHostCpuPercent', metrics.components.nativeHost?.cpuPercent ?? 0, budget.regressionCeilings.nativeHostCpuPercent],
    ['applicationServerCpuPercent', metrics.components.applicationServer?.cpuPercent ?? 0, budget.regressionCeilings.applicationServerCpuPercent],
    ['realtimeServerCpuPercent', metrics.components.realtimeServer?.cpuPercent ?? 0, budget.regressionCeilings.realtimeServerCpuPercent],
    ['webkitHelpersCpuPercent', webkitCpuPercent, budget.regressionCeilings.webkitHelpersCpuPercent],
    ['nativeHostBytes', metrics.components.nativeHost?.bytes ?? 0, budget.regressionCeilings.nativeHostBytes],
    ['applicationServerBytes', metrics.components.applicationServer?.bytes ?? 0, budget.regressionCeilings.applicationServerBytes],
    ['realtimeServerBytes', metrics.components.realtimeServer?.bytes ?? 0, budget.regressionCeilings.realtimeServerBytes],
    ['webkitHelpersBytes', webkitBytes, budget.regressionCeilings.webkitHelpersBytes],
  ];
  if (typeof metrics.updaterArchiveBytes === 'number') {
    checks.push(['updaterArchiveBytes', metrics.updaterArchiveBytes, budget.regressionCeilings.updaterArchiveBytes]);
  }
  const results = checks.map(([metric, actual, ceiling]) => ({
    metric,
    actual,
    ceiling,
    pass: actual <= ceiling,
  }));
  return {
    pass: results.every((result) => result.pass),
    checks: results,
    failures: results.filter((result) => !result.pass),
  };
}

export function collectFootprintReceipt({
  rootPid,
  appPath,
  dataDir,
  updaterArchivePath,
  webkitBaseline,
  before,
  after,
  observationMs,
  version,
  gitSha,
  mode,
  scenario,
  artifactDigest,
  laneCount,
  recordedAt = new Date().toISOString(),
  run = execFileSync,
}) {
  if (!before.has(rootPid) || !after.has(rootPid)) {
    throw new Error('packaged app exited during footprint observation');
  }
  const beforeOwned = ownedPids(before, rootPid, webkitBaseline);
  const afterOwned = ownedPids(after, rootPid, webkitBaseline);
  const spawned = setDifference(afterOwned, beforeOwned);
  const exited = setDifference(beforeOwned, afterOwned);
  const common = new Set([...afterOwned].filter((pid) => beforeOwned.has(pid)));
  let cpuSeconds = 0;
  const cpuSecondsByComponent = {};
  for (const pid of common) {
    const delta = (after.get(pid)?.cpuTimeSeconds ?? 0) - (before.get(pid)?.cpuTimeSeconds ?? 0);
    const boundedDelta = Math.max(0, delta);
    cpuSeconds += boundedDelta;
    const process = after.get(pid);
    if (process) {
      const key = classifyProcess(process, rootPid);
      cpuSecondsByComponent[key] = (cpuSecondsByComponent[key] ?? 0) + boundedDelta;
    }
  }
  const observationSeconds = observationMs / 1000;
  const components = {};
  let physicalMeasurementSkippedProcessCount = 0;
  for (const pid of afterOwned) {
    const process = after.get(pid);
    if (!process) continue;
    const key = classifyProcess(process, rootPid);
    const bytes = measureStableProcessPhysicalBytes(process, run);
    if (bytes === null) {
      physicalMeasurementSkippedProcessCount += 1;
      continue;
    }
    const component = components[key] ?? {
      processCount: 0,
      bytes: 0,
      cpuPercent: round(((cpuSecondsByComponent[key] ?? 0) / observationSeconds) * 100),
    };
    component.processCount += 1;
    component.bytes += bytes;
    components[key] = component;
  }
  const idlePhysicalBytes = Object.values(components).reduce((sum, component) => sum + component.bytes, 0);
  const idleProcessChurn = spawned.size + exited.size;
  const metrics = {
    observationMs,
    idlePhysicalBytes,
    idleCpuPercent: round((cpuSeconds / observationSeconds) * 100),
    idleProcessChurn,
    idleProcessSpawnsPerMinute: round(spawned.size * (60_000 / observationMs)),
    idleProcessExitsPerMinute: round(exited.size * (60_000 / observationMs)),
    processChurn: {
      spawnedByComponent: countProcessesByComponent(spawned, after, rootPid),
      exitedByComponent: countProcessesByComponent(exited, before, rootPid),
      ...buildChurnIdentities({
        spawned,
        exited,
        before,
        after,
        beforeOwned,
        afterOwned,
        rootPid,
      }),
    },
    physicalMeasurementSkippedProcessCount,
    appBundleBytes: measureDiskBytes(appPath, run),
    isolatedDataBytes: measureDiskBytes(dataDir, run),
    components,
  };
  if (updaterArchivePath) metrics.updaterArchiveBytes = statSync(updaterArchivePath).size;
  const budget = evaluateFootprintBudget(metrics);
  return {
    schemaVersion: 1,
    budgetVersion: FOOTPRINT_BUDGET.version,
    version,
    gitSha,
    mode,
    scenario,
    ...(artifactDigest ? { artifactDigest } : {}),
    ...(typeof laneCount === 'number' ? { laneCount } : {}),
    recordedAt,
    metrics,
    targets: FOOTPRINT_BUDGET.targets,
    regressionCeilings: FOOTPRINT_BUDGET.regressionCeilings,
    verdict: budget.pass ? 'PASS' : 'FAIL',
    checks: budget.checks,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : round((sorted[middle - 1] + sorted[middle]) / 2, 4);
}

function summarizeValues(values) {
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length, 4),
    median: median(values),
  };
}

const SERIES_SUMMARY_METRICS = Object.freeze([
  'idlePhysicalBytes',
  'idleCpuPercent',
  'idleProcessChurn',
  'idleProcessSpawnsPerMinute',
  'idleProcessExitsPerMinute',
  'physicalMeasurementSkippedProcessCount',
  'isolatedDataBytes',
]);

// Repeated samples are only comparable when they observed ONE artifact in one
// run. Anything else is a different measurement being averaged into a receipt,
// which is exactly the dishonest number this harness exists to prevent.
export function assertSameArtifact(samples) {
  if (samples.length === 0) throw new Error('footprint series requires at least one sample');
  const [first] = samples;
  if (typeof first.artifactDigest !== 'string' || !first.artifactDigest.trim()) {
    throw new Error('footprint series requires an artifactDigest derived from the executable bytes');
  }
  for (const sample of samples) {
    const mismatch = ['artifactDigest', 'version', 'gitSha', 'scenario'].find(
      (key) => sample[key] !== first[key],
    );
    if (mismatch) {
      throw new Error(`footprint samples did not share the same artifact (${mismatch} differs)`);
    }
  }
}

export function summarizeFootprintSamples(samples) {
  assertSameArtifact(samples);
  const metrics = {};
  for (const metric of SERIES_SUMMARY_METRICS) {
    const values = samples
      .map((sample) => sample.metrics[metric])
      .filter((value) => typeof value === 'number');
    if (values.length === samples.length) metrics[metric] = summarizeValues(values);
  }
  const worstByMetric = new Map();
  for (const sample of samples) {
    for (const check of sample.checks) {
      const previous = worstByMetric.get(check.metric);
      if (!previous || check.actual > previous.actual) worstByMetric.set(check.metric, check);
    }
  }
  const checks = [...worstByMetric.values()].map((check) => ({ ...check }));
  return {
    sampleCount: samples.length,
    metrics,
    checks,
    failures: checks.filter((check) => !check.pass),
    verdict: checks.every((check) => check.pass) ? 'PASS' : 'FAIL',
  };
}

export function buildFootprintSeriesReceipt({ samples, loadScenario }) {
  const aggregate = summarizeFootprintSamples(samples);
  const highestMemorySample = samples.reduce(
    (worst, sample) => (sample.metrics.idlePhysicalBytes > worst.metrics.idlePhysicalBytes ? sample : worst),
    samples[0],
  );
  const [first] = samples;
  return {
    schemaVersion: 2,
    budgetVersion: FOOTPRINT_BUDGET.version,
    version: first.version,
    gitSha: first.gitSha,
    mode: first.mode,
    scenario: first.scenario,
    ...(first.artifactDigest ? { artifactDigest: first.artifactDigest } : {}),
    recordedAt: first.recordedAt,
    sampleCount: samples.length,
    samples: samples.map((sample, index) => ({
      index,
      recordedAt: sample.recordedAt,
      metrics: sample.metrics,
      verdict: sample.verdict,
      checks: sample.checks,
    })),
    aggregate,
    // Backward-compatible single-sample view: retain the highest-memory
    // observation. Per-metric worst cases and the gate verdict live in
    // aggregate/checks; calling this one sample "worst" for every metric would
    // be false when (for example) CPU peaks in a different observation.
    metrics: highestMemorySample.metrics,
    targets: FOOTPRINT_BUDGET.targets,
    regressionCeilings: FOOTPRINT_BUDGET.regressionCeilings,
    verdict: aggregate.verdict,
    checks: aggregate.checks,
    loadScenario,
  };
}
