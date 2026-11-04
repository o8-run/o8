import { cpus, loadavg } from 'node:os';

// Allow 45s per rounded-up load/core ratio: an overloaded host gets at least
// 90s for resume/model warm-up, while four base windows bound startup to 3m.
export const CODEX_FIRST_EVENT_TIMEOUT_MS = 45_000;
export const CODEX_FIRST_EVENT_TIMEOUT_CAP_MS = 180_000;

export function startCodexFirstEventWatchdog(options: {
  spawnedAt: number;
  sessionName: string;
  isAlive: () => boolean;
  readOutputBytes: () => number;
  onTimeout: (note: string) => void;
}): { firstEvent: () => void; stop: () => void } {
  const cores = Math.max(1, cpus().length);
  const spawnLoad = loadavg()[0];
  let load = spawnLoad;
  const loadBudget = () => Math.min(CODEX_FIRST_EVENT_TIMEOUT_CAP_MS,
    CODEX_FIRST_EVENT_TIMEOUT_MS * Math.max(1, Math.ceil(load / cores)));
  let budgetMs = loadBudget();
  let outputBytes = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const measurements = () => `firstEventWaitMs=${Date.now() - options.spawnedAt} budgetMs=${budgetMs} loadavg1m=${load} spawnLoadavg1m=${spawnLoad} cores=${cores} outputBytes=${outputBytes}`;
  const check = () => {
    timer = null;
    // An exited child belongs to the close path, including buffered diagnostics.
    if (stopped || !options.isAlive()) return;
    const elapsedMs = Date.now() - options.spawnedAt;
    load = loadavg()[0];
    budgetMs = Math.max(budgetMs, loadBudget());
    const bytes = options.readOutputBytes();
    // Raw output is progress, not a protocol event. On an extended startup,
    // give newly observed bytes another base window, always inside the cap.
    // Idle startup logs alone retain the normal 45s bound.
    if (bytes > outputBytes && budgetMs > CODEX_FIRST_EVENT_TIMEOUT_MS) {
      budgetMs = Math.min(CODEX_FIRST_EVENT_TIMEOUT_CAP_MS,
        Math.max(budgetMs, elapsedMs + CODEX_FIRST_EVENT_TIMEOUT_MS));
    }
    outputBytes = bytes;
    if (elapsedMs < budgetMs) {
      timer = setTimeout(check, budgetMs - elapsedMs);
      return;
    }
    const note = `Codex produced no output for ${Math.round(budgetMs / 1_000)}s — the turn was aborted; re-send to retry`;
    console.warn(`[codex-orchestrator-session] ${note} (${options.sessionName}) ${measurements()}`);
    stop();
    options.onTimeout(note);
  };
  // Re-read at 45s even if spawn was idle, and never shrink a granted budget.
  timer = setTimeout(check, Math.max(0, CODEX_FIRST_EVENT_TIMEOUT_MS - (Date.now() - options.spawnedAt)));
  return {
    stop,
    firstEvent: () => {
      if (stopped) return;
      stop();
      load = loadavg()[0];
      outputBytes = options.readOutputBytes();
      console.log(`[codex-orchestrator-session] First Codex event (${options.sessionName}) ${measurements()}`);
    },
  };
}
