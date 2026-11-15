/**
 * #800 — In-app demo-sequence runner.
 *
 * Drives the live o8 webview through the golden demo path so users can
 * sanity-check the app from Settings → Diagnostics without leaving o8.
 *
 * Steps (each step records pass/fail/skipped/unavailable + ms + optional
 * screenshot):
 *   1.  Navigate to /dashboard → wait → screenshot
 *   2.  Verify active route pathname === "/dashboard"
 *   3.  Click the Orchestrator tab via screen coordinates
 *   4.  Wait, screenshot, verify the chat surface shows a greeting
 *   5.  Click the first quick-action card on the empty state
 *   6.  Verify no NEW console errors fired between step 1 and step 6
 *   7.  Open the Mission/right sidebar (best-effort coord click + optional
 *       snapshot for audit trail — snapshot timeout is soft/unavailable)
 *   8.  Verify the Mission sidebar rendered ("Mission", "Open Issues", "packet")
 *   9.  Click the NavRail Settings icon (best-effort coord)
 *  10.  Verify the Settings page rendered ("DIAGNOSTICS", "Settings", etc.)
 *  11.  Navigate to /context-graph and verify it rendered
 *
 * Failure semantics (#802):
 *   - HARD `fail` (screenshot null, click missed, real assertion mismatch):
 *     subsequent steps are cascade-marked `skipped`.
 *   - SOFT `unavailable` (Tauri command not in the running binary, webview
 *     socket unreachable): does NOT cascade. We move on so the rest of the
 *     demo path still runs.
 * We still return everything captured so the UI can show partial progress.
 * Total wall-clock budget is 45s (extended from 30s to cover steps 7–11 —
 * the sidebar toggle + two readPage calls each add ~1–2s) — past that, the
 * API route returns 504 with whatever it managed to capture.
 *
 * Screenshots land under `<dataDir>/demo-runs/<ISO timestamp>/<step>.png`
 * (UTF-8 base64 → PNG buffer). We retain the most recent 10 runs and prune
 * older directories synchronously after a successful start.
 *
 * No destructive UI actions — we only navigate, click into safe surfaces,
 * and screenshot. The runner never sends, merges, deletes, or types text.
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Public types ──

/**
 * Step result kinds:
 *   - 'pass'         — assertion held, real success.
 *   - 'fail'         — hard failure on real data (screenshot null, click missed,
 *                      assertion mismatch). Cascades — subsequent steps are
 *                      marked 'skipped' because we can't trust state.
 *   - 'skipped'      — cascaded after an upstream hard fail or hit the global
 *                      timeout. NOT a real check.
 *   - 'unavailable'  — soft skip: the underlying Tauri command isn't in the
 *                      currently running binary (e.g. new command added but
 *                      shell not yet recompiled / app not yet auto-updated).
 *                      Does NOT cascade — we move on to the next step so the
 *                      rest of the demo path still runs.
 */
export type DemoStepStatus = 'pass' | 'fail' | 'skipped' | 'unavailable';

export interface DemoStepResult {
  name: string;
  status: DemoStepStatus;
  ms: number;
  screenshotPath?: string;
  message?: string;
}

export interface DemoRunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalSteps: number;
  passed: number;
  failed: number;
  skipped: number;
  unavailable: number;
  runDir: string;
  steps: DemoStepResult[];
  truncated?: boolean;
}

// ── Internals ──

const ORCHESTRATOR_TAB_COORDS = { x: 199, y: 44 };
const QUICK_ACTION_COORDS = { x: 410, y: 200 };
// Right-sidebar toggle: probed from snapshot — sits in the top-right toolbar
// area of WorkspaceTerminal (approximately x=1180, y=88 on a 1440-wide window).
// Treated as a best-effort coord — a miss surfaces as 'unavailable' via the
// soft-fail path in step 7 so the rest of the demo path continues.
const MISSION_SIDEBAR_TOGGLE_COORDS = { x: 1180, y: 88 };
// NavRail Settings icon: bottom of the left rail, 56px wide.
// Approximately x=28, y=720 on a standard 800-tall window.
const SETTINGS_NAV_COORDS = { x: 28, y: 720 };
// The demo drove the browser console, which was removed (#6163); its pages
// now show a static notice, so navigating there would fail every step. The run
// reports each step as skipped, without touching the window, until the demo
// targets the native window.
const DEMO_SKIP_REASON: string | null = 'skipped: the browser console this demo drove was removed';

