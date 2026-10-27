#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildFootprintSeriesReceipt,
  collectFootprintReceipt,
  computeArtifactDigest,
  resolveIdleSampleCount,
  snapshotProcesses,
  webkitPids,
} from './lib/footprint-budget.mjs';
import {
  LOAD_UNAVAILABLE_REASONS,
  createHttpLoadDriver,
  planGateLoadScenario,
  runLoadScenario,
} from './lib/footprint-budget-load.mjs';
import { BOOT_PROBE_JS, classifyBootProbe } from './preship-gate-logic.mjs';
import { cleanupGate, loadTeardownProvesClean } from './lib/preship-gate-cleanup.mjs';

// Per-phase deadlines (each phase gets its OWN fresh budget — a shared budget
// let a slow cold boot under machine load starve the later route/health checks
// and flaky-fail the gate). Generous so a loaded build machine still boots the
// child in time; a genuinely-broken app still fails when its phase deadline expires.
const SOCKET_TIMEOUT_MS = 60_000;   // socket file + first connect (Next cold-spawn + bind)
const ROUTE_TIMEOUT_MS = 120_000;   // webview window created + /dashboard route active
const HEALTH_TIMEOUT_MS = 60_000;   // dashboard reaches the interactive mark, no error page
const ERROR_WINDOW_MS = 8_000;
const FOOTPRINT_COOLDOWN_MS = 60_000;
const FOOTPRINT_OBSERVATION_MS = 15_000;
const POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
const RELEASE_NOTE_FILE = 'preship-webview-gate-release-note.txt';

export class WebviewSocketClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.tokenPath = `${socketPath}.token`;
    this.socket = null;
    this.buffer = '';
    this.pending = new Map();
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('socket closed'));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
  }

  async connectOnly() {
    const socket = net.createConnection({ path: this.socketPath });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.destroy();
  }

  async send(command, payload) {
    await this.ensureConnected();
    const id = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    // The tauri-plugin-mcp socket runs UNAUTHENTICATED when no auth_token is
    // configured — the operator app writes no `.token` sidecar by default.
    // Only attach a token if one actually exists; otherwise connect without.
    const authToken = existsSync(this.tokenPath) ? readFileSync(this.tokenPath, 'utf8').trim() : undefined;
    const message = authToken ? { command, payload, id, authToken } : { command, payload, id };
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${command}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async ensureConnected() {
    if (this.socket && !this.socket.destroyed) return;
    const socket = net.createConnection({ path: this.socketPath });
    this.socket = socket;
    this.buffer = '';
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
  }

  handleData(chunk) {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  handleLine(line) {
    const response = JSON.parse(line);
    const id = typeof response.id === 'string' && this.pending.has(response.id)
      ? response.id
      : this.pending.keys().next().value;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (response.success === false) {
      pending.reject(new Error(String(response.error ?? 'webview command failed')));
    } else {
      pending.resolve(response.data);
    }
  }
}

function parseArgs() {
  let mode = 'fail-fast';
  let target;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--mode=')) mode = arg.slice('--mode='.length);
    else target = arg;
  }
  if (mode !== 'fail-fast' && mode !== 'authoritative') {
    throw new Error(`unsupported mode: ${mode}`);
  }
  return { mode, target };
}

function packageInfo() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { version: String(pkg.version), gitSha };
}

function releaseNotePath(appTar) {
  return appTar ? path.join(path.dirname(appTar), RELEASE_NOTE_FILE) : null;
}

function footprintReceiptPath(appPath) {
  return process.env.O8_FOOTPRINT_RECEIPT_PATH
    ? path.resolve(process.env.O8_FOOTPRINT_RECEIPT_PATH)
    : path.join(path.dirname(appPath), 'footprint-receipt.json');
}

function writeFootprintReceipt(appPath, receipt) {
  const outputPath = footprintReceiptPath(appPath);
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return outputPath;
}

// One idle observation on the already-running artifact. Repeating this is what
// turns a single lucky reading into a distribution the receipt can defend.
async function observeFootprintSample(context, scenario, laneCount) {
  const before = snapshotProcesses();
  await sleep(FOOTPRINT_OBSERVATION_MS);
  const after = snapshotProcesses();
  return collectFootprintReceipt({
    rootPid: context.rootPid,
    appPath: context.appPath,
    dataDir: context.dataDir,
    updaterArchivePath: context.updaterArchivePath,
    webkitBaseline: context.webkitBaseline,
    before,
    after,
    observationMs: FOOTPRINT_OBSERVATION_MS,
    version: context.version,
    gitSha: context.gitSha,
    mode: context.mode,
    scenario,
    artifactDigest: context.artifactDigest,
    ...(typeof laneCount === 'number' ? { laneCount } : {}),
  });
}

