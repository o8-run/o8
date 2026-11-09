/**
 * Global test isolation — the production-data-dir leak fix (2026-07-03).
 *
 * Vitest runs many test files per worker process, and the app's data-dir
 * consumers (getDb(), mission store, operator defaults) memoize on FIRST
 * touch. A test file that set CORTEX_IDE_DATA_DIR at its own module top was
 * only safe if no earlier file in the same worker had already pinned the
 * singleton to the real ~/.o8 — test-order roulette. The observed failure:
 * mission-service tests wrote REAL missions into the operator's production
 * DB on every `npm test`, replacing the current mission and getting live
 * worker lanes interrupted/archived (wave-1 assassination, 2026-07-03).
 *
 * This setup file runs before each test file's imports in every worker, so
 * the env is hermetic before ANY app module can initialize. Individual tests
 * may still override CORTEX_IDE_DATA_DIR with their own mkdtemp dirs. Keep
 * O8_DATA_DIR unset here so the canonical resolver's modern-name precedence
 * cannot shadow those per-test overrides.
 */
import { afterAll, afterEach } from 'vitest';
import { removeOwnedWorkerDataRoot } from './global-test-data-dir';
import {
  retainTestRunAfterTimeout,
  testRunRetainedAfterTimeout,
} from './test-fixture-lifecycle';

type FsModule = typeof import('node:fs');
type OsModule = typeof import('node:os');
type PathModule = typeof import('node:path');

const getBuiltinModule = (process as NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
}).getBuiltinModule;

const fs = getBuiltinModule?.('node:fs') as FsModule | undefined;
const os = getBuiltinModule?.('node:os') as OsModule | undefined;
const path = getBuiltinModule?.('node:path') as PathModule | undefined;

if (!fs || !os || !path) {
  throw new Error('Vitest setup requires Node built-in modules.');
}

// The worker sandbox is on by default on macOS. Tests turn it on explicitly,
// so an unset switch means off here on every platform.
if (process.env.O8_WORKER_SANDBOX === undefined) process.env.O8_WORKER_SANDBOX = 'off';

if (!process.env.O8_TEST_DATA_DIR_PINNED) {
  const runRoot = process.env.O8_TEST_RUN_DATA_ROOT?.trim();
  const configuredDir = process.env.CORTEX_IDE_DATA_DIR?.trim();
  const workerId = process.env.VITEST_POOL_ID?.trim()
    || process.env.VITEST_WORKER_ID?.trim()
    || String(process.pid);
  process.env.O8_TEST_DATA_DIR_PINNED = runRoot
    ? path.join(path.resolve(runRoot), `vitest-worker-${workerId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${process.pid}`)
    : configuredDir
    ? path.join(path.resolve(configuredDir), `vitest-worker-${workerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'o8-test-data-'));
}

// setupFiles runs before every test file, but a file can delete or replace the
// data-dir variables in its cleanup. Restore the worker's original boundary on
// every pass so a later file can never fall through to ~/.o8. Keep worker
// directories under an explicit caller-provided CORTEX_IDE_DATA_DIR so an
// isolation audit can inspect the supplied scratch root.
const pinnedDataDir = process.env.O8_TEST_DATA_DIR_PINNED!;
fs.mkdirSync(pinnedDataDir, { recursive: true });
const runRoot = process.env.O8_TEST_RUN_DATA_ROOT?.trim();
const ownedRunRoot = runRoot
  && path.dirname(path.resolve(pinnedDataDir)) === path.resolve(runRoot)
  && /^vitest-worker-[a-zA-Z0-9_-]+-\d+$/.test(path.basename(pinnedDataDir))
  ? runRoot
  : null;
if (ownedRunRoot) {
  const taskTimedOutOrWasCancelled = (task: {
    result?: { errors?: Array<{ message?: string }> };
    tasks?: Array<unknown>;
  }): boolean => {
    const ownError = task.result?.errors?.some((error) => (
      /timed out|cancelled|canceled/i.test(error.message ?? '')
    )) ?? false;
    return ownError || (task.tasks ?? []).some((child) => (
      taskTimedOutOrWasCancelled(child as Parameters<typeof taskTimedOutOrWasCancelled>[0])
    ));
  };
  const retainRunRoot = () => {
    retainTestRunAfterTimeout(ownedRunRoot);
  };
  afterEach((context) => {
    if (context.signal.aborted || taskTimedOutOrWasCancelled(context.task)) retainRunRoot();
  });
  const cleanupWorkerRoot = () => {
    if (testRunRetainedAfterTimeout(ownedRunRoot)) return;
    removeOwnedWorkerDataRoot(ownedRunRoot, pinnedDataDir);
  };
  process.once('exit', cleanupWorkerRoot);
  afterAll(({}, suite) => {
    if (taskTimedOutOrWasCancelled(suite)) retainRunRoot();
    process.off('exit', cleanupWorkerRoot);
    cleanupWorkerRoot();
  });
}
delete process.env.O8_DATA_DIR;
// CLI fixtures must not inherit the packet's run-scoped receipt location.
delete process.env.O8_OWNED_RUN_MARKER;
// The ship sets this to the operator's REAL data dir so the publish step can
// find the intake ledger and credential while O8_DATA_DIR points at the
// throwaway build directory (#2387, #2389). It is load-bearing in two scripts
// now, so a test file that leaks it would send a later file in the same worker
// at a real home directory. Clear it with the others.
delete process.env.O8_OPERATOR_DATA_DIR;
process.env.CORTEX_IDE_DATA_DIR = pinnedDataDir;

// Layer 3 — sever the OWNED-RUNTIME-ROOT leak (#1585, 2026-07-18).
// The canonical root defaults now follow the data-dir redirect above. Keep
// the dedicated owned-root variables pinned too as defense in depth: a test
// that overrides one adapter's resolution must still never see, let alone
// signal, a real session. Keep this list in sync with each adapter's
// rootEnvVar.
const ownedRootEnvVars = [
  'CORTEX_IDE_OWNED_CODEX_ROOT',
  'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
  'O8_OWNED_GEMINI_ROOT',
  'O8_OWNED_OPENCODE_ROOT',
  'O8_OWNED_CURSOR_ROOT',
  'O8_OWNED_GROK_ROOT',
  'O8_OWNED_PI_ROOT',
];
for (const envVar of ownedRootEnvVars) {
  process.env[envVar] = path.join(pinnedDataDir, envVar.toLowerCase());
}

// Layer 2 — sever the live-server escape hatch: any code path that resolves
// the app's API base via O8_API_PORT would otherwise reach a RUNNING prod app
// on this machine over HTTP and mutate real state (the +1 lane leak, same
// night). Point it at a dead port; tests that exercise routes import the
// handlers directly and never notice.
process.env.O8_API_PORT = '59998';
process.env.O8_TEST_API_PORT_PINNED = '1';

// WebView automation controls the installed desktop app and cannot be made
// hermetic by changing its data directory. Keep it off for the default suite.
// A live integration run must opt in and may still provide an alternate socket.
if (process.env.O8_LIVE_APP_TESTS === '1') {
  process.env.O8_TAURI_MCP_SOCKET ||= `/tmp/tauri-mcp-o8-${os.userInfo().username}.sock`;
} else {
  delete process.env.O8_TAURI_MCP_SOCKET;
}
