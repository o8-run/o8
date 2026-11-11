/**
 * API-port routes that still need Next (#5243), shared by the route inventory and the write-path
 * receipt so neither keeps its own copy. With Next stopped the WS listener serves the API port, so
 * every caller of that port counts: o8 next, the desktop shell, the MCP server, the WS process and
 * the o8 CLI that workers run.
 *
 * Keys are a path (`/api/x/[id]`, the route is missing for every method) or `METHOD /api/x` (the
 * path is registered, this method is not). Remove an entry when it is registered; the inventory
 * fails while a listed route is registered or has no caller left. An entry that a middleware
 * device, worker, spectator or loopback grant reaches is owned by security; the inventory checks it.
 */
export type NextOnlyOwner = 'security' | 'seek';
export interface NextOnlyEntry {
  readonly owner: NextOnlyOwner;
  readonly reason: string;
  /** Next has no handler either, so the caller is broken today; listed for the port, not counted as Next-only. */
  readonly noNextHandler?: true;
}
export type NextOnlyTable = Readonly<Record<string, NextOnlyEntry>>;

const security = (reason: string): NextOnlyEntry => ({ owner: 'security', reason });
const seek = (reason: string): NextOnlyEntry => ({ owner: 'seek', reason });

export const NEXT_ONLY_NATIVE_PATHS: NextOnlyTable = {
  '/api/panel/ssh-machines': security('local-only trust gate (isTrustedPanelRequest) and SSH commands on saved machines'),
  '/api/runtime/acp-connection': seek('native inventory drift outside the A1 and A2 slices'),
  '/api/review/push': seek("review's push button: a POST outside the Phase A reads"),
};
// Registered paths that o8 next sends a method the native registration lacks, read from each Rust
// request's call. Hidden while the scan checked paths alone.
export const NEXT_ONLY_NATIVE_METHODS: NextOnlyTable = {
  'POST /api/panel/file-io': security('local file write chosen by path: filesystem jail'),
  'POST /api/repo-spec': security('device and worker grants'),
  'PUT /api/repo-spec': security('device and worker grants'),
};

// The shell's /api/v1/* hits were a provider's own URL (openrouter.ai), not the API port.
export const NEXT_ONLY_SHELL_PATHS: NextOnlyTable = {};
export const NEXT_ONLY_SHELL_METHODS: NextOnlyTable = {};

export const NEXT_ONLY_MCP_PATHS: NextOnlyTable = {
  '/api/broadcast/post': security('worker grant'),
  '/api/broadcast/tokens': security('mints broadcast tokens'),
  '/api/browser/proxy': security('loopback read grant'),
  '/api/cortex/sources': seek('operator MCP tool read'),
  '/api/devices/agent': security('worker grant: packet-bound device authority'),
  '/api/harness': seek('operator MCP tool'),
  '/api/orchestrator/create-mission': seek('operator mission mutation'),
  '/api/orchestrator/dispatch': seek('operator mission mutation'),
  '/api/orchestrator/merge': seek('operator merge mutation'),
  '/api/orchestrator/propose-spec': seek('operator mission mutation'),
  '/api/orchestrator/reload': seek('operator reload'),
  '/api/orchestrator/truth': security('spectator grant'),
  '/api/task-artifacts': seek('operator MCP tool'),
  '/api/task-artifacts/[id]/actions': seek('operator MCP tool'),
};
export const NEXT_ONLY_MCP_METHODS: NextOnlyTable = {
  'POST /api/setup/mcp-servers': security('stores MCP commands, env and OAuth tokens that workers receive'),
  'POST /api/visualizations': security('worker grant'),
  // Also matched the GET-only /api/visualizations/[id] path, so a path-only check counted it as served.
  'POST /api/visualizations/preview': security('worker grant'),
};

/** WS-process modules: the WS-to-Next helpers and plain fetches on the API base. */
export const NEXT_ONLY_WS_PATHS: NextOnlyTable = {
  '/api/mobile/symon': security('device grant'),
  '/api/mobile/symon/confirm': security('Symon relay: operator credential only'),
  '/api/mobile/symon/text-turn': security('Symon relay: operator credential only'),
  '/api/mobile/symon/tool': security('Symon relay: operator credential only'),
  '/api/worktrees/conflicts': seek('worktree conflict read'),
  '/api/v2/proxy/llm': security('o8 lane model calls: provider keys and spend'),
};

