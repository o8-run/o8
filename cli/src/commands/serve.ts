import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer, Socket } from 'node:net';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliError, EXIT } from '../api.js';
import { resolveCliDataDir } from '../config.js';
import { type OutputMode } from '../output.js';
import {
  formatServeLogSessionBoundary,
  prepareServeLog,
  readServeSupervisorPid,
  runServeAgentCommand,
  sourceServeApiLaunch,
  serveStartupTimeoutMs,
  superviseServeDaemon,
  waitForSupervisorRestart,
} from './serve-lifecycle.js';
import { readOrCreateServeId as readOrCreateId, acquireServeOperation, withServeOperation, withServeStateMutation, sameServeGeneration, mergeServeClaims, serveProcessClaim, stopServeProcesses, type ServeProcessClaim } from './serve-processes.js';
import { validateReviewMode } from '../../../src/lib/lane/review-mode.js';
import { renewServeToken } from './serve-token.js';
import { CLI_VERSION } from './version.js';
import { outputServeNotRunning, outputServeState, outputServeStopped } from './serve-output.js';
import { resolveListenHost } from '../../../src/lib/panel/listen-host.js';

const PROD_API_PORT_BLOCK = [47100, 47101, 47102, 47103, 47104] as const;
const PROD_WS_PORT_BLOCK = [47105, 47106, 47107, 47108, 47109] as const;
const POLL_MS = 100;

type ServeMode = 'development' | 'packaged';
type ServeStatus = 'starting' | 'ready' | 'stopping' | 'failed';

interface ServeChildState {
  role: 'api' | 'ws';
  pid: number;
  identity?: ServeProcessClaim['identity'];
}

interface ServeState {
  schema: 'o8/serve-state/v1';
  pid: number;
  pgid: number;
  generation?: string;
  shutdownOwner?: string;
  processIdentity?: ServeProcessClaim['identity'];
  shutdownProcesses?: ServeProcessClaim[];
  apiPort: number;
  wsPort: number;
  mode: ServeMode;
  reviewMode?: 'automatic' | 'manual';
  root: string;
  startedAt: string;
  status: ServeStatus;
  children: ServeChildState[];
  supervisorPid?: number;
  supervisorIdentity?: ServeProcessClaim['identity'];
  version?: string;
  error?: string;
}

interface ServePaths {
  dataDir: string;
  pidFile: string;
  stateFile: string;
  apiPortFile: string;
  wsPortFile: string;
  tokenFile: string;
  logFile: string;
}

interface LaunchPlan {
  mode: ServeMode;
  root: string;
  api: { command: string; args: string[] };
  ws: { command: string; args: string[] };
}

function servePaths(): ServePaths {
  const dataDir = resolveCliDataDir();
  return {
    dataDir,
    pidFile: join(dataDir, 'serve.pid'),
    stateFile: join(dataDir, 'serve-state.json'),
    apiPortFile: join(dataDir, 'api-port'),
    wsPortFile: join(dataDir, 'ws-port'),
    tokenFile: join(dataDir, 'ws-token'),
    logFile: join(dataDir, 'logs', 'serve.log'),
  };
}