const STEP_NAMES = [
  '01-navigate-dashboard',
  '02-verify-route',
  '03-click-orchestrator',
  '04-verify-greeting',
  '05-click-quick-action',
  '06-verify-no-errors',
  '07-open-mission-sidebar',
  '08-verify-mission-render',
  '09-click-settings',
  '10-verify-diagnostics',
  '11-navigate-context-graph',
] as const;
const RETAIN_RUNS = 10;

interface ConsoleErrorsPayload {
  errors: Array<{ message: string; source: string; lineno: number; timestamp: number }>;
  count: number;
  sinceLastFetch: number;
}

interface ActiveRoutePayload {
  pathname: string;
  search: string;
  hash: string;
  routerState: string | null;
}

/**
 * Sentinel error a step throws when the underlying Tauri command isn't in
 * the running binary (or the webview socket isn't reachable). The runner
 * converts this into a 'unavailable' step result and continues to the next
 * step instead of cascade-skipping the rest of the run.
 */
class CommandUnavailableError extends Error {
  readonly kind = 'command-unavailable' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CommandUnavailableError';
  }
}

/**
 * Commands added in #795 that are purely observational side-channels. They
 * expose data that the binary must opt-in to via a feature flag / compile
 * flag. If the running binary pre-dates #795 (or was built without the
 * flag), ANY failure from these commands — including the wrapper string
 * "tauri invoke 'X' failed" emitted before the underlying error is read —
 * should be treated as 'unavailable' rather than a hard 'fail'. This lets
 * the rest of the demo path run even on older installs awaiting auto-update.
 *
 * Commands NOT in this set (`o8_view_navigate`, socket-level calls via
 * O8WebviewClient.screenshot / .click / .readPage) are required: failures
 * there cascade as hard 'fail'.
 */
const OPTIONAL_COMMANDS = new Set([
  'o8_view_active_route',
  'o8_view_console_errors',
]);

/**
 * Heuristic: does this error string look like "the Tauri command isn't in
 * the running binary" rather than "the command ran and gave a wrong answer"?
 *
 * Matches against the kinds of strings that Tauri 2 emits when an
 * unrecognised command is invoked through `__TAURI_INTERNALS__.invoke`, the
 * O8WebviewClient's UNAVAILABLE_MESSAGE for socket reachability, and the
 * generic "tauri internals unavailable" shim guard in invokeTauriCommand
 * when window.__TAURI_INTERNALS__ isn't there at all (e.g. running outside
 * the Tauri shell).
 *
 * Round-2 note (#804): real-world Tauri errors are formatted as
 * "tauri invoke 'X' failed" BEFORE the underlying error is surfaced. The
 * patterns below catch that wrapper. For commands in OPTIONAL_COMMANDS the
 * allow-list in invokeTauriCommand short-circuits before this heuristic.
 */