// The o8 CLI that packet workers and the operator run. Uncounted until the scan read cli/src.
export const NEXT_ONLY_CLI_PATHS: NextOnlyTable = {
  '/api/broadcast/automation-say': security('worker grant: automation lanes speak'),
  '/api/broadcast/post': security('worker grant'),
  '/api/broadcast/tokens': security('mints broadcast tokens'),
  '/api/browser/engine/capture': security('headless browser loads any URL; the handler relies on loopback plus token'),
  '/api/cortex/sources': seek('Brain source listing'),
  '/api/harness': seek('harness bundle and measure'),
  '/api/orchestrator/create-mission': seek('operator mission mutation'),
  '/api/orchestrator/dispatch': seek('operator mission mutation'),
  '/api/orchestrator/history': seek('orchestrator history read'),
  '/api/orchestrator/lead': seek('lead session control'),
  '/api/orchestrator/merge': seek('operator merge mutation'),
  '/api/orchestrator/truth': security('spectator grant'),
  '/api/orchestrator/workspace/maintenance': seek('workspace cleanup plan and execute'),
  '/api/orchestrator/workspace/preservation': seek('packet artifact recovery'),
  '/api/orchestrator/workspace/retention': seek('packet retention read'),
  '/api/panel/artifacts': security('worker grant: packet capture upload'),
  '/api/panel/artifacts/mirror': security('worker grant: packet proof mirror'),
  '/api/panel/managed-runs': security('worker grant'),
  '/api/panel/threads': seek('thread listing'),
  '/api/runtime/session-transform': seek('session fork and compaction'),
  '/api/setup/opencode': security('writes the operator MCP entry, with its bearer, into the OpenCode config'),
  '/api/task-artifacts': seek('operator task artifacts'),
  '/api/task-artifacts/[id]/actions': seek('operator task artifact actions'),
  '/api/tasks/[id]': security('worker grant: task read'),
  // `/api/tasks/${id}/${action}`: the worker's report and block verbs.
  '/api/tasks/[id]/[id]': security('worker grant: task report and block'),
};
export const NEXT_ONLY_CLI_METHODS: NextOnlyTable = {
};

/**
 * Callers kept on purpose whose route is out of the Next-stopped scope, so they do not count as
 * Next-only. Each needs a live caller; the route may stay unregistered or answer a native refusal.
 */
export const RETIRED_WITH_REASON: Readonly<Record<string, string>> = {
  '/api/canvas/intent': 'drives the classic webview canvas page (/preview/canvas-glass), which exists only while Next serves it',
};

export const NEXT_ONLY_TABLES = {
  native: [NEXT_ONLY_NATIVE_PATHS, NEXT_ONLY_NATIVE_METHODS],
  shell: [NEXT_ONLY_SHELL_PATHS, NEXT_ONLY_SHELL_METHODS],
  mcp: [NEXT_ONLY_MCP_PATHS, NEXT_ONLY_MCP_METHODS],
  ws: [NEXT_ONLY_WS_PATHS, {}],
  cli: [NEXT_ONLY_CLI_PATHS, NEXT_ONLY_CLI_METHODS],
} as const satisfies Record<string, readonly [NextOnlyTable, NextOnlyTable]>;

/**
 * Every listed route across callers, keyed by `/path` or `METHOD /path`, retired entries excluded.
 * Entries marked noNextHandler are included (a caller still gets 404 or 405) but are not Next-only.
 */
export function nextOnlyRoutes(): Map<string, NextOnlyEntry> {
  const routes = new Map<string, NextOnlyEntry>();
  for (const [paths, methods] of Object.values(NEXT_ONLY_TABLES)) {
    for (const [route, entry] of [...Object.entries(paths), ...Object.entries(methods)]) routes.set(route, entry);
  }
  return routes;
}
