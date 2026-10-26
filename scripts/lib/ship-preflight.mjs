import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectIntakeReconciliation } from './intake-reconciliation.mjs';
import { resolveReleaseConfig } from './release-config.mjs';
import { resolveNotarizationCredentials } from './notarization.mjs';
import { parseReleaseNotes } from './public-release.mjs';
import { assertNoProducer } from './generated-output-producer-check.mjs';

const DEFAULT_MIN_FREE_GIB = 25;

export function commandReceipt(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    timeout: timeoutMs,
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
    ...(options.detached ? { detached: true } : {}),
    windowsHide: true,
  });
  return {
    status: result.status ?? (result.error ? 127 : 0),
    stdout: result.stdout ?? '',
    // A timeout leaves no exit status; say so instead of reporting a bare 127.
    stderr: result.error?.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutMs} ms`
      : result.stderr ?? result.error?.message ?? '',
    ...(options.detached ? { pid: result.pid ?? null } : {}),
  };
}

function requireSuccess(receipt, description) {
  if (receipt.status !== 0) {
    const detail = receipt.stderr.trim() || receipt.stdout.trim() || `exit ${receipt.status}`;
    throw new Error(`${description}: ${detail}`);
  }
  return receipt.stdout.trim();
}

function parseRemoteTagHead(output, tag) {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
  return (peeled ?? direct)?.split(/\s+/, 1)[0] ?? null;
}

function repositoryFromRemote(remoteUrl) {
  const match = remoteUrl.trim().match(/(?:github\.com[/:])([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

// A desktop build without these ships with account sign-in, GitHub sign-in and
// crash reporting switched off. Values stay out of Git in o8.release.json or the
// environment; only the key names are reported.
const REQUIRED_RELEASE_CONFIG = ['clerkPublishableKey', 'githubOAuthClientId', 'sentryDsn'];

function checkReleaseConfig(root, env) {
  const config = resolveReleaseConfig(root, env);
  const missing = REQUIRED_RELEASE_CONFIG.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`missing desktop release configuration: ${missing.join(', ')}; add o8.release.json to the release worktree or set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, GITHUB_OAUTH_CLIENT_ID and SENTRY_DSN`);
  }
  return [...REQUIRED_RELEASE_CONFIG];
}

function checkCredentialNames(env, run, root) {
  if (!env.APPLE_SIGNING_IDENTITY?.trim()) {
    throw new Error('missing release credentials: APPLE_SIGNING_IDENTITY');
  }
  const credentials = resolveNotarizationCredentials(env);
  if ('keychainProfile' in credentials) {
    let verified = false;
    try {
      const receipt = run('xcrun', ['notarytool', 'history', '--keychain-profile', credentials.keychainProfile], {
        cwd: root, env, timeoutMs: 15_000,
      });
      verified = receipt.status === 0;
    } catch {
      // Command errors and output may contain the profile or credentials.
    }
    if (!verified) {
      throw new Error('could not verify notarytool Keychain profile; check APPLE_KEYCHAIN_PROFILE and Keychain access');
    }
    return ['APPLE_SIGNING_IDENTITY', 'APPLE_KEYCHAIN_PROFILE'];
  }
  console.warn('[ship-preflight] WARNING: APPLE_PASSWORD is supplied through the environment; use APPLE_KEYCHAIN_PROFILE to keep notarization credentials in Keychain');
  return ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
}

function freeDiskGiB(root) {
  const stats = statfsSync(root);
  return Number(stats.bavail * stats.bsize) / (1024 ** 3);
}

function assertNoCompetingBuilds(run, root, env) {
  if (process.platform === 'win32') return;
  const receipt = run('ps', ['-axo', 'pid=,ppid=,command='], {
    cwd: root,
    env,
    timeoutMs: 3_000,
  });
  if (receipt.status !== 0) {
    throw new Error(`could not inspect competing release processes: ${receipt.stderr.trim() || `exit ${receipt.status}`}`);
  }
  const buildPattern = /(?:next[^ ]* build|cargo(?: +tauri)? +build|cargo-tauri.*build|scripts\/release\.mjs +--ship)/;
  const competing = receipt.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }];
    })
    .filter((row) => row.pid !== process.pid && row.pid !== process.ppid)
    .filter((row) => buildPattern.test(row.command));
  if (competing.length > 0) {
    throw new Error(`another ship or build owns the release output (${competing.length} process${competing.length === 1 ? '' : 'es'})`);
  }
}

export function acquireReleaseLock(options = {}) {
  const lockPath = options.lockPath
    ?? process.env.O8_RELEASE_LOCK_PATH?.trim()
    ?? join(tmpdir(), 'o8-release-build-v1.lock');

  if (existsSync(lockPath)) {
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {}
    const pid = Number(owner?.pid);
    let live = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        live = true;
      } catch (error) {
        live = error?.code === 'EPERM';
      }
    }
    if (live) {
      throw new Error(`release output is owned by live ship pid ${pid}`);
    }
    rmSync(lockPath, { force: true });
  }

  const fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch {}
      try { rmSync(lockPath, { force: true }); } catch {}
    },
  };
}

export function performShipPreflight(options) {
  const {
    root,
    version,
    env = process.env,
    run = commandReceipt,
  } = options;
  // Run the publishing parser before credentials, commands, or native work.
  // Missing notes remain valid: the feed can be built from public commits.
  const notesPath = join(root, 'release-notes', 'next.md');
  parseReleaseNotes(existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '');
  // Refuse a colliding producer before source/network checks or the advisory
  // benchmark. Prebuild repeats this observation to catch later arrivals.
  assertNoProducer(realpathSync(root), {
    run(command, args, options) {
      const receipt = run(command, args, { cwd: root, env,
        timeoutMs: options.timeout, maxBuffer: options.maxBuffer });
      if (receipt.status !== 0) {
        throw Object.assign(new Error(`could not inspect producer: ${receipt.stderr.trim() || `exit ${receipt.status}`}`),
          { status: receipt.status, stdout: receipt.stdout });
      }
      return receipt.stdout;
    },
  });
  const tag = `v${version}`;
  const head = requireSuccess(
    run('git', ['rev-parse', 'HEAD'], { cwd: root, env }),
    'could not resolve source HEAD',
  );
  const localTagHead = requireSuccess(
    run('git', ['rev-list', '-n', '1', tag], { cwd: root, env }),
    `local tag ${tag} is missing`,
  );
  if (localTagHead !== head) {
    throw new Error(`local tag ${tag} points to ${localTagHead}, not HEAD ${head}`);
  }
  const dirty = requireSuccess(
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, env }),
    'could not inspect the release worktree',
  )
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !/^(?:[ MADRCU?!]{1,2} )?o8\.md$/.test(line));
  if (dirty.length > 0) {
    throw new Error(`release worktree contains ${dirty.length} non-operator change${dirty.length === 1 ? '' : 's'}`);
  }
  // A test file that lands on main without a PR (a direct-pushed release fix)
  // never runs `npm run test:classification:check` — that gate is PR-CI-only —
  // so a stale manifest reaches the tag unnoticed and turns every open PR's
  // Hermetic Unit Tests job red for a reason unrelated to its diff (#2053).
  // Reuse the exact same script + remedy text CI prints on failure.
  const classification = run(process.execPath, ['scripts/classify-tests.mjs', '--check-manifest'], {
    cwd: root,
    env,
    timeoutMs: 60_000,
  });
  if (classification.status !== 0) {
    throw new Error(`test classification check: ${
      classification.stderr.trim()
        || classification.stdout.trim()
        || `exited ${classification.status}`}`);
  }
  const repo = env.O8_RELEASE_REPO?.trim() || repositoryFromRemote(requireSuccess(
    run('git', ['remote', 'get-url', 'origin'], { cwd: root, env }),
    'could not resolve the release repository',
  ));
  if (!repo) {
    throw new Error('origin is not a supported release remote; set O8_RELEASE_REPO explicitly');
  }

  const remoteTags = requireSuccess(
    run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root, env }),
    `remote tag ${tag} is missing`,
  );
  const remoteTagHead = parseRemoteTagHead(remoteTags, tag);
  if (remoteTagHead !== head) {
    throw new Error(`remote tag ${tag} points to ${remoteTagHead ?? 'nothing'}, not HEAD ${head}`);
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('release repository must be an owner/repository pair');
  }
  // Confirm access first: a release 404 alone can also mean a hidden repository.
  // REST reads do not consume the separately shared GraphQL quota.
  const requestOptions = { cwd: root, env, timeoutMs: 20_000 };
  const repositoryResponse = requireSuccess(
    run('gh', ['api', `repos/${repo}`], requestOptions),
    `could not verify access to release repository ${repo}`,
  );
  let repository;
  try { repository = JSON.parse(repositoryResponse); } catch {
    throw new Error(`could not verify access to release repository ${repo}: invalid repository response`);
  }
  if (typeof repository?.full_name !== 'string'
    || repository.full_name.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`could not verify access to release repository ${repo}: invalid repository response`);
  }
  // Metadata access alone does not prove Contents/read permission on a private
  // repository. Confirm the releases collection is readable before trusting 404.
  const collectionResponse = requireSuccess(
    run('gh', ['api', `repos/${repo}/releases?per_page=1`], requestOptions),
    `could not verify release-read access for ${repo}`,
  );
  let collection;
  try { collection = JSON.parse(collectionResponse); } catch {
    throw new Error(`could not verify release-read access for ${repo}: invalid releases response`);
  }
  if (!Array.isArray(collection)) {
    throw new Error(`could not verify release-read access for ${repo}: invalid releases response`);
  }
  const release = run('gh', ['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], {
    cwd: root,
    env,
    timeoutMs: 20_000,
  });
  if (release.status === 0) {
    let metadata;
    try { metadata = JSON.parse(release.stdout); } catch {
      throw new Error(`invalid release response for ${tag}`);
    }
    if (metadata?.tag_name !== tag) throw new Error(`invalid release tag response for ${tag}`);
    if (env.O8_RELEASE_CLOBBER !== '1') {
      throw new Error(`release ${tag} already exists; set O8_RELEASE_CLOBBER=1 only for an intentional replacement`);
    }
  }
  const releaseMissing = release.status === 1 && /\bHTTP\s+404\b/i.test(release.stderr);
  if (release.status !== 0 && !releaseMissing) {
    throw new Error(`could not verify whether release ${tag} exists: ${release.stderr.trim() || `exit ${release.status}`}`);
  }

  const credentialNames = checkCredentialNames(env, run, root);
  const releaseConfigKeys = checkReleaseConfig(root, env);
  const signingKey = join(env.HOME || '', '.tauri', 'cortex-ide.key');
  if (!env.HOME || !existsSync(signingKey)) {
    throw new Error('Tauri updater signing key is missing');
  }

  const minFreeGiB = Number(env.O8_RELEASE_MIN_FREE_GIB || DEFAULT_MIN_FREE_GIB);
  const availableGiB = freeDiskGiB(root);
  if (!Number.isFinite(minFreeGiB) || minFreeGiB <= 0) {
    throw new Error('O8_RELEASE_MIN_FREE_GIB must be a positive number');
  }
  if (availableGiB < minFreeGiB) {
    throw new Error(`release needs ${minFreeGiB.toFixed(1)} GiB free; only ${availableGiB.toFixed(1)} GiB is available`);
  }

  const toolchains = {};
  for (const [name, command, args] of [
    ['git', 'git', ['--version']],
    ['gh', 'gh', ['--version']],
    ['npm', 'npm', ['--version']],
    ['cargo', 'cargo', ['--version']],
    ['rustc', 'rustc', ['--version']],
    ...(process.platform === 'darwin' ? [
      ['swift', 'swift', ['--version']],
      ['xcodebuild', 'xcodebuild', ['-version']],
    ] : []),
  ]) {
    toolchains[name] = requireSuccess(
      run(command, args, { cwd: root, env, timeoutMs: 10_000 }),
      `${name} toolchain is unavailable`,
    ).split('\n')[0];
  }
  if (Number(process.versions.node.split('.')[0]) !== 22) {
    throw new Error(`Node 22 is required; current runtime is ${process.version}`);
  }

  assertNoCompetingBuilds(run, root, env);

  return {
    schema: 'o8/release-preflight/v1',
    head,
    version,
    tag,
    remoteTagHead,
    releaseAbsent: releaseMissing,
    availableGiB: Number(availableGiB.toFixed(2)),
    minFreeGiB,
    credentialNames,
    releaseConfigKeys,
    signingKeyPresent: true,
    intakeReconciliation: inspectIntakeReconciliation({ env }),
    toolchains: {
      node: process.version,
      ...toolchains,
    },
  };
}

// The quick benchmark boots servers in their own process groups inside the
// release checkout. A timeout can orphan them, and an orphaned dev server
// writes `.next`, which the prebuild then refuses as unknown generated output.
// The benchmark therefore runs in its own process group with a per-run
// environment marker. When the step ends, every process in that group, every
// marked process and every group a marked process leads is stopped, and
// `.next` is removed only when the step created it. A state file lets the next
// preflight finish the cleanup of a run that was interrupted.
const BENCHMARK_MARKER = 'O8_SHIP_BENCHMARK_RUN';
const MARKER_SCAN_MAX_BUFFER = 64 * 1024 * 1024;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function benchmarkStatePath(root) {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return join(tmpdir(), `o8-ship-benchmark-${key}.json`);
}

// Process-group membership is visible for every process of this user, even
// where macOS hides a process's environment (system binaries, hardened apps).
function processGroups() {
  const receipt = commandReceipt('ps', ['-axo', 'pid=,pgid='], { timeoutMs: 15_000, maxBuffer: MARKER_SCAN_MAX_BUFFER });
  if (receipt.status !== 0) return null;
  const table = new Map();
  for (const line of receipt.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

// `ps` prints process environments, which can hold release credentials. Only
// matching PIDs leave this function; null means the scan could not complete.
function markedProcessIds(marker) {
  const receipt = commandReceipt('ps', ['axeww', '-o', 'pid=,command='], {
    timeoutMs: 15_000,
    maxBuffer: MARKER_SCAN_MAX_BUFFER,
  });
  if (receipt.status !== 0) return null;
  const needle = `${BENCHMARK_MARKER}=${marker}`;
  const pids = [];
  for (const line of receipt.stdout.split('\n')) {
    const match = /^\s*(\d+)\s/.exec(line);
    if (!match || !line.includes(needle)) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid) pids.push(pid);
  }
  return pids;
}

// `groups` holds the benchmark's own process group while it is fresh. A group
// is otherwise signaled only while a member still shows the marker, so a
// recorded group whose ID was later reused is never signaled.
function stopBenchmarkProcesses(marker, groups) {
  if (process.platform === 'win32') return { confirmed: false, stoppedProcesses: 0, reason: 'unsupported platform' };
  const stopped = new Set();
  const signals = ['SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGKILL', null];
  for (const signal of signals) {
    const marked = markedProcessIds(marker);
    const table = processGroups();
    if (marked === null || table === null) {
      return { confirmed: false, stoppedProcesses: stopped.size, reason: 'process scan failed' };
    }
    const ownGroup = table.get(process.pid);
    for (const pid of marked) {
      const group = table.get(pid);
      if (group !== undefined) groups.add(group);
    }
    groups.delete(ownGroup);
    const members = [...table].filter(([pid, group]) => pid !== process.pid && groups.has(group)).map(([pid]) => pid);
    const targets = new Set([...marked, ...members]);
    if (targets.size === 0) return { confirmed: true, stoppedProcesses: stopped.size };
    if (signal === null) break;
    for (const group of groups) {
      try { process.kill(-group, signal); } catch { /* group already empty */ }
    }
    for (const pid of targets) {
      try {
        process.kill(pid, signal);
        stopped.add(pid);
      } catch {
        // Already exited.
      }
    }
    sleepSync(1000);
  }
  return { confirmed: false, stoppedProcesses: stopped.size, reason: 'benchmark processes remain after SIGKILL' };
}

function removeCreatedOutput(root) {
  const output = join(root, '.next');
  if (!lstatSync(output, { throwIfNoEntry: false })) return { removedOutput: false };
  try {
    rmSync(output, { recursive: true, force: true });
    return { removedOutput: true };
  } catch (error) {
    return { removedOutput: false, outputError: error instanceof Error ? error.message : String(error) };
  }
}

function settleBenchmarkRun(root, run, groups) {
  const settlement = stopBenchmarkProcesses(run.marker, groups);
  // A step that started without `.next` owns any `.next` present now, unless
  // a prebuild has since bound it to the generated-output store.
  const bound = lstatSync(join(root, '.o8-generated-output-store'), { throwIfNoEntry: false });
  const output = !run.outputExisted && !bound ? removeCreatedOutput(root) : { removedOutput: false };
  const result = { ...settlement, ...output };
  if (output.outputError) {
    result.confirmed = false;
    result.reason = [settlement.reason, `output removal failed: ${output.outputError}`].filter(Boolean).join('; ');
  }
  return result;
}

function readBenchmarkRuns(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(state?.runs) ? state.runs.filter((entry) => typeof entry?.marker === 'string') : [];
  } catch {
    return [];
  }
}

function writeBenchmarkRuns(path, runs) {
  if (runs.length === 0) rmSync(path, { force: true });
  else writeFileSync(path, JSON.stringify({ runs }), { mode: 0o600 });
}

export function runQuickBenchmarkPreflight(options) {
  const {
    root,
    env = process.env,
    run = commandReceipt,
    timeoutMs = 120_000,
  } = options;
  const statePath = benchmarkStatePath(root);
  const pending = [];
  const recovered = [];
  for (const previous of readBenchmarkRuns(statePath)) {
    const settlement = settleBenchmarkRun(root, previous, new Set());
    recovered.push(settlement);
    if (!settlement.confirmed) pending.push(previous);
  }

  // The dev benchmark writes into .next. Even lifecycle-bound output belongs
  // to its producer, not this advisory check. Recover our own interrupted runs
  // first, then refuse all remaining entries, including dangling symlinks,
  // before recording or spawning a new run. This is a preflight failure, not
  // an unavailable speed measurement that the ship can ignore.
  if (lstatSync(join(root, '.next'), { throwIfNoEntry: false })) {
    throw new Error('.next already exists; the ship benchmark requires absent output. Stop checkout users and use a clean release checkout; preserve the existing output for recovery.');
  }

  const current = {
    marker: randomUUID(),
    outputExisted: Boolean(lstatSync(join(root, '.next'), { throwIfNoEntry: false })),
  };
  writeBenchmarkRuns(statePath, [...pending, current]);
  let receipt;
  let cleanup;
  try {
    receipt = run(process.execPath, ['scripts/bench/quick.mjs', '--ephemeral'], {
      cwd: root,
      env: { ...env, [BENCHMARK_MARKER]: current.marker },
      timeoutMs,
      detached: true,
    });
  } finally {
    const groups = new Set(typeof receipt?.pid === 'number' ? [receipt.pid] : []);
    cleanup = settleBenchmarkRun(root, current, groups);
    writeBenchmarkRuns(statePath, cleanup.confirmed ? pending : [...pending, current]);
  }
  if (recovered.length > 0) cleanup.recoveredPrevious = recovered;
  return { ...parseQuickBenchmarkReceipt(receipt), cleanup };
}

function parseQuickBenchmarkReceipt(receipt) {
  if (receipt.status !== 0) {
    return {
      schema: 'o8/benchmark-quick-preflight/v1',
      status: 'unavailable',
      regressions: [],
      missing: [],
      message: receipt.stderr.trim() || receipt.stdout.trim() || `benchmark exited ${receipt.status}`,
    };
  }

  const prefix = 'O8_BENCH_QUICK_RECEIPT=';
  const line = receipt.stdout.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return {
      schema: 'o8/benchmark-quick-preflight/v1',
      status: 'unavailable',
      regressions: [],
      missing: [],
      message: 'benchmark receipt was missing',
    };
  }
  try {
    const parsed = JSON.parse(line.slice(prefix.length));
    if (parsed?.schema !== 'o8/benchmark-quick-preflight/v1') {
      throw new Error('benchmark receipt schema was invalid');
    }
    return parsed;
  } catch (error) {
    return {
      schema: 'o8/benchmark-quick-preflight/v1',
      status: 'unavailable',
      regressions: [],
      missing: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export const shipPreflightInternals = {
  benchmarkStatePath,
  commandReceipt,
  parseRemoteTagHead,
  repositoryFromRemote,
};