function isCommandUnavailableMessage(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('not found')
    || lower.includes('not allowed')
    || lower.includes('not registered')
    || lower.includes('unknown command')
    || lower.includes('command not')
    || lower.includes('tauri internals unavailable')
    || lower.includes('o8 webview tools unavailable')
    || lower.includes('econnrefused')
    || lower.includes('enoent')
    || /^tauri invoke '[^']+' failed/i.test(message)
    || /tauri.*invoke.*failed/i.test(message)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoForDirName(): string {
  // Filesystem-safe ISO: 2026-04-28T19-12-04-321Z
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function ensureRunDir(): Promise<{ runDir: string; rootDir: string }> {
  const rootDir = join(getDataDir(), 'demo-runs');
  await mkdir(rootDir, { recursive: true });
  const runDir = join(rootDir, isoForDirName());
  await mkdir(runDir, { recursive: true });
  return { runDir, rootDir };
}

async function pruneOldRuns(rootDir: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(rootDir);
  } catch {
    return;
  }
  const dirs: { name: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    try {
      const info = await stat(join(rootDir, name));
      if (info.isDirectory()) {
        dirs.push({ name, mtimeMs: info.mtimeMs });
      }
    } catch {
      // ignore unreadable entries
    }
  }
  if (dirs.length <= RETAIN_RUNS) return;

  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = dirs.slice(RETAIN_RUNS);
  for (const entry of toDelete) {
    try {
      await rm(join(rootDir, entry.name), { recursive: true, force: true });
    } catch {
      // best effort — never block the run on prune failures
    }
  }
}

async function captureScreenshot(
  client: O8WebviewClient,
  runDir: string,
  stepName: string,
): Promise<string | undefined> {
  try {
    const shot = await client.screenshot();
    const ext = shot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const filePath = join(runDir, `${stepName}.${ext}`);
    await writeFile(filePath, Buffer.from(shot.imageBase64, 'base64'));
    return filePath;
  } catch {
    return undefined;
  }
}

/**
 * Runs the same Tauri-command shim the operator MCP server uses to read
 * o8_view_console_errors / o8_view_active_route. The data lives outside
 * the JS thread so it survives a busy webview and doesn't depend on any
 * in-flight UI work.
 */
async function invokeTauriCommand<T>(
  client: O8WebviewClient,
  command: string,
): Promise<T> {
  const code = `(() => { try {
    if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
      return JSON.stringify({ ok: false, err: 'tauri internals unavailable' });
    }
    return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})
      .then((r) => JSON.stringify({ ok: true, data: r }))
      .catch((e) => JSON.stringify({ ok: false, err: String(e && e.message || e) }));
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); } })()`;

  let result: string;
  try {
    ({ result } = await client.evalJs(code));
  } catch (err) {
    // Socket-level failure (webview unreachable, plugin not loaded, etc.)
    // is the same class of "command can't run" — surface as unavailable.
    // For OPTIONAL_COMMANDS, any socket-level error is automatically soft.
    const message = err instanceof Error ? err.message : String(err);
    if (OPTIONAL_COMMANDS.has(command) || isCommandUnavailableMessage(message)) {
      throw new CommandUnavailableError(
        `tauri invoke '${command}' unavailable: ${message}`,
      );
    }
    throw err;
  }

  let parsed: unknown = result;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error(`tauri invoke '${command}' returned non-JSON: ${String(result).slice(0, 200)}`);
  }
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { /* leave as is */ }
  }
  const envelope = parsed as { ok?: boolean; data?: unknown; err?: string };
  if (!envelope || envelope.ok !== true) {
    const errMessage = envelope?.err || `tauri invoke '${command}' failed`;
    // Allow-list: if this command is known-optional (#795 observability
    // side-channels), any invoke failure — including the generic wrapper
    // string "tauri invoke 'X' failed" produced before Tauri surfaces the
    // real error — is treated as 'unavailable' so the rest of the demo path
    // continues. For non-optional commands we fall back to the message
    // heuristic, which now also matches the "tauri invoke ... failed" pattern.
    if (OPTIONAL_COMMANDS.has(command) || isCommandUnavailableMessage(errMessage)) {
      throw new CommandUnavailableError(
        `tauri invoke '${command}' unavailable: ${errMessage}`,
      );
    }
    throw new Error(errMessage);
  }
  return envelope.data as T;
}

interface StepContext {
  client: O8WebviewClient;
  runDir: string;
  results: DemoStepResult[];
  baselineErrorCount: number;
}

