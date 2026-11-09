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
  '/api/runtime/acp-registry/prepare': seek('native inventory drift outside the A1 and A2 slices'),
  '/api/orchestrator/comparison-diff': security('GET has a write path; ported in the security lane'),
  '/api/panel/devices': security('device pairing and revocation'),
  '/api/tasks/[id]/preview': seek('native inventory drift outside the A1 and A2 slices'),
  '/api/review/push': seek("review's push button: a POST outside the Phase A reads"),
};
// Registered paths that o8 next sends a method the native registration lacks, read from each Rust
// request's call. Hidden while the scan checked paths alone.
export const NEXT_ONLY_NATIVE_METHODS: NextOnlyTable = {
  'POST /api/bots/[id]/thread': seek("bot mailbox reply"),
  'POST /api/cortex/cross-repo-proposals': seek('accept or dismiss a cross-repo proposal'),
  'POST /api/cortex/directives': seek('save an accepted directive'),
  'POST /api/panel/branches': seek('create a branch from the composer'),
  'POST /api/panel/file-io': security('local file write chosen by path: filesystem jail'),
  'POST /api/panel/problem-dossiers': seek('record a decision on a problem dossier'),
  'POST /api/repo-spec': security('device and worker grants'),
  'PUT /api/repo-spec': security('device and worker grants'),
  'POST /api/setup/cli-updates': seek('install or update a runtime CLI'),
};

// The shell's /api/v1/* hits were a provider's own URL (openrouter.ai), not the API port.
export const NEXT_ONLY_SHELL_PATHS: NextOnlyTable = {};
export const NEXT_ONLY_SHELL_METHODS: NextOnlyTable = {};

export const NEXT_ONLY_MCP_PATHS: NextOnlyTable = {
  '/api/agents/inbox': security('worker grant'),
  '/api/agents/message': security('worker grant'),
  '/api/agents/presence': security('worker grant'),
  '/api/broadcast/post': security('worker grant'),
  '/api/broadcast/tokens': security('mints broadcast tokens'),
  '/api/browser/proxy': security('loopback read grant'),
  '/api/cortex/sources': seek('operator MCP tool read'),
  '/api/devices/agent': security('worker grant: packet-bound device authority'),
  '/api/harness': seek('operator MCP tool'),
  '/api/leases': security('worker grant'),
  '/api/orchestrator/create-mission': seek('operator mission mutation'),
  '/api/orchestrator/dispatch': seek('operator mission mutation'),
  '/api/orchestrator/merge': seek('operator merge mutation'),
  '/api/orchestrator/propose-spec': seek('operator mission mutation'),
  '/api/orchestrator/reload': seek('operator reload'),
  '/api/orchestrator/truth': security('spectator grant'),
  '/api/task-artifacts': seek('operator MCP tool'),
  // Hidden until the scan read template literals whole: `/api/lanes/${encodeURIComponent(id)}/events`
  // was cut at the call and counted as the registered /api/lanes/[id].
  '/api/lanes/[id]/events': security('worker grant'),
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
  '/api/symon/machine/session': security('Symon machine session'),
  '/api/worktrees/conflicts': seek('worktree conflict read'),
  '/api/v2/proxy/llm': security('o8 lane model calls: provider keys and spend'),
  '/api/setup/status': seek("dispatch readiness probe, a plain fetch on the API base; ported in #5768"),
};

// The o8 CLI that packet workers and the operator run. Uncounted until the scan read cli/src.
export const NEXT_ONLY_CLI_PATHS: NextOnlyTable = {
  '/api/agents/inbox': security('worker grant'),
  '/api/agents/message': security('worker grant'),
  '/api/agents/presence': security('worker grant'),
  '/api/broadcast/automation-say': security('worker grant: automation lanes speak'),
  '/api/broadcast/post': security('worker grant'),
  '/api/broadcast/tokens': security('mints broadcast tokens'),
  '/api/browser/engine/capture': security('headless browser loads any URL; the handler relies on loopback plus token'),
  '/api/cortex/sources': seek('Brain source listing'),
  '/api/harness': seek('harness bundle and measure'),
  '/api/lanes/[id]/events': security('worker grant: packet log and report'),
  '/api/lanes/[id]/heartbeat': security('worker grant: packet heartbeat'),
  '/api/lanes/[id]/scope': security('worker grant: packet scope read and expansion'),
  '/api/leases': security('worker grant'),
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
  // Next lost this handler too (deleted as uncalled in a cleanup), so `o8 doctor --reap` gets 405 on both.
  'POST /api/lanes/reap': { ...seek('doctor reaps stale lanes'), noNextHandler: true },
  'POST /api/setup/cli-updates': seek('install or update a runtime CLI'),
  'POST /api/tasks': seek('create a task'),
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