function parsePid(raw: string): number | null {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readOwnerPid(paths: ServePaths): number | null {
  try {
    return parsePid(readFileSync(paths.pidFile, 'utf8'));
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(paths: ServePaths): ServeState | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as ServeState;
    return parsed?.schema === 'o8/serve-state/v1' ? parsed : null;
  } catch {
    return null;
  }
}

function writeStateUnchecked(paths: ServePaths, state: ServeState): void {
  const temporary = `${paths.stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.stateFile);
}

function writeState(paths: ServePaths, state: ServeState, owner?: string): void {
  withServeStateMutation(paths.stateFile, () => {
    const current = readState(paths);
    const pid = readOwnerPid(paths);
    if ((current && !sameServeGeneration(state, current)) || (pid && pid !== state.pid)) {
      throw new Error('Runtime generation changed; stale state write refused.');
    }
    if (current?.shutdownOwner && current.shutdownOwner !== owner) return;
    state.shutdownProcesses = mergeServeClaims(current?.shutdownProcesses, state.shutdownProcesses);
    writeStateUnchecked(paths, state);
  });
}

function completeShutdown(paths: ServePaths, state: ServeState, owner: string, preserveSupervisor = false): void {
  withServeStateMutation(paths.stateFile, () => {
    const current = readState(paths);
    const pid = readOwnerPid(paths);
    if ((current && (!sameServeGeneration(state, current) || (current.shutdownOwner && current.shutdownOwner !== owner)))
      || (pid && pid !== state.pid)) throw new Error('Runtime generation changed; stale cleanup refused.');
    if (preserveSupervisor && state.supervisorPid) {
      writeFileSync(paths.stateFile, JSON.stringify({ ...state, children: [], shutdownOwner: undefined, shutdownProcesses: undefined, daemonStopped: true }), { mode: 0o600 });
    } else if (current) rmSync(paths.stateFile);
    if (pid) rmSync(paths.pidFile);
  });
}

function cleanStaleOwner(paths: ServePaths): void {
  withServeStateMutation(paths.stateFile, () => {
    const retained = readState(paths);
    if (retained?.processIdentity || retained?.shutdownProcesses?.length || retained?.children?.some((child) => processAlive(child.pid))) return;
    const supervisorPid = readServeSupervisorPid(paths.stateFile);
    if (supervisorPid && processAlive(supervisorPid)) return;
    const pid = readOwnerPid(paths);
    if (pid && processAlive(pid)) return;
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.stateFile, { force: true });
  });
}

async function assertServeAgentInstallAvailable(paths: ServePaths): Promise<void> {
  mkdirSync(paths.dataDir, { recursive: true });
  return withServeOperation(paths.dataDir, async () => {
    cleanStaleOwner(paths);
    const supervisorPid = readServeSupervisorPid(paths.stateFile);
    const ownerPid = readOwnerPid(paths);
    const runningPid = supervisorPid && processAlive(supervisorPid)
      ? supervisorPid
      : ownerPid && processAlive(ownerPid) ? ownerPid : null;
    if (runningPid) {
      throw new CliError(
        'serve_already_running',
        `Cannot install the launch agent while headless o8 is already running with pid ${runningPid}.`,
        EXIT.CONFLICT,
        'Run `o8 serve stop`, then retry `o8 serve agent install`.',
      );
    }
    await assertDataDirAvailableForServe(paths);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function apiIsReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/identity`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = await response.json() as { product?: unknown };
    return body.product === 'o8';
  } catch {
    return false;
  }
}

function readPort(path: string): number | null {
  try {
    const port = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

async function assertDataDirAvailableForServe(paths: ServePaths): Promise<void> {
  const retained = readState(paths);
  if (retained?.shutdownProcesses?.length || (retained?.processIdentity && !processAlive(retained.pid))) {
    throw new CliError('serve_stop_unconfirmed', 'Prior shutdown requires ownership reconciliation before restart.', EXIT.CONFLICT);
  }
  if (existsSync(paths.pidFile)) return;
  const apiPort = readPort(paths.apiPortFile);
  if (!apiPort || !await apiIsReady(apiPort)) return;
  throw new CliError(
    'serve_desktop_owns_data_dir',
    `The desktop app already owns this data directory through its healthy API on port ${apiPort}.`,
    EXIT.CONFLICT,
    'Quit the desktop app or use a different O8_DATA_DIR or CORTEX_IDE_DATA_DIR, then retry.',
  );
}

async function takeAvailablePort(candidates: readonly number[], skip?: number): Promise<number> {
  for (const candidate of candidates) {
    if (candidate === skip) continue;
    // A listener bound on IPv6 or 0.0.0.0 can coexist with a short-lived
    // 127.0.0.1 probe on macOS. Check the real connect path before trusting a
    // successful bind, matching the sidecar's collision guard.
    if (await portAcceptsConnections(candidate)) continue;
    const port = await new Promise<number | null>((resolve) => {
      const server = createServer();
      server.unref();
      server.once('error', () => resolve(null));
      server.listen(candidate, '127.0.0.1', () => {
        server.close(() => resolve(candidate));
      });
    });
    if (port) return port;
  }
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate an ephemeral port.')));
        return;
      }
      const port = address.port;
      if (port === skip) {
        server.close(() => {
          void takeAvailablePort([], skip).then(resolve, reject);
        });
        return;
      }
      server.close(() => resolve(port));
    });
  });
}