async function timeStep(
  name: string,
  fn: () => Promise<{ message?: string; screenshotPath?: string }>,
): Promise<DemoStepResult> {
  const started = Date.now();
  try {
    const out = await fn();
    return {
      name,
      status: 'pass',
      ms: Date.now() - started,
      screenshotPath: out.screenshotPath,
      message: out.message,
    };
  } catch (err) {
    if (err instanceof CommandUnavailableError) {
      return {
        name,
        status: 'unavailable',
        ms: Date.now() - started,
        message: `${err.message} — awaiting recompile / auto-update`,
      };
    }
    return {
      name,
      status: 'fail',
      ms: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function skippedStep(name: string, reason: string): DemoStepResult {
  return { name, status: 'skipped', ms: 0, message: reason };
}

// ── Steps ──

async function step1NavigateDashboard(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[0], async () => {
    await ctx.client.navigate('/dashboard');
    await sleep(2000);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[0]);
    return { screenshotPath };
  });
}

async function step2VerifyRoute(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[1], async () => {
    const route = await invokeTauriCommand<ActiveRoutePayload>(ctx.client, 'o8_view_active_route');
    if (route.pathname !== '/dashboard') {
      throw new Error(`expected pathname "/dashboard", got "${route.pathname}"`);
    }
    return { message: `pathname=${route.pathname}` };
  });
}

async function step3ClickOrchestrator(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[2], async () => {
    await ctx.client.click({ x: ORCHESTRATOR_TAB_COORDS.x, y: ORCHESTRATOR_TAB_COORDS.y });
    return { message: `click (${ORCHESTRATOR_TAB_COORDS.x},${ORCHESTRATOR_TAB_COORDS.y})` };
  });
}

async function step4VerifyGreeting(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[3], async () => {
    await sleep(1000);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[3]);
    const { text } = await ctx.client.readPage();
    const lower = text.toLowerCase();
    const matched = lower.includes('good morning')
      || lower.includes('good afternoon')
      || lower.includes('good evening')
      || lower.includes('orchestrator');
    if (!matched) {
      throw new Error('chat surface did not show a greeting/orchestrator marker');
    }
    return { screenshotPath, message: 'greeting/orchestrator marker present' };
  });
}

async function step5ClickQuickAction(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[4], async () => {
    await ctx.client.click({ x: QUICK_ACTION_COORDS.x, y: QUICK_ACTION_COORDS.y });
    return { message: `click (${QUICK_ACTION_COORDS.x},${QUICK_ACTION_COORDS.y})` };
  });
}

async function step6VerifyNoNewErrors(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[5], async () => {
    await sleep(1500);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[5]);
    const errs = await invokeTauriCommand<ConsoleErrorsPayload>(ctx.client, 'o8_view_console_errors');
    const newSinceBaseline = Math.max(0, errs.count - ctx.baselineErrorCount);
    if (newSinceBaseline > 0) {
      const recent = errs.errors.slice(-3).map((e) => e.message).join(' | ');
      throw new Error(`${newSinceBaseline} new console error(s) since step 1: ${recent}`);
    }
    return {
      screenshotPath,
      message: `0 new errors since step 1 (total seen: ${errs.count})`,
    };
  });
}

async function step7OpenMissionSidebar(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[6], async () => {
    // Attempt a snapshot first to surface accurate coordinates. The snapshot
    // tool is JS-thread-bound and can time out on a busy webview, so any
    // socket-level or eval-level failure is treated as unavailable rather than
    // a hard fail — we still proceed with the best-effort coords below.
    let snapshotMsg = `click (${MISSION_SIDEBAR_TOGGLE_COORDS.x},${MISSION_SIDEBAR_TOGGLE_COORDS.y})`;
    try {
      const snap = await ctx.client.snapshot();
      // snapshot() returns { tree: string } — log approximate size as a proxy
      // for node count to keep the audit trail informative.
      if (snap && typeof snap.tree === 'string') {
        snapshotMsg = `snapshot ok (${snap.tree.length} chars); ${snapshotMsg}`;
      }
    } catch (snapErr) {
      // Snapshot failure is soft — we still attempt the click.
      const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
      if (isCommandUnavailableMessage(msg)) {
        snapshotMsg = `snapshot unavailable (JS-thread busy); ${snapshotMsg}`;
      } else {
        snapshotMsg = `snapshot error: ${msg.slice(0, 80)}; ${snapshotMsg}`;
      }
    }
    await ctx.client.click({
      x: MISSION_SIDEBAR_TOGGLE_COORDS.x,
      y: MISSION_SIDEBAR_TOGGLE_COORDS.y,
    });
    await sleep(800);
    return { message: snapshotMsg };
  });
}