async function collectFootprintSamples(context, sampleCount, scenario, laneCount) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await observeFootprintSample(context, scenario, laneCount));
  }
  return samples;
}

function commandOnPath(command) {
  try {
    execFileSync('/usr/bin/which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The sidecar may land on a different port than the one requested; its chosen
// value is written into the isolated data dir, which is what cleanup already
// trusts. The load driver must talk to the same listener.
function resolveChildApiPort(dataDir, fallback) {
  const portPath = path.join(dataDir, 'api-port');
  if (!existsSync(portPath)) return fallback;
  const port = Number(readFileSync(portPath, 'utf8').trim());
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

function readGateToken(dataDir) {
  const tokenPath = path.join(dataDir, 'ws-token');
  return existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
}

// The OPERATOR's profile, not the isolated child's: the question the probes ask
// is which repositories hold real work, and that answer lives in the live data
// dir. Mirrors getDataDir()'s precedence in src/lib/data-dir-migration.ts.
function operatorDataDir() {
  return process.env.O8_DATA_DIR?.trim()
    || process.env.CORTEX_IDE_DATA_DIR?.trim()
    || path.join(os.homedir(), '.o8');
}

function clearReleaseNote(appTar) {
  const marker = releaseNotePath(appTar);
  if (marker && existsSync(marker)) unlinkSync(marker);
}

function writeBypassReleaseNote(appTar, reason) {
  const marker = releaseNotePath(appTar);
  if (!marker) return;
  writeFileSync(marker, `gate:bypassed - ${reason}\n`);
}

function liveDataDir() {
  return path.join(os.homedir(), '.o8');
}

function jsonlAuditPath() {
  return path.join(liveDataDir(), 'preship-gate-audit.jsonl');
}

function writeJsonlAudit(payload) {
  mkdirSync(liveDataDir(), { recursive: true });
  appendFileSync(jsonlAuditPath(), `${JSON.stringify({ ...payload, recordedAt: new Date().toISOString() })}\n`);
  console.error(`[preship-webview-gate] approval DB write failed; wrote JSONL audit: ${jsonlAuditPath()}`);
}

function writeAudit(payload) {
  if (payload.mode !== 'authoritative') return;
  const input = JSON.stringify(payload);
  try {
    execFileSync('npx', ['tsx', 'scripts/preship-gate-audit.ts'], {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        O8_DATA_DIR: liveDataDir(),
        CORTEX_IDE_DATA_DIR: liveDataDir(),
        // #17: the audit writer imports @/lib/approvals/store, which transitively
        // pulls `import 'server-only'` (via repos/projects.ts). Under plain tsx
        // that guard throws ("cannot be imported from a Client Component"), so the
        // DB write failed and we fell back to JSONL every ship. The react-server
        // condition resolves 'server-only' to a no-op so the DB audit row lands.
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=react-server'].filter(Boolean).join(' '),
      },
    });
    return;
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? String(error);
    console.error(`[preship-webview-gate] approval DB write failed:\n${stderr}`);
  }
  writeJsonlAudit(payload);
}

function tail(text, max = 12_000) {
  return text.length > max ? text.slice(text.length - max) : text;
}

function normalizeEvalResult(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value ?? '');
  if (typeof value.result === 'string') return value.result;
  if (typeof value.text === 'string') return value.text;
  if ('data' in value) return normalizeEvalResult(value.data);
  return String(value);
}

export async function executeJs(client, code) {
  return normalizeEvalResult(await client.send('execute_js', { window_label: 'main', code }));
}

async function invokeTauri(client, command, args = {}) {
  const code = `(() => { try {
    if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
      return JSON.stringify({ ok: false, err: 'tauri internals unavailable' });
    }
    return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then((r) => JSON.stringify({ ok: true, data: r }))
      .catch((e) => JSON.stringify({ ok: false, err: String(e && e.message || e) }));
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); } })()`;
  let parsed = JSON.parse(await executeJs(client, code));
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  if (!parsed || parsed.ok !== true) throw new Error(parsed?.err || `tauri invoke '${command}' failed`);
  return parsed.data;
}

async function waitForSocket(client, deadline) {
  while (Date.now() < deadline) {
    // Wait only on the socket itself — no `.token` sidecar exists unless an
    // auth_token is configured (the default is unauthenticated).
    if (existsSync(client.socketPath)) {
      try {
        await client.connectOnly();
        return;
      } catch (error) {
        if (!['ECONNREFUSED', 'ENOENT'].includes(error?.code)) throw error;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error('socket warmup timed out');
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function findFreePortFrom(start) {
  for (let p = start; p < start + 200; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port from ${start}`);
}

async function waitForDashboard(client, deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const route = await invokeTauri(client, 'o8_view_active_route');
      if (typeof route?.pathname === 'string' && route.pathname.includes('/dashboard')) {
        return route.pathname;
      }
    } catch (error) {
      // Transient during boot — the webview window may not exist yet
      // ("Webview window not found: main") or the socket may reset. Keep
      // polling; a genuinely dead app fails when the deadline expires.
      lastErr = error?.message ?? String(error);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`dashboard route did not become active${lastErr ? ` (last error: ${lastErr})` : ''}`);
}

async function waitForHealthyBoot(client, deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await executeJs(client, BOOT_PROBE_JS);
      const { verdict, reason } = classifyBootProbe(result);
      if (verdict === 'fail') throw new Error(reason);
      if (verdict === 'pass') return;
    } catch (error) {
      const msg = error?.message ?? String(error);
      // Real verdicts must propagate; transient eval errors (window not ready
      // / busy JS) are tolerated until the deadline.
      if (msg.indexOf('mount error') !== -1 || msg.indexOf('Application error') !== -1) throw error;
      lastErr = msg;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`dashboard never reached the deep hydration marker${lastErr ? ` (last error: ${lastErr})` : ''}`);
}

async function collectFatalConsoleErrors(client) {
  const seen = new Set();
  const fatal = [];
  const deadline = Date.now() + ERROR_WINDOW_MS;
  while (Date.now() < deadline) {
    let data;
    try {
      data = await invokeTauri(client, 'o8_view_console_errors');
    } catch {
      // transient read failure — keep polling within the window
      await sleep(POLL_MS);
      continue;
    }
    for (const error of data?.errors ?? []) {
      // Ignore benign sources: mandated [feature] console.error logging, and
      // the tauri-plugin-mcp bridge's own per-command trace
      // ([mcp-entered]/[mcp-pre]/[mcp-resolved]) that the gate's OWN probing
      // generates. A genuine uncaught crash arrives via a window 'error' event
      // (source = a real filename) or 'unhandledrejection' — neither of which
      // is filtered here.
      if (
        error?.source === 'console.error'
        && !String(error?.message ?? '').includes('[boot-gate]')
      ) continue;
      if (error?.source === 'tauri-plugin-mcp') continue;
      const key = `${error?.message ?? ''}\n${error?.source ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fatal.push({
        message: String(error?.message ?? ''),
        source: String(error?.source ?? ''),
        lineno: Number(error?.lineno ?? 0),
      });
    }
    if (fatal.length > 0) return fatal;
    await sleep(POLL_MS);
  }
  return fatal;
}

function resolveAppTarget(mode, target) {
  if (mode !== 'authoritative') {
    return {
      appPath: target ?? path.join('src-tauri', 'target', 'release', 'bundle', 'macos', 'o8.app'),
      cleanupDir: null,
      appTar: null,
    };
  }
  if (!target) throw new Error('--mode=authoritative requires the o8.app.tar.gz path');
  if (!existsSync(target)) throw new Error(`missing authoritative app archive: ${target}`);
  return {
    appPath: path.join('src-tauri', 'target', 'release', 'bundle', 'macos', 'o8.app'),
    cleanupDir: null,
    appTar: target,
  };
}

function bypass(mode, appTar, info) {
  const reason = (process.env.O8_GATE_BYPASS_REASON ?? '').trim();
  if (!reason) {
    console.error('[preship-webview-gate] O8_SKIP_WEBVIEW_GATE=1 requires non-empty O8_GATE_BYPASS_REASON');
    process.exit(1);
  }
  if (mode === 'authoritative') {
    writeBypassReleaseNote(appTar, reason);
    writeAudit({
      outcome: 'BYPASS',
      version: info.version,
      gitSha: info.gitSha,
      mode,
      nodeVersion: process.version,
      overrideReason: reason,
      operatorUser: os.userInfo().username,
    });
  }
  console.error([
    '',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '[preship-webview-gate] WKWebView boot gate BYPASSED',
    `reason: ${reason}`,
    'This release proceeds without the real WKWebView pre-ship check.',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '',
  ].join('\n'));
}

async function main() {
  const started = Date.now();
  const { mode, target } = parseArgs();
  const info = packageInfo();
  const resolved = resolveAppTarget(mode, target);
  if (mode === 'authoritative') clearReleaseNote(resolved.appTar);
  if (process.env.O8_SKIP_WEBVIEW_GATE === '1') {
    bypass(mode, resolved.appTar, info);
    return;
  }

  const machO = path.join(resolved.appPath, 'Contents', 'MacOS', 'o8');
  if (!existsSync(machO)) throw new Error(`missing app executable: ${machO}`);
  const socketPath = path.join(os.tmpdir(), `o8-preship-gate-${process.pid}-${Date.now()}.sock`);
  rmSync(socketPath, { force: true });
  rmSync(`${socketPath}.token`, { force: true });
  if (existsSync(socketPath)) throw new Error(`socket path already exists: ${socketPath}`);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-bootgate-'));
  const sampleCount = resolveIdleSampleCount(process.env.O8_FOOTPRINT_IDLE_SAMPLES);
  // Provision distinct free ports for the isolated child so it can never bind
  // (or be confused with) the operator's live :3001/:3002.
  const apiPort = await findFreePortFrom(3060);
  const wsPort = await findFreePortFrom(apiPort + 1);
  const client = new WebviewSocketClient(socketPath);
  const webkitBaseline = webkitPids(snapshotProcesses());
  // Tauri starts its sidecars with the bundle's server directory as cwd. A
  // build bundle inside a Git checkout would otherwise inherit that checkout
  // and make the idle conflict probe scan every linked worktree. A real install
  // lives outside the checkout, so launch an exact copy from a temporary root.
  // Tauri's macOS resource resolver rejects copies under the per-user
  // /var/folders temporary root. Resolve /tmp to its physical /private/tmp
  // location, where the same signed bundle boots normally.
  const stagedAppDir = mkdtempSync(path.join(realpathSync('/tmp'), 'o8-preship-app-'));
  const stagedAppPath = path.join(stagedAppDir, 'o8.app');
  let child;
  let stdout = '';
  let stderr = '';
  let signalFailed = 'unknown';
  let capturedConsoleErrors = [];
  let footprintReceipt;
  let preserveDataDir = false;
  let artifactDigest;

  try {
    signalFailed = 'stage-app';
    artifactDigest = computeArtifactDigest(resolved.appPath, {
      version: info.version,
      gitSha: info.gitSha,
    });
    execFileSync('ditto', [resolved.appPath, stagedAppPath], { stdio: 'pipe', timeout: 120_000 });
    execFileSync('codesign', ['--verify', '--deep', '--strict', stagedAppPath], { stdio: 'pipe', timeout: 120_000 });
    if (computeArtifactDigest(stagedAppPath, { version: info.version, gitSha: info.gitSha }) !== artifactDigest) {
      throw new Error('staged app executable differs from the signed release bundle');
    }
    child = spawn(path.join(stagedAppPath, 'Contents', 'MacOS', 'o8'), [], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        O8_TAURI_MCP_SOCKET: socketPath,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        O8_FORCE_BUNDLED_SERVERS: '1',
        O8_PRESHIP_GATE: '1',
        O8_API_PORT: String(apiPort),
        O8_WS_PORT: String(wsPort),
        O8_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    child.stdout.on('data', (chunk) => { stdout = tail(stdout + chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk.toString()); });

    signalFailed = 'socket-warmup';
    await waitForSocket(client, Date.now() + SOCKET_TIMEOUT_MS);
    signalFailed = 'dashboard-route';
    const dashboardRoute = await waitForDashboard(client, Date.now() + ROUTE_TIMEOUT_MS);
    signalFailed = 'dashboard-boot-health';
    await waitForHealthyBoot(client, Date.now() + HEALTH_TIMEOUT_MS);
    signalFailed = 'hide-main-window';
    await invokeTauri(client, 'plugin:window|hide', { label: 'main' });
    const mainVisible = await invokeTauri(client, 'plugin:window|is_visible', { label: 'main' });
    if (mainVisible !== false) throw new Error('main window remained visible before idle sampling');
    signalFailed = 'footprint-budget';
    const footprintContext = {
      rootPid: child.pid,
      appPath: resolved.appPath,
      dataDir,
      updaterArchivePath: resolved.appTar,
      webkitBaseline,
      version: info.version,
      gitSha: info.gitSha,
      mode,
      artifactDigest,
    };
    await sleep(FOOTPRINT_COOLDOWN_MS);
    const idleSamples = await collectFootprintSamples(footprintContext, sampleCount, 'idle-hidden');

    signalFailed = 'footprint-load-scenario';
    const { plan } = planGateLoadScenario({
      env: process.env,
      // The release script and packageInfo both require this checkout as cwd.
      checkoutRoot: process.cwd(),
      operatorDataDir: operatorDataDir(),
      homeDir: os.homedir(),
      binaryAvailable: (binaryName) => commandOnPath(binaryName),
      // The child's own token comes from the isolated profile provisioned above.
      apiTokenAvailable: () => readGateToken(dataDir).length > 0,
    });
    let loadScenario = plan;
    if (plan.available) {
      preserveDataDir = true;
      loadScenario = await runLoadScenario({
        plan,
        driver: createHttpLoadDriver({
          apiBase: `http://127.0.0.1:${resolveChildApiPort(dataDir, apiPort)}`,
          token: readGateToken(dataDir),
          repoPath: plan.repoPath,
          runtime: plan.runtime,
          rootPid: child.pid,
        }),
        sample: ({ laneCount }) => collectFootprintSamples(footprintContext, sampleCount, 'loaded-lanes', laneCount),
      });
      preserveDataDir = !loadTeardownProvesClean(loadScenario);
    }

    signalFailed = 'footprint-budget';
    footprintReceipt = buildFootprintSeriesReceipt({ samples: idleSamples, loadScenario });
    const receiptPath = writeFootprintReceipt(resolved.appPath, footprintReceipt);
    // The receipt lands FIRST so preserved residual state is on the record even
    // when it fails the gate; the harness reports what survived, never deletes it.
    if (loadScenario.reason === LOAD_UNAVAILABLE_REASONS.residualStatePreserved) {
      throw new Error(`load scenario preserved residual state: ${JSON.stringify(loadScenario.teardown.residuals.counts)}`);
    }
    if (footprintReceipt.verdict !== 'PASS') {
      const failed = footprintReceipt.checks
        .filter((check) => !check.pass)
        .map((check) => `${check.metric}=${check.actual} ceiling=${check.ceiling}`)
        .join(', ');
      throw new Error(`footprint regression ceiling exceeded: ${failed}`);
    }

    signalFailed = 'webview-console-errors';
    capturedConsoleErrors = await collectFatalConsoleErrors(client);
    if (capturedConsoleErrors.length > 0) {
      throw new Error('uncaught webview error captured');
    }

    writeAudit({
      outcome: 'PASS',
      version: info.version,
      gitSha: info.gitSha,
      mode,
      dashboardRoute,
      interactiveElapsedMs: Date.now() - started,
      nodeVersion: process.version,
      footprintBudgetVersion: footprintReceipt.budgetVersion,
      idlePhysicalBytes: footprintReceipt.metrics.idlePhysicalBytes,
      idleCpuPercent: footprintReceipt.metrics.idleCpuPercent,
      idleProcessChurn: footprintReceipt.metrics.idleProcessChurn,
      footprintSampleCount: footprintReceipt.sampleCount,
      loadScenarioAvailable: footprintReceipt.loadScenario?.available === true,
      loadScenarioReason: footprintReceipt.loadScenario?.reason,
    });
    console.log(`[preship-webview-gate] footprint receipt ${receiptPath}`);
    if (footprintReceipt.loadScenario?.available !== true) {
      console.log(`[preship-webview-gate] loaded footprint not measured: ${footprintReceipt.loadScenario?.reason}`);
    }
    console.log(`[preship-webview-gate] PASS real WKWebView booted ${path.basename(resolved.appPath)} in ${Date.now() - started}ms`);
  } catch (error) {
    writeAudit({
      outcome: 'FAIL',
      version: info.version,
      gitSha: info.gitSha,
      mode,
      nodeVersion: process.version,
      signalFailed,
      capturedConsoleErrors,
      childStderrTail: tail(stderr),
      footprintBudgetVersion: footprintReceipt?.budgetVersion,
      idlePhysicalBytes: footprintReceipt?.metrics.idlePhysicalBytes,
      idleCpuPercent: footprintReceipt?.metrics.idleCpuPercent,
      idleProcessChurn: footprintReceipt?.metrics.idleProcessChurn,
    });
    console.error(`[preship-webview-gate] FAIL signal=${signalFailed}: ${error?.message ?? error}`);
    if (capturedConsoleErrors.length > 0) {
      console.error('[preship-webview-gate] captured non-console errors:');
      console.error(JSON.stringify(capturedConsoleErrors, null, 2));
    }
    console.error(`[preship-webview-gate] child stderr tail:\n${tail(stderr)}`);
    console.error(`[preship-webview-gate] child stdout tail:\n${tail(stdout)}`);
    process.exitCode = 1;
  } finally {
    try {
      await cleanupGate({ client, child, dataDir, socketPath, preserveDataDir });
    } finally {
      rmSync(stagedAppDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(`[preship-webview-gate] FATAL: ${error?.message ?? error}`);
    process.exit(1);
  });
}