function findProjectRoot(start: string): string | null {
  let current = start;
  const filesystemRoot = parse(current).root;
  while (true) {
    if (
      existsSync(join(current, 'package.json'))
      && existsSync(join(current, 'src', 'ws-server.ts'))
      && existsSync(join(current, 'node_modules', 'next', 'dist', 'bin', 'next'))
      && existsSync(join(current, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
    ) {
      return current;
    }
    if (current === filesystemRoot) return null;
    current = dirname(current);
  }
}

function resolveLaunchPlan(): LaunchPlan {
  const cliEntry = fileURLToPath(import.meta.url);
  const bundledServerDir = dirname(dirname(cliEntry));
  const bundledApi = join(bundledServerDir, 'server.js');
  const bundledWs = join(bundledServerDir, 'ws-server.mjs');
  if (existsSync(bundledApi) && existsSync(bundledWs)) {
    return {
      mode: 'packaged',
      root: bundledServerDir,
      api: { command: process.execPath, args: [bundledApi] },
      ws: { command: process.execPath, args: [bundledWs] },
    };
  }

  const configuredRoot = process.env.O8_SERVE_ROOT?.trim();
  const projectRoot = (configuredRoot && findProjectRoot(configuredRoot))
    || findProjectRoot(process.cwd())
    || findProjectRoot(dirname(cliEntry));
  if (!projectRoot) {
    throw new CliError(
      'serve_entries_missing',
      'Could not find bundled server entries or a source checkout with installed dependencies.',
      EXIT.NOT_FOUND,
      'Run from an o8 source checkout after `npm install`, or reinstall the packaged app.',
    );
  }
  return {
    mode: 'development',
    root: projectRoot,
    api: sourceServeApiLaunch(projectRoot),
    ws: {
      command: process.execPath,
      args: [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/ws-server.ts'],
    },
  };
}

function getOrCreateToken(paths: ServePaths): string {
  try {
    const existing = readFileSync(paths.tokenFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {}
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(paths.tokenFile, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(paths.tokenFile, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
    writeFileSync(paths.tokenFile, token, { mode: 0o600 });
  }
  return token;
}

function appendNodeImport(existing: string | undefined, path: string): string {
  const flag = `--import=${path}`;
  return existing?.trim() ? `${existing.trim()} ${flag}` : flag;
}

function spawnService(
  role: ServeChildState['role'],
  entry: LaunchPlan['api'],
  plan: LaunchPlan,
  env: NodeJS.ProcessEnv,
  apiPort: number,
): ChildProcess {
  const args = role === 'api' && plan.mode === 'development'
    ? [...entry.args, '-p', String(apiPort), '-H', resolveListenHost(env)]
    : entry.args;
  return spawn(entry.command, args, {
    cwd: plan.root,
    env,
    stdio: 'inherit',
  });
}

async function waitForDaemonReady(paths: ServePaths, pid: number, timeoutMs: number): Promise<ServeState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(paths);
    if (state?.pid === pid && state.status === 'failed') {
      throw new CliError('serve_start_failed', state.error ?? 'The daemon failed to start.', EXIT.CONNECTION_REFUSED);
    }
    if (
      state?.pid === pid
      && state.status === 'ready'
      && await apiIsReady(state.apiPort)
      && await portAcceptsConnections(state.wsPort)
    ) {
      return state;
    }
    if (!processAlive(pid)) break;
    await wait(POLL_MS);
  }
  throw new CliError(
    'serve_start_failed',
    'The headless server did not become ready before the startup deadline.',
    EXIT.CONNECTION_REFUSED,
    `Inspect ${paths.logFile}.`,
  );
}

async function startServe(mode: OutputMode): Promise<number> {
  validateReviewMode();
  const paths = servePaths();
  mkdirSync(dirname(paths.logFile), { recursive: true });
  const { child, timeoutMs } = await withServeOperation(paths.dataDir, async () => {
    cleanStaleOwner(paths);
    const existingPid = readOwnerPid(paths);
    const supervisorPid = readServeSupervisorPid(paths.stateFile);
    const runningPid = supervisorPid && processAlive(supervisorPid) ? supervisorPid : existingPid;
    if (runningPid && processAlive(runningPid)) {
      throw new CliError(
        'serve_already_running',
        `Headless o8 is already running with pid ${runningPid}.`,
        EXIT.CONFLICT,
        'Run `o8 serve status` or `o8 serve stop`.',
      );
    }
    await assertDataDirAvailableForServe(paths);

    const plan = resolveLaunchPlan();
    prepareServeLog(paths.logFile);
    const logFd = openSync(paths.logFile, 'a', 0o600);
    const cliEntry = process.argv[1];
    const generation = randomUUID();
    const child = spawn(process.execPath, [cliEntry, 'serve', '__daemon'], {
      cwd: plan.root,
      detached: true,
      env: {
        ...process.env,
        O8_SERVE_ROOT: plan.root,
        O8_SERVE_LAUNCH_MODE: plan.mode,
        O8_SERVE_GENERATION: generation,
      },
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
    if (!child.pid) {
      throw new CliError('serve_spawn_failed', 'Failed to spawn the headless daemon.', EXIT.CONNECTION_REFUSED);
    }
    try {
      withServeStateMutation(paths.stateFile, () => {
        writeFileSync(paths.pidFile, String(child.pid), { flag: 'wx', mode: 0o600 });
        writeStateUnchecked(paths, { schema: 'o8/serve-state/v1', pid: child.pid!, pgid: child.pid!, generation,
          apiPort: 0, wsPort: 0, mode: plan.mode, root: plan.root, startedAt: new Date().toISOString(), status: 'starting', children: [] });
      });
    } catch (error) {
      try { child.kill('SIGTERM'); } catch {}
      const ownerPid = readOwnerPid(paths);
      if (ownerPid && processAlive(ownerPid)) {
        throw new CliError(
          'serve_already_running',
          `Headless o8 is already running with pid ${ownerPid}.`,
          EXIT.CONFLICT,
        );
      }
      throw error;
    }
    child.unref();
    return { child, timeoutMs: serveStartupTimeoutMs(plan.mode) };
  });
  const state = await waitForDaemonReady(paths, child.pid!, timeoutMs);
  outputServeState(mode, state, true, true);
  return EXIT.OK;
}

async function runLaunchAgent(): Promise<number> {
  const paths = servePaths();
  mkdirSync(paths.dataDir, { recursive: true });
  await withServeOperation(paths.dataDir, async () => {
    cleanStaleOwner(paths);
    await assertDataDirAvailableForServe(paths);
    const ownerPid = readOwnerPid(paths);
    if (ownerPid && processAlive(ownerPid)) {
      throw new CliError('serve_already_running', `Headless o8 is already running with pid ${ownerPid}.`, EXIT.CONFLICT);
    }
  });
  const plan = resolveLaunchPlan();
  return superviseServeDaemon({
    cliEntry: process.argv[1],
    launchMode: plan.mode,
    logPath: paths.logFile,
    pidFile: paths.pidFile,
    stateFile: paths.stateFile,
    workingDirectory: plan.root,
  });
}

async function statusServe(mode: OutputMode): Promise<number> {
  const paths = servePaths();
  const pid = readOwnerPid(paths);
  const state = readState(paths);
  if (!pid || !state || state.pid !== pid || !processAlive(pid)) {
    return outputServeNotRunning(mode);
  }
  const healthy = state.status === 'ready'
    && await apiIsReady(state.apiPort)
    && await portAcceptsConnections(state.wsPort);
  outputServeState(mode, state, true, healthy);
  return healthy ? EXIT.OK : EXIT.CONNECTION_REFUSED;
}

async function stopServe(mode: OutputMode, report = true): Promise<number> {
  const paths = servePaths();
  return withServeOperation(paths.dataDir, async (owner) => {
    const pid = readOwnerPid(paths);
    const state = readState(paths);
    if (!state || (pid && pid !== state.pid)) {
      throw new CliError('serve_not_running', 'No matching headless ownership record exists.', EXIT.NOT_FOUND);
    }
    if (!state.shutdownProcesses?.length && ![state.pid, state.supervisorPid, ...state.children.map((child) => child.pid)]
      .some((owner) => owner && processAlive(owner))) {
      throw new CliError('serve_stop_unconfirmed', 'The recorded ancestors exited before a descendant census was retained.', EXIT.CONFLICT);
    }
    const seeds = state.shutdownProcesses ?? [
      ...(state.supervisorPid ? [{ pid: state.supervisorPid, identity: state.supervisorIdentity }] : []),
      { pid: state.pid, identity: state.processIdentity }, ...state.children,
    ].map(({ pid: owner, identity }) => ({ pid: owner, identity })) as ServeProcessClaim[];
    try {
      const receipt = await stopServeProcesses(seeds, (claims) => {
        state.shutdownOwner = owner;
        state.shutdownProcesses = claims;
        writeState(paths, state, owner);
      });
      const persisted = { ...receipt, targetPid: state.pid, generation: state.generation ?? null, cleanupCommitted: false };
      writeFileSync(join(paths.dataDir, 'serve-stop.json'), `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
      if (!receipt.confirmedDead) throw new Error('Owned descendants remain unconfirmed.');
      completeShutdown(paths, state, owner);
      writeFileSync(join(paths.dataDir, 'serve-stop.json'), `${JSON.stringify({ ...persisted, cleanupCommitted: true }, null, 2)}\n`, { mode: 0o600 });
      return report ? outputServeStopped(mode, state.pid) : EXIT.OK;
    } catch (error) {
      throw new CliError('serve_stop_failed', error instanceof Error ? error.message : 'Process ownership is unverified.', EXIT.CONFLICT);
    }
  });
}

async function restartServe(mode: OutputMode): Promise<number> {
  const requestedMode = validateReviewMode();
  const paths = servePaths();
  const state = readState(paths);
  const supervisorPid = readServeSupervisorPid(paths.stateFile);
  if (supervisorPid && processAlive(supervisorPid)) {
    const admitted = await withServeOperation(paths.dataDir, async () => withServeStateMutation(paths.stateFile, () => {
      const current = readState(paths);
      if (!state || !sameServeGeneration(state, current) || current?.supervisorPid !== supervisorPid || current.shutdownOwner) {
        throw new CliError('serve_restart_conflict', 'Runtime ownership changed before restart admission.', EXIT.CONFLICT);
      }
      const reviewMode = current.reviewMode ?? 'automatic';
      if (process.env.O8_REVIEW_MODE !== undefined && requestedMode !== reviewMode) {
        throw new CliError('serve_review_mode_change_requires_stop', 'Stop the supervised profile before starting it with a different review mode.', EXIT.CONFLICT);
      }
      const previousPid = readOwnerPid(paths) ?? current.pid;
      process.kill(supervisorPid, 'SIGHUP');
      return { previousPid, reviewMode };
    }));
    const restarted = await waitForSupervisorRestart({
      supervisorPid,
      timeoutMs: serveStartupTimeoutMs(state?.mode ?? 'packaged'),
      pollMs: POLL_MS,
      logPath: paths.logFile,
      processAlive,
      readReadyState: async () => {
        const pid = readOwnerPid(paths);
        const current = readState(paths);
        if (!pid || pid === admitted.previousPid || current?.pid !== pid) return null;
        if (current.supervisorPid !== supervisorPid || current.status !== 'ready') return null;
        return await apiIsReady(current.apiPort) && await portAcceptsConnections(current.wsPort) ? current : null;
      },
    });
    if ((restarted.reviewMode ?? 'automatic') !== admitted.reviewMode) {
      throw new CliError('serve_review_mode_mismatch', 'The restarted profile did not retain its admitted review mode.', EXIT.CONFLICT);
    }
    outputServeState(mode, restarted, true, true);
    return EXIT.OK;
  }
  const ownerPid = readOwnerPid(paths);
  const recoverableChildren = state?.children?.some((child) => processAlive(child.pid)) ?? false;
  if ((!ownerPid || !processAlive(ownerPid)) && !recoverableChildren) {
    return startServe(mode);
  }
  await stopServe(mode, false);
  return startServe(mode);
}

async function runDaemon(): Promise<number> {
  const paths = servePaths();
  mkdirSync(paths.dataDir, { recursive: true });
  const ownerDeadline = Date.now() + 2_000;
  while (readOwnerPid(paths) !== process.pid && Date.now() < ownerDeadline) await wait(10);
  if (readOwnerPid(paths) !== process.pid) return EXIT.CONFLICT;
  const startedAt = new Date().toISOString();
  appendFileSync(paths.logFile, formatServeLogSessionBoundary(startedAt, CLI_VERSION, process.pid), { mode: 0o600 });

  const plan = resolveLaunchPlan();
  const requestedMode = process.env.O8_SERVE_LAUNCH_MODE;
  if (requestedMode && requestedMode !== plan.mode) {
    throw new Error(`Launch mode changed from ${requestedMode} to ${plan.mode}.`);
  }
  const apiPort = await takeAvailablePort(PROD_API_PORT_BLOCK);
  const wsPort = await takeAvailablePort(PROD_WS_PORT_BLOCK, apiPort);
  const instanceId = readOrCreateId(join(paths.dataDir, 'serve-instance-id'));
  const bootId = randomUUID();
  writeFileSync(join(paths.dataDir, 'boot-id'), bootId, { mode: 0o600 });
  writeFileSync(paths.apiPortFile, String(apiPort), { mode: 0o600 });
  writeFileSync(paths.wsPortFile, String(wsPort), { mode: 0o600 });
  const token = getOrCreateToken(paths);
  const supervisorPid = parsePid(process.env.O8_SERVE_SUPERVISOR_PID ?? '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    O8_DATA_DIR: paths.dataDir,
    CORTEX_IDE_DATA_DIR: paths.dataDir,
    O8_API_PORT: String(apiPort),
    O8_WS_PORT: String(wsPort),
    PORT: String(apiPort),
    WS_PORT: String(wsPort),
    // Next's standalone server binds HOSTNAME (default 0.0.0.0, and a login
    // shell's HOSTNAME is the machine name). Loopback unless O8_LAN_ACCESS=1.
    HOSTNAME: resolveListenHost(process.env),
    NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    O8_BOOT_ID: bootId,
    O8_INSTANCE_ID: instanceId,
    O8_NODE_BIN: process.execPath,
    O8_SIDECAR_PID: String(process.pid),
    WS_TOKEN: token,
    NODE_ENV: plan.mode === 'packaged' ? 'production' : 'development',
  };
  if (validateReviewMode() === 'manual') {
    env.O8_HEAL_BOT_ENABLED = '0';
    env.O8_SUPERVISOR_AUTO_ESCALATE = '0';
    env.O8_EXPLAINER = '0';
    env.O8_BRAIN_WARMUP = '0';
  }
  if (plan.mode === 'packaged') {
    env.O8_PACKAGED_APP = '1';
    env.NODE_COMPILE_CACHE = join(paths.dataDir, 'compile-cache');
    if (existsSync(join(plan.root, 'operator-mcp-server.mjs'))) {
      env.O8_BUNDLED_MCP_DIR = plan.root;
      env.O8_BUNDLED_MCP_PATH = join(plan.root, 'operator-mcp-server.mjs');
    }
  } else {
    env.NODE_OPTIONS = appendNodeImport(env.NODE_OPTIONS, join(plan.root, 'scripts', 'register-server-only-stub.mjs'));
  }

  const state: ServeState = {
    schema: 'o8/serve-state/v1',
    pid: process.pid,
    pgid: process.pid,
    generation: process.env.O8_SERVE_GENERATION,
    processIdentity: (await serveProcessClaim(process.pid)).identity,
    apiPort,
    wsPort,
    mode: plan.mode,
    reviewMode: validateReviewMode(),
    root: plan.root,
    startedAt,
    status: 'starting',
    children: [],
    ...(supervisorPid ? { supervisorPid, supervisorIdentity: (await serveProcessClaim(supervisorPid)).identity } : {}),
    version: CLI_VERSION,
  };
  writeState(paths, state);

  const apiChild = spawnService('api', plan.api, plan, env, apiPort);
  const wsChild = spawnService('ws', plan.ws, plan, env, apiPort);
  state.children = [
    ...(apiChild.pid ? [{ role: 'api' as const, pid: apiChild.pid }] : []),
    ...(wsChild.pid ? [{ role: 'ws' as const, pid: wsChild.pid }] : []),
  ];
  writeState(paths, state);

  let shuttingDown = false;
  const shutdown = async (exitCode: number, reason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    let lease: ReturnType<typeof acquireServeOperation> | undefined;
    const deadline = Date.now() + 5_000;
    while (!lease) {
      try { lease = acquireServeOperation(paths.dataDir); } catch (error) {
        if (!(error instanceof CliError) || error.code !== 'serve_operation_busy') throw error;
        const current = readState(paths);
        if (sameServeGeneration(state, current) && current?.shutdownOwner) process.exit(exitCode);
        if (Date.now() >= deadline) process.exit(EXIT.CONFLICT);
        await wait(25);
      }
    }
    state.shutdownOwner = lease.id;
    state.status = reason ? 'failed' : 'stopping';
    if (reason) state.error = reason;
    try {
      writeState(paths, state, lease.id);
      if (state.children.some((child) => !child.identity)) throw new Error('Child birth identity was not captured.');
      const receipt = await stopServeProcesses(state.children as ServeProcessClaim[], (claims) => {
        state.shutdownProcesses = [
          { pid: state.pid, identity: state.processIdentity! }, ...claims,
        ];
        writeState(paths, state, lease.id);
      });
      if (!receipt.confirmedDead) throw new Error('Owned descendants remain unconfirmed.');
      completeShutdown(paths, state, lease.id, true);
    } catch {
      state.shutdownProcesses ??= [{ pid: state.pid, identity: state.processIdentity! }, ...state.children as ServeProcessClaim[]];
      state.status = 'failed';
      state.error = 'Owned descendant shutdown is unconfirmed; ownership evidence retained.';
      try { writeState(paths, state, lease.id); } catch { /* preserve a successor record */ } finally { lease.release(); }
      process.exit(EXIT.CONFLICT);
    }
    lease.release();
    process.exit(exitCode);
  };

  const fatalShutdown = (kind: string, reason: unknown): void => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    void shutdown(EXIT.CONNECTION_REFUSED, `${kind}: ${detail}`).catch(() => {
      process.exit(EXIT.CONNECTION_REFUSED);
    });
  };

  process.once('SIGTERM', () => { void shutdown(EXIT.OK); });
  process.once('SIGINT', () => { void shutdown(EXIT.OK); });
  process.once('uncaughtException', (error) => { fatalShutdown('uncaughtException', error); });
  process.once('unhandledRejection', (reason) => { fatalShutdown('unhandledRejection', reason); });
  for (const [role, child] of [['api', apiChild], ['ws', wsChild]] as const) {
    child.once('error', (error) => { fatalShutdown(`${role} spawn`, error); });
    child.once('exit', (code, signal) => {
      if (!shuttingDown) {
        void shutdown(EXIT.CONNECTION_REFUSED, `${role} child exited code=${String(code)} signal=${String(signal)}`);
      }
    });
  }

  try {
    if (!apiChild.pid || !wsChild.pid) throw new Error('Failed to start one or more server children.');
    for (const child of state.children) child.identity = (await serveProcessClaim(child.pid)).identity;
    if (shuttingDown) return EXIT.CONNECTION_REFUSED;
    writeState(paths, state);
  } catch (error) {
    await shutdown(EXIT.CONNECTION_REFUSED, error instanceof Error ? error.message : 'Child identity unavailable.');
    return EXIT.CONNECTION_REFUSED;
  }

  const readyDeadline = Date.now() + serveStartupTimeoutMs(plan.mode);
  while (Date.now() < readyDeadline) {
    if (await apiIsReady(apiPort) && await portAcceptsConnections(wsPort)) {
      state.status = 'ready';
      writeState(paths, state);
      await new Promise<void>(() => {});
      return EXIT.OK;
    }
    await wait(POLL_MS);
  }
  await shutdown(EXIT.CONNECTION_REFUSED, 'Server children did not become ready before the startup deadline.');
  return EXIT.CONNECTION_REFUSED;
}

export async function runServe(
  mode: OutputMode,
  subcommand: string | undefined,
  rest: string[],
): Promise<number> {
  if (subcommand === 'agent') {
    const paths = servePaths();
    const plan = resolveLaunchPlan();
    return runServeAgentCommand(mode, rest[0], rest.slice(1), {
      cliEntry: process.argv[1],
      dataDir: paths.dataDir,
      logPath: paths.logFile,
      nodePath: process.execPath,
      workingDirectory: plan.root,
      assertInstallAvailable: () => assertServeAgentInstallAvailable(paths),
    });
  }
  if (rest.length > 0) {
    throw new CliError('invalid_serve_args', `Unexpected serve arguments: ${rest.join(' ')}`, EXIT.INVALID_ARGS);
  }
  if (!subcommand) return startServe(mode);
  if (subcommand === 'status') return statusServe(mode);
  if (subcommand === 'renew-token') return renewServeToken(mode);
  if (subcommand === 'stop') return stopServe(mode);
  if (subcommand === 'restart') return restartServe(mode);
  if (subcommand === '__launch_agent') return runLaunchAgent();
  if (subcommand === '__daemon') return runDaemon();
  throw new CliError(
    'unknown_serve_subcommand',
    `Unknown serve subcommand: ${subcommand}`,
    EXIT.INVALID_ARGS,
    'Use `o8 serve`, `o8 serve status`, `o8 serve stop`, `o8 serve restart`, or `o8 serve agent status`.',
  );
}