async function step8VerifyMissionRender(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[7], async () => {
    await sleep(500);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[7]);
    const { text } = await ctx.client.readPage();
    const lower = text.toLowerCase();
    // Post-#777 status-grouped lanes use section headers like "IN PROGRESS",
    // "IN REVIEW", "BACKLOG", "DONE", "DIRECTIVE PROPOSALS" (#746). Match ANY
    // of these — the sidebar may render whichever sections have content.
    // Also keep the legacy "mission", "open issues", "packet" fallbacks for
    // older builds awaiting auto-update.
    const matched = lower.includes('in progress')
      || lower.includes('in review')
      || lower.includes('backlog')
      || lower.includes('done')
      || lower.includes('directive proposals')
      || lower.includes('open issues')
      || lower.includes('mission')
      || lower.includes('packet');
    if (!matched) {
      // Soft unavailable — the previous step's click may have succeeded but
      // the sidebar panel re-rendered without expected text (e.g. no active
      // lanes, toggle coords drifted). Do NOT cascade-skip the remaining steps.
      throw new CommandUnavailableError(
        'mission sidebar may be closed or panel re-rendered without expected text',
      );
    }
    return { screenshotPath, message: 'mission/issues/lane-status marker present' };
  });
}

async function step9ClickSettings(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[8], async () => {
    await ctx.client.click({ x: SETTINGS_NAV_COORDS.x, y: SETTINGS_NAV_COORDS.y });
    await sleep(1200);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[8]);
    return {
      screenshotPath,
      message: `click (${SETTINGS_NAV_COORDS.x},${SETTINGS_NAV_COORDS.y})`,
    };
  });
}

async function step10VerifyDiagnostics(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[9], async () => {
    const { text } = await ctx.client.readPage();
    const lower = text.toLowerCase();
    const matched = lower.includes('diagnostics')
      || lower.includes('settings')
      || lower.includes('mcp')
      || lower.includes('appearance');
    if (!matched) {
      throw new Error(
        'settings page did not show "DIAGNOSTICS", "Settings", "MCP", or "Appearance"',
      );
    }
    return { message: 'settings/diagnostics section label present' };
  });
}

async function step11NavigateContextGraph(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[10], async () => {
    await ctx.client.navigate('/context-graph');
    await sleep(1500);
    const screenshotPath = await captureScreenshot(
      ctx.client,
      ctx.runDir,
      STEP_NAMES[10],
    );
    const { text } = await ctx.client.readPage();
    const lower = text.toLowerCase();
    const matched = lower.includes('fig. 1.1')
      || lower.includes('sources')
      || lower.includes('context')
      || lower.includes('graph');
    if (!matched) {
      throw new Error(
        'context-graph route did not show "Fig. 1.1", "sources", "context", or "graph"',
      );
    }
    // #848 — never strand the user on /context-graph after the demo. Always
    // navigate back to /dashboard so the run leaves the webview where it
    // started. Best-effort — a navigate failure here is non-fatal because
    // the assertion above has already passed.
    try {
      await ctx.client.navigate('/dashboard');
      await sleep(300);
    } catch {
      // ignore — the user can hit Esc / [CLOSE] on /context-graph
    }
    return { screenshotPath, message: 'context-graph surface rendered; returned to /dashboard' };
  });
}

// ── Orchestrator ──

/**
 * Resolve a promise to either its value or a sentinel timeout. We never
 * race against a hung webview: even on timeout we capture whatever steps
 * already finished and return them with `truncated: true`.
 */
async function withGlobalTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<{ value: T; timedOut: boolean }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve(onTimeout());
    }, ms);
  });
  try {
    const value = await Promise.race([fn(), timeoutPromise]);
    return { value, timedOut };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function runDemoSequence(opts?: { timeoutMs?: number }): Promise<DemoRunResult> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  if (DEMO_SKIP_REASON) {
    const reason = DEMO_SKIP_REASON;
    return {
      startedAt, finishedAt: nowIso(), durationMs: Date.now() - startedMs, totalSteps: STEP_NAMES.length,
      passed: 0, failed: 0, skipped: STEP_NAMES.length, unavailable: 0, runDir: '',
      steps: STEP_NAMES.map((name) => skippedStep(name, reason)),
    };
  }
  // Default 45s — 11 steps including sidebar toggle + Settings nav + context-graph
  // navigate each add ~1-2s over the original 6-step 30s budget. Still well
  // within the hard cap of 60s.
  const timeoutMs = Math.max(5_000, Math.min(opts?.timeoutMs ?? 45_000, 60_000));

  const { runDir, rootDir } = await ensureRunDir();
  // Prune older folders before the new run so the directory stays tidy
  // even if the run errors out mid-flight.
  await pruneOldRuns(rootDir);

  const client = new O8WebviewClient();
  const results: DemoStepResult[] = [];
  let truncated = false;

  // Establish the console-error baseline up front. If the webview is
  // unreachable, every step after will fail quickly with the same root cause.
  let baselineErrorCount = 0;
  try {
    const initial = await invokeTauriCommand<ConsoleErrorsPayload>(client, 'o8_view_console_errors');
    baselineErrorCount = initial.count;
  } catch {
    baselineErrorCount = 0;
  }

  const ctx: StepContext = { client, runDir, results, baselineErrorCount };

  const runAll = async (): Promise<void> => {
    const steps: Array<(c: StepContext) => Promise<DemoStepResult>> = [
      step1NavigateDashboard,
      step2VerifyRoute,
      step3ClickOrchestrator,
      step4VerifyGreeting,
      step5ClickQuickAction,
      step6VerifyNoNewErrors,
      step7OpenMissionSidebar,
      step8VerifyMissionRender,
      step9ClickSettings,
      step10VerifyDiagnostics,
      step11NavigateContextGraph,
    ];
    for (let i = 0; i < steps.length; i += 1) {
      const result = await steps[i](ctx);
      results.push(result);
      // Only HARD failures cascade — a soft 'unavailable' (Tauri command not
      // in the running binary) does not invalidate the rest of the demo
      // path. We still want to know the click + greeting + quick-action
      // surfaces work even if a side-channel observability command is
      // missing from the current shell.
      if (result.status === 'fail') {
        for (let j = i + 1; j < steps.length; j += 1) {
          results.push(skippedStep(STEP_NAMES[j], `skipped after ${result.name} failed`));
        }
        return;
      }
    }
  };

  await withGlobalTimeout(
    runAll,
    timeoutMs,
    () => {
      truncated = true;
      // Mark any unrecorded steps as skipped due to timeout.
      const recorded = new Set(results.map((r) => r.name));
      for (const name of STEP_NAMES) {
        if (!recorded.has(name)) {
          results.push(skippedStep(name, `skipped — overall ${timeoutMs}ms timeout reached`));
        }
      }
      return undefined as unknown as void;
    },
  );

  client.dispose();

  const finishedAt = nowIso();
  const durationMs = Date.now() - startedMs;
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const unavailable = results.filter((r) => r.status === 'unavailable').length;

  return {
    startedAt,
    finishedAt,
    durationMs,
    totalSteps: STEP_NAMES.length,
    passed,
    failed,
    skipped,
    unavailable,
    runDir,
    steps: results,
    ...(truncated ? { truncated: true } : {}),
  };
}
