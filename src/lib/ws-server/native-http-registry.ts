import { viewerHttpRoutes } from '@/lib/viewers/http-routes';

/** Shared shell transport registrations; importing this module loads no handlers or middleware. */
interface Route {
  path: string;
  methods: string[];
  load: () => Promise<unknown>;
}
const route = (path: string, methods: string, load: Route['load']): Route => ({ path, methods: methods.split(' '), load });

/** The public middleware still runs first; the private reader reuses its existing bearer gate. */
const repositoryRead = (load: Route['load']): Route['load'] => async () => ({
  GET: async (request: Request, context: unknown) => {
    if (process.env.O8D_NATIVE_REPOSITORY_READS === '1') {
      try {
        const { readRepositoryRequest } = await import('./repository-http-client');
        const response = await readRepositoryRequest(request);
        if (response) return response;
      } catch {
        // Loading an optional reader can fail before its own request fallback.
      }
    }
    const handlers = await load() as { GET: (request: Request, context: unknown) => Promise<Response> };
    return handlers.GET(request, context);
  },
});

// Keys mirror register_surfaces!, including surfaces whose transport is WebSocket-only.
// Each route loads its own implementation; unrelated surfaces stay cold.
export const nativeSurfaceRoutes: Record<string, Route[]> = {
  session: [
    route('/api/tasks', 'GET', () => import('@/app/api/tasks/route')),
    route('/api/runtime/discovered-sessions', 'GET', () => import('@/app/api/runtime/discovered-sessions/route')),
    route('/api/runtime/discovered-sessions/import', 'POST', () => import('@/app/api/runtime/discovered-sessions/import/route')),
    route('/api/panel/branches', 'GET', repositoryRead(() => import('@/app/api/panel/branches/route'))),
    route('/api/panel/files', 'GET', () => import('@/app/api/panel/files/route')),
    route('/api/panel/file-asset', 'GET', () => import('@/app/api/panel/file-asset/route')),
    route('/api/v2/files', 'GET', () => import('@/app/api/v2/files/route')),
    route('/api/v2/files/quick-docs', 'GET', () => import('@/app/api/v2/files/quick-docs/route')),
    route('/api/panel/file-diff', 'GET', () => import('@/app/api/panel/file-diff/route')),
    route('/api/panel/status', 'GET', () => import('@/app/api/panel/status/route')),
    route('/api/panel/resource-usage', 'GET', () => import('@/app/api/panel/resource-usage/route')),
    route('/api/panel/serve-image', 'GET', () => import('@/app/api/panel/serve-image/route')),
    route('/api/visualizations/[id]', 'GET', () => import('@/app/api/visualizations/[id]/route')),
    route('/api/visualizations', 'GET', () => import('@/lib/visualizations/read')),
    route('/api/repo-spec', 'GET', () => import('@/app/api/repo-spec/route')),
    route('/api/panel/browse-folder', 'POST', () => import('@/app/api/panel/browse-folder/route')),
    route('/api/repo-spec/asset', 'POST', () => import('@/app/api/repo-spec/asset/route')),
    route('/api/review/workspace', 'GET', () => import('@/app/api/review/workspace/route')),
    route('/api/runtime/service-tiers', 'GET', () => import('@/app/api/runtime/service-tiers/route')),
    route('/api/runtime/telemetry', 'GET', () => import('@/app/api/runtime/telemetry/route')),
    route('/api/orchestrator/status', 'GET', () => import('@/app/api/orchestrator/status/route')),
    route('/api/orchestrator/archive', 'GET', () => import('@/app/api/orchestrator/archive/route')),
    route('/api/task-artifacts/[id]/decision', 'GET POST', () => import('@/app/api/task-artifacts/[id]/decision/route')),
    route('/api/mobile/orchestrator/threads', 'GET', () => import('@/app/api/mobile/orchestrator/threads/route')),
    route('/api/orchestrator/state', 'GET PATCH', () => import('@/app/api/orchestrator/state/route')),
    route('/api/orchestrator/shared-team/active', 'GET', () => import('@/app/api/orchestrator/shared-team/active/route')),
    route('/api/runtime/inventory', 'GET', () => import('@/app/api/runtime/inventory/route')),
    route('/api/mobile/history', 'GET', () => import('@/app/api/mobile/history/route')),
    route('/api/v2/chat-history', 'GET POST PATCH', () => import('@/app/api/v2/chat-history/route')),
    route('/api/v2/chat-history/terminal-turns', 'POST', () => import('@/app/api/v2/chat-history/terminal-turns/route')),
    route('/api/orchestrator/composer-queue', 'GET POST PATCH DELETE', () => import('@/app/api/orchestrator/composer-queue/route')),
    route('/api/panel/ws-info', 'GET', () => import('@/app/api/panel/ws-info/route')),
    route('/api/panel/ports', 'GET', () => import('@/app/api/panel/ports/route')),
    route('/api/orchestrator/handoff', 'POST', () => import('@/app/api/orchestrator/handoff/route')),
    route('/api/orchestrator/reset-session', 'POST', () => import('@/app/api/orchestrator/reset-session/route')),
    route('/api/orchestrator/compact', 'POST', () => import('@/app/api/orchestrator/compact/route')),
    route('/api/orchestrator/session-rules', 'GET POST DELETE', () => import('@/app/api/orchestrator/session-rules/route')),
    route('/api/orchestrator/delegate', 'POST', () => import('@/app/api/orchestrator/delegate/route')),
    route('/api/next/voice-host', 'GET POST', () => import('@/app/api/next/voice-host/route')),
    route('/api/orchestrator/stop-packet', 'POST', () => import('@/app/api/orchestrator/stop-packet/route')),
    // Operator-only (requirePanelAuth, then the bearer principal); like stop-packet
    // they run the dispatch tick here. The agent supervisor's watch map is still
    // per process: a hard blocker for turning Rust mode on by default (#5576).
    route('/api/orchestrator/rerun-with-feedback', 'POST', () => import('@/app/api/orchestrator/rerun-with-feedback/route')),
    route('/api/orchestrator/reset-packet', 'POST', () => import('@/app/api/orchestrator/reset-packet/route')),
    route('/api/orchestrator/spawn-prompt', 'POST', () => import('@/app/api/orchestrator/spawn-prompt/route')),
    route('/api/runtime/action', 'POST', () => import('@/app/api/runtime/action/route')),
    // Loads the handler, not the Next route: Next forwards here while this
    // transport is on, so the edge-tts installer has one owner (#5422).
    route('/api/tts', 'POST', () => import('@/lib/tts/route')),
    // Symon's connected MCP tools: the handlers, not the Next routes, so the MCP
    // sessions and their child processes have one owner while this transport is
    // on (#5422). Operator only (the handler refuses a worker with 403).
    route('/api/symon/mcp/tools', 'GET', () => import('@/lib/mcp/symon-mcp-tools-route')),
    route('/api/symon/mcp/call', 'POST', () => import('@/lib/mcp/symon-mcp-call-route')),
    // Symon Agent-Mode tool relay (an already-confirmed SSH-transported tool invoked on the
    // remote webview). POST only, operator-ws-token-only TWICE over: the handler's
    // transportAuthorized does a constant-time timingSafeEqual(bearer, getOrCreateWsToken())
    // -> 401 for anything but the exact ws-token, and the path is in no middleware allowlist,
    // so over native (x-o8-client-addr=unverified-proxy) the panelGateMiddleware floor already
    // admits only the operator ws-token (worker/device 403, anon 401). sessionId/callId/tool/args
    // from the body reach the webview eval (buildTransportedToolEval) ONLY through JSON.stringify
    // -> they are JS data literals, never interpolated as code, so a ws-token holder cannot inject
    // JS. The response is the tool result, no credential. (#5243)
    route('/api/symon/transport/tool', 'POST', () => import('@/app/api/symon/transport/tool/route')),
  ],
  brain: [
    route('/api/cortex/ask', 'POST', () => import('@/app/api/cortex/ask/route')),
    // The MCP-callable JSON Q&A sibling (cortex_ask tool + the `o8 ask` worker CLI).
    // middleware.ts admits three principals here: a valid brain-read-worker bearer
    // (self-allowlisted inside the isBrainReadWorkerBearer block), a local worker
    // token (WORKER_CAPABILITIES), and the operator ws-token. Over native: anonymous
    // 401 and enrolled device 403 at the middleware; a brain-read worker is scoped by
    // the handler to its signed repo/project (a cross-project or packet-addressed read
    // is refused before retrieval); a worker reaches the Brain only for its own packet
    // (workerPacketRefusal refuses any other, including a legacy unbound worker). No
    // unauthenticated caller reaches askCortex.
    route('/api/cortex/ask/answer', 'POST', () => import('@/app/api/cortex/ask/answer/route')),
  ],
  activity: [
    route('/api/panel/commits/[hash]', 'GET', () => import('@/app/api/panel/commits/[hash]/route')),
    route('/api/review/workspace', 'GET', () => import('@/app/api/review/workspace/route')),
    route('/api/cortex/proposals', 'GET POST', () => import('@/app/api/cortex/proposals/route')),
    route('/api/cortex/cross-repo-proposals', 'GET', () => import('@/app/api/cortex/cross-repo-proposals/route')),
    route('/api/panel/problem-dossiers', 'GET', () => import('@/app/api/panel/problem-dossiers/route')),
    route('/api/panel/commits', 'GET', () => import('@/app/api/panel/commits/route')),
    route('/api/panel/ci', 'GET', () => import('@/app/api/panel/ci/route')),
    route('/api/panel/ci/[id]', 'GET', () => import('@/app/api/panel/ci/[id]/route')),
    route('/api/panel/pr', 'GET', () => import('@/app/api/panel/pr/route')),
    // The o8 MCP server's packet receipts, worker corrections and PR stack:
    // operator-only (none is on a device, worker or spectator list; receipts and
    // corrections also require the operator principal). Receipts and corrections
    // live in SQLite; corrections steer through the native runtime action; the
    // stack reads GitHub through the same broker as /api/panel/pr.
    route('/api/orchestrator/receipts', 'GET POST', () => import('@/app/api/orchestrator/receipts/route')),
    route('/api/orchestrator/worker-corrections', 'GET POST', () => import('@/app/api/orchestrator/worker-corrections/route')),
    route('/api/panel/pr-stack', 'GET', () => import('@/app/api/panel/pr-stack/route')),
    route('/api/orchestrator/stop-mission', 'POST', () => import('@/app/api/orchestrator/stop-mission/route')),
    route('/api/orchestrator/discard-packet', 'POST', () => import('@/app/api/orchestrator/discard-packet/route')),
    // The operator MCP `digest` tool. In no middleware allowlist and the handler requires the
    // ws-token (requirePanelAuth), so over native only the operator reaches it. The read-only
    // Codex exec's environment carries no provider API keys (codex is not an API-credential runtime)
    // and no ws-token, but its sandbox can still read files on disk, so the digest stays operator-only;
    // the repoPath must be registered.
    route('/api/orchestrator/digest', 'POST', () => import('@/app/api/orchestrator/digest/route')),
    // The operator MCP `o8_targets` tool and the Targets panel. GET with no handler-level auth, in no
    // middleware allowlist, so over native only the operator ws-token passes; the triage spends the
    // cheap model (rationale prompts carry paths and counts only) and caches scores. A ?mode=start
    // scan lives in this process's job map, so the listener that started it answers its jobId polls.
    route('/api/panel/targets', 'GET', () => import('@/app/api/panel/targets/route')),
  ],
  pull_requests: [
    route('/api/panel/file-diff', 'GET', () => import('@/app/api/panel/file-diff/route')),
    route('/api/panel/status', 'GET', () => import('@/app/api/panel/status/route')),
    route('/api/panel/prs', 'GET', () => import('@/app/api/panel/prs/route')),
    route('/api/panel/prs/[number]', 'GET POST', () => import('@/app/api/panel/prs/[number]/route')),
    route('/api/panel/prs/[number]/timeline', 'GET', () => import('@/app/api/panel/prs/[number]/timeline/route')),
    route('/api/panel/github-status', 'GET', () => import('@/app/api/panel/github-status/route')),
    route('/api/orchestrator/merge-preview', 'GET', () => import('@/app/api/orchestrator/merge-preview/route')),
    route('/api/orchestrator/comparison-pick', 'POST', () => import('@/app/api/orchestrator/comparison-pick/route')),
  ],
  bots: [
    route('/api/bots', 'GET', () => import('@/app/api/bots/route')),
    route('/api/bots/[id]/thread', 'GET', () => import('@/app/api/bots/[id]/thread/route')),
    // Operator MCP host (the bots surface's mcp_url points here, surfaces/bots/client.rs). POST runs
    // the operator MCP tools over JSON-RPC; DELETE terminates a session (204); GET is 405. No
    // handler-level auth — gated by panelGateMiddleware, and /api/mcp is in no allowlist, so over
    // native (x-o8-client-addr=unverified-proxy) it is operator-ws-token-only. The device-context
    // elevation (x-o8-device-worker/conversation/pid) is honored ONLY when the principal is already
    // operator (route.ts: resolveRequestPrincipalContext(request).role === 'operator'), so a device
    // or worker bearer cannot forge it. Responses are operator-visible MCP tool results. (#5243)
    route('/api/mcp', 'POST DELETE', () => import('@/app/api/mcp/route')),
  ],
  grid: [],
  shortcuts: [], // Local shortcut reference has no HTTP transport.
  terminal: [route('/api/mobile/terminal-sessions', 'GET', () => import('@/app/api/mobile/terminal-sessions/route'))],
  scheduled: [
    route('/api/automations', 'GET POST', () => import('@/app/api/automations/route')),
    route('/api/automations/[id]', 'PATCH DELETE', () => import('@/app/api/automations/[id]/route')),
    route('/api/automations/[id]/run', 'POST', () => import('@/app/api/automations/[id]/run/route')),
    route('/api/automations/connected', 'GET POST PATCH', () => import('@/app/api/automations/connected/route')),
    route('/api/panel/repos', 'GET', () => import('@/app/api/panel/repos/route')),
  ],
  usage: [
    route('/api/runtime/capacity', 'GET', () => import('@/app/api/runtime/capacity/route')),
    route('/api/runtime/usage', 'GET', () => import('@/app/api/runtime/usage/route')),
  ],
  palette: [], // Local commands and workspace navigation reuse the selected surface's transport.
  sidebar: [
    route('/api/runtime/discovered-sessions', 'GET', () => import('@/app/api/runtime/discovered-sessions/route')),
    route('/api/runtime/discovered-sessions/import', 'POST', () => import('@/app/api/runtime/discovered-sessions/import/route')),
    route('/api/runtime/capacity', 'GET', () => import('@/app/api/runtime/capacity/route')),
    route('/api/mobile/orchestrator/threads', 'GET', () => import('@/app/api/mobile/orchestrator/threads/route')),
    route('/api/orchestrator/state', 'GET', () => import('@/app/api/orchestrator/state/route')),
    route('/api/orchestrator/packet-transcript', 'GET', () => import('@/app/api/orchestrator/packet-transcript/route')),
    route('/api/runtime/inventory', 'GET', () => import('@/app/api/runtime/inventory/route')),
    route('/api/v2/chat-history/list', 'GET', () => import('@/app/api/v2/chat-history/list/route')),
    route('/api/v2/chat-history', 'GET POST PATCH', () => import('@/app/api/v2/chat-history/route')),
    route('/api/runtime/archive', 'POST', () => import('@/app/api/runtime/archive/route')),
    route('/api/orchestrator/workspace', 'POST', () => import('@/app/api/orchestrator/workspace/route')),
    // The rail's account photo (profile_menu.rs). The handler admits only the operator principal from the
    // bearer, never x-o8-client-addr or loopback. It reads the active identity file and the users row, then
    // fetches only an https URL on the two known photo hosts, with redirects refused and a 5 s deadline. It
    // refuses a declared length over 2 MiB and stops reading at 2 MiB; anything else is a 204 (#5243).
    route('/api/panel/account/avatar', 'GET', () => import('@/app/api/panel/account/avatar/route')),
  ],
  workers: [
    // POST is the lane command dispatcher (stop, archive, create_pr, merge, ...) that o8 next's
    // Activity pane and agent roster send. The gate grants workers GET only on this path, so a
    // POST needs the operator bearer whatever the caller's address. Lane state is SQLite and the
    // control-plane lock, and the WS process already runs these commands through
    // orchestrator/delegate. (#5576)
    route('/api/lanes', 'GET POST', () => import('@/app/api/lanes/route')),
    route('/api/lanes/[id]', 'GET', () => import('@/app/api/lanes/[id]/route')),
    route('/api/orchestrator/state', 'GET', () => import('@/app/api/orchestrator/state/route')),
    route('/api/orchestrator/lane-events', 'GET', () => import('@/app/api/orchestrator/lane-events/route')),
    route('/api/orchestrator/steer-packet', 'POST', () => import('@/app/api/orchestrator/steer-packet/route')),
    // Shared agent controls (the desktop agent bridge's start/stop/approve/… actions on a
    // runtime, session or surface). POST only, operator-only twice over: the path is in no
    // middleware allowlist, so over native (x-o8-client-addr forced to unverified-proxy,
    // non-loopback) the panelGateMiddleware floor already admits only the operator ws-token
    // — a worker or device bearer 403s, no/invalid bearer 401s — and the handler then calls
    // authorize(resolveRequestPrincipal(req)) which returns operator->pass, worker/device->403,
    // else 401 (principal from the bearer, never the client address). The response is a control
    // receipt with no credential. (#5243)
    route('/api/agent-control/action', 'POST', () => import('@/app/api/agent-control/action/route')),
  ],
  settings: [
    // Paired-device list (Settings > Paired devices). GET only: operator-gated by principal
    // (not client-addr), a pure SELECT with no write, and the body carries no token or hash (#5243).
    route('/api/mobile/devices', 'GET', () => import('@/app/api/mobile/devices/route')),
    // Paired-device revoke (Settings > Paired devices). POST only, and operator-only twice over:
    // the handler returns 403 unless resolveRequestPrincipal(req) === 'operator' (principal from the
    // bearer, never x-o8-client-addr), and the path is in no middleware allowlist, so over native
    // (x-o8-client-addr forced to unverified-proxy, non-loopback) the gate already admits only the
    // operator ws-token. A device/worker bearer gets 403; no/wrong bearer gets 401. The write marks
    // the device revoked + rewrites the active-token-hash file; the response carries no token. (#5243)
    route('/api/mobile/devices/revoke', 'POST', () => import('@/app/api/mobile/devices/revoke/route')),
    // Connect-attach toggle (Settings > Paired devices). GET reads the setting, POST writes it
    // (env-override locked). No handler-level auth — same panelGateMiddleware operator gate as the
    // rest of /api/panel/* (not allowlisted), so over native (x-o8-client-addr=unverified-proxy,
    // non-loopback) both the read and the write are operator-ws-token-only, equal-or-stricter than
    // Next. The POST body carries only a boolean; no credential in the response. (#5243)
    route('/api/panel/connect/attach', 'GET POST', () => import('@/app/api/panel/connect/attach/route')),
    // Mobile pairing config (Settings > Paired devices QR). GET only. No handler-level auth beyond the
    // panelGateMiddleware operator gate PLUS a device-GET capability (DEVICE_CAPABILITIES), so over
    // native an operator OR an enrolled-device bearer passes; everything else 401. The handler is
    // fail-closed via resolveRequestPrincipal: a device gets host/port refresh with token:'' and NEVER
    // the operator ws-token (the ws-token only goes to operator/loopback). Principal comes from the
    // bearer, not x-o8-client-addr, so the device-vs-operator split holds over the native transport. (#5243)
    route('/api/panel/mobile-pairing', 'GET', () => import('@/app/api/panel/mobile-pairing/route')),
    // Machine connect/disconnect (Settings > Paired devices). GET lists machines, POST registers this
    // machine, DELETE deregisters it + writes attach-off locally. No handler-level auth beyond the
    // panelGateMiddleware operator gate — /api/panel/connect is in no allowlist/capability list, so over
    // native (x-o8-client-addr=unverified-proxy, non-loopback) all three verbs are operator-ws-token-only,
    // equal-or-stricter than Next (which also trusts loopback). The handler reads x-clerk-session-token
    // (or the cached license key) only as the UPSTREAM license-server credential for the registry call,
    // after the gate has already passed — it is not an auth bypass; the header survives because the native
    // transport forwards it, and the registry call is outbound HTTPS, Next-independent. No token in the
    // response body (machine ids and device list only). (#5243)
    route('/api/panel/connect', 'GET POST DELETE', () => import('@/app/api/panel/connect/route')),
    // Provider instances (Settings > Providers). GET+POST, gated by requirePanelAuth:
    // over the native transport (x-o8-client-addr=unverified-proxy, non-loopback) it
    // falls through to the ws-token bearer check, so it is operator-ws-token-only here —
    // equal-or-stricter than Next. The GET inventory masks secret values (secrets live
    // encrypted in a separate credentials table); the POST writes go through
    // withProviderStoreLock + master-key encryption. (#5243)
    route('/api/runtime/provider-instances', 'GET POST', () => import('@/app/api/runtime/provider-instances/route')),
    // Desktop shell reads (src-tauri o8_http). No device/worker/spectator grant in panelGateMiddleware, so only
    // the operator bearer passes. cli-usage reads the CLI usage files under this process's HOME and has no
    // handler auth. broadcast/why and broadcast/calendar check the principal from the bearer
    // (resolveRequestPrincipalContext), never x-o8-client-addr or loopback, so they behave as on Next. Both read
    // and write SQLite only, and calendar ingest reads operator defaults from disk on every call. (#5422)
    route('/api/panel/cli-usage', 'GET', () => import('@/app/api/panel/cli-usage/route')),
    route('/api/broadcast/why', 'GET', () => import('@/app/api/broadcast/why/route')),
    // Symon's commentary reader (lib/broadcast/speaker.ts) and broadcast spectators. GET only. The
    // middleware admits the operator ws-token and an active spectator token (SPECTATOR_CAPABILITIES,
    // GET/HEAD), and requireBroadcastReader re-checks the principal from the bearer, never the client
    // address. Spectators read the whole commentary feed by design (repo grants scope only truth); actor
    // and text go through the broadcast projection's read-time redaction, the same as on Next.
    route('/api/broadcast/commentary', 'GET', () => import('@/app/api/broadcast/commentary/route')),
    route('/api/broadcast/calendar', 'POST', () => import('@/app/api/broadcast/calendar/route')),
    // Operator-principal writes (resolveRequestPrincipal / handleBroadcastSay refuse any other role), never
    // x-o8-client-addr or loopback. Both store in SQLite; pull-request-context reads conversations from disk
    // and its refresh=1 / refresh=missing reads call the GitHub broker's single-PR sync (ensureGitHubPullRequest),
    // which shares its token and request-budget caches with the open-PR sync the native /api/panel/prs uses. (#5422)
    route('/api/orchestrator/pull-request-context', 'GET POST DELETE', () => import('@/app/api/orchestrator/pull-request-context/route')),
    route('/api/broadcast/say', 'POST', () => import('@/app/api/broadcast/say/route')),
    // Symon watches (src-tauri symon_watch.rs). No device/worker/spectator grant in panelGateMiddleware, so only the
    // operator bearer passes, and the handlers add no loopback or principal check of their own. Watches are rows
    // in SQLite: the automation scheduler in the WS process fires them from the same rows, and a plan claim is decided by an
    // UPDATE, so either process may register, claim, settle or cancel. (#5422)
    route('/api/symon/watches', 'GET POST', () => import('@/app/api/symon/watches/route')),
    route('/api/symon/watches/[id]', 'GET PATCH DELETE', () => import('@/app/api/symon/watches/[id]/route')),
    // o8 team presence, messages and tell for Symon: operator-only through the
    // middleware (none is on a device, worker or loopback list), principal from the
    // bearer. They read and append the files under each registered repo's
    // .git/agents; no process state beyond the repo registry's short read cache.
    route('/api/team/presence', 'GET', () => import('@/app/api/team/presence/route')),
    route('/api/team/messages', 'GET', () => import('@/app/api/team/messages/route')),
    route('/api/team/tell', 'POST', () => import('@/app/api/team/tell/route')),
    // The updater kill switch: operator-only through the middleware, principal from
    // the bearer. A stateless fetch of the fixed release-health manifest that fails
    // open on any error.
    route('/api/panel/release-health', 'GET', () => import('@/app/api/panel/release-health/route')),
    // Model picker catalogue (orchestrator backend models). GET only, gated twice: panelGateMiddleware gives it
    // no device/worker/spectator grant, so only the operator bearer passes; requirePanelAuth then trusts
    // loopback via x-o8-client-addr, which the native transport stamps unverified-proxy, so here it falls
    // through to the same ws-token bearer check — equal-or-stricter than Next. resolveOpenRouterKey() stays
    // in-process and only primes the model probe; the agent's output is redacted before it reaches the body
    // (tests/o8d-backend-models-native-real-path.test.ts). The OpenRouter metadata cache is per process and
    // the probe cache is on disk, so neither needs a single owner. (#5243)
    route('/api/orchestrator/backend-models', 'GET', () => import('@/app/api/orchestrator/backend-models/route')),
    // MCP config generator (Settings > MCP). GET only, no handler-level auth: gated by
    // panelGateMiddleware, which does not public-allowlist /api/setup/* (hardening #1562).
    // Over the native transport (x-o8-client-addr=unverified-proxy, non-loopback) the loopback
    // branch fails, so it is operator-ws-token-only here — equal-or-stricter than Next. The GET
    // body embeds the operator WS_TOKEN (build.ts getOrCreateWsToken); that is not a leak because
    // the gate only ever lets the body reach a caller already holding that same operator token,
    // and the real-path forged-local-header negative pins that a non-operator cannot extract it. (#5243)
    route('/api/setup/mcp-config', 'GET', () => import('@/app/api/setup/mcp-config/route')),
    // Claude Desktop / Claude Code auto-register (Settings > MCP). GET previews the Claude config
    // (other servers by name only; the o8 entry carries the operator's own WS_TOKEN); POST merges the
    // o8 + codebase-memory entries into the user's config file. No handler-level auth — same
    // panelGateMiddleware gate as the other /api/setup/* routes (not public-allowlisted, hardening
    // #1562), so over native (x-o8-client-addr=unverified-proxy) both the preview and the config-file
    // WRITE are operator-ws-token-only — equal-or-stricter than Next. (#5243)
    route('/api/setup/claude-desktop', 'GET POST', () => import('@/app/api/setup/claude-desktop/route')),
    // External MCP client auto-register for Hermes/OpenClaw (Settings > MCP). GET probes whether the
    // CLI is installed + o8 registered (read-only `command -v`); POST shells out to the CLI to install
    // or remove the o8 server. No handler-level auth — same panelGateMiddleware gate as the other
    // /api/setup/* routes (hardening #1562), so over native the probe and the CLI spawn are
    // operator-ws-token-only. The CLI is spawned via execFile/cliInvocation arg arrays (no shell
    // string); its args come from the o8 registry projection, not request input (only `target` is,
    // normalized to hermes|openclaw) — so a non-operator cannot reach or steer the spawn. (#5243)
    route('/api/setup/external-client', 'GET POST', () => import('@/app/api/setup/external-client/route')),
    route('/api/cortex/codebase-memory', 'GET', () => import('@/app/api/cortex/codebase-memory/route')),
    route('/api/cortex/diagnostics', 'GET', () => import('@/app/api/cortex/diagnostics/route')),
    route('/api/runtime/acp-registry', 'GET', () => import('@/app/api/runtime/acp-registry/route')),
    route('/api/panel/o8-update-summary', 'GET', () => import('@/app/api/panel/o8-update-summary/route')),
    // Updater state has one owner: these load the handlers, not the Next routes,
    // and Next forwards them here while this transport is on (#5422).
    route('/api/panel/update/apply', 'GET POST', () => import('@/lib/app-update/routes/apply')),
    route('/api/panel/app/update-state', 'GET POST', () => import('@/lib/app-update/routes/update-state')),
    route('/api/panel/app/relaunch', 'POST', () => import('@/lib/app-update/routes/relaunch')),
    // The shell's restart drain (restart_job_drain.rs). No device/worker/spectator grant, so only the operator
    // bearer passes over native, and the handler reads no client address. Drain state is SQLite keyed by the
    // app's O8_BOOT_ID, which the shell gives both processes; the native module refuses (503) without it,
    // because a drain under a per-process boot id is deleted by Next's next cloud claim (#5243).
    route('/api/panel/cloud-jobs/drain', 'GET POST', () => import('@/lib/cloud/drain-native-route')),
    route('/api/panel/status', 'GET', () => import('@/app/api/panel/status/route')),
    route('/api/runtime/capabilities', 'GET', () => import('@/app/api/runtime/capabilities/route')),
    route('/api/worktrees/retention-usage', 'GET', () => import('@/app/api/worktrees/retention-usage/route')),
    route('/api/runtime/capacity', 'GET', () => import('@/app/api/runtime/capacity/route')),
    route('/api/setup/cli-updates', 'GET', () => import('@/app/api/setup/cli-updates/route')),
    route('/api/panel/operator-defaults', 'GET POST', () => import('@/app/api/panel/operator-defaults/route')),
    route('/api/v2/keys', 'GET POST PATCH DELETE', () => import('@/app/api/v2/keys/route')),
    route('/api/cortex/reingest', 'POST', () => import('@/app/api/cortex/reingest/route')),
  ],
  setup: [
    route('/api/setup/cli-updates', 'GET', () => import('@/app/api/setup/cli-updates/route')),
    route('/api/setup/config', 'GET POST', () => import('@/app/api/setup/config/route')),
    // The o8 MCP server's operator status and agent setup: operator-only through the
    // middleware (no device, worker or spectator grant). Status reads SQLite and the
    // runtime inventory cache /api/runtime/inventory already shares here; setup composes
    // the native operator-defaults, setup/config and repos handlers. (#5422)
    route('/api/operator/status', 'GET', () => import('@/app/api/operator/status/route')),
    route('/api/setup/agent', 'GET POST', () => import('@/app/api/setup/agent/route')),
    // Setup-wizard tool detection. GET has no handler-level auth — same panelGateMiddleware gate as
    // the other /api/setup/* routes (not public-allowlisted, hardening #1562), so over native
    // (x-o8-client-addr=unverified-proxy) it is operator-ws-token-only. It reads provider credentials
    // (process.env + .env.local) and probes CLIs, but only to derive boolean presence: the response
    // carries key/provider NAMES, counts, paths, versions and static hints — never a secret VALUE
    // (verified; a real-path test asserts seeded key values never appear in the body). The CLI
    // version probes and symlink repair run as an operator side effect, no request input steers them.
    route('/api/setup/detect', 'GET', () => import('@/app/api/setup/detect/route')),
  ],
  projects: [
    // POST is the MCP server's project create (o8_create_project). No device or worker grant in
    // panelGateMiddleware, so over native only the operator bearer passes; the handler has no auth of its
    // own and never reads x-o8-client-addr or loopback. It writes the SQLite project and the projects ledger,
    // then publishes the repo-inventory change to /internal/realtime, like the repos POST (#5243).
    route('/api/panel/projects', 'GET POST', () => import('@/app/api/panel/projects/route')),
    route('/api/panel/projects/active', 'POST', () => import('@/app/api/panel/projects/active/route')),
    route('/api/panel/projects/[id]', 'PATCH DELETE', () => import('@/app/api/panel/projects/[id]/route')),
    route('/api/panel/repos', 'GET POST DELETE', () => import('@/app/api/panel/repos/route')),
    route('/api/panel/repos/init', 'POST', () => import('@/app/api/panel/repos/init/route')),
    route('/api/panel/repos/scaffold', 'POST', () => import('@/app/api/panel/repos/scaffold/route')),
    route('/api/projects', 'GET POST', () => import('@/app/api/projects/route')),
    route('/api/projects/[id]', 'PATCH DELETE', () => import('@/app/api/projects/[id]/route')),
    route('/api/projects/[id]/repos', 'POST', () => import('@/app/api/projects/[id]/repos/route')),
    route('/api/projects/[id]/repos/[repoId]', 'PATCH DELETE', () => import('@/app/api/projects/[id]/repos/[repoId]/route')),
  ],
  issues: [
    route('/api/panel/issues', 'GET', () => import('@/app/api/panel/issues/route')),
    route('/api/panel/issues/create', 'POST', () => import('@/app/api/panel/issues/create/route')),
    route('/api/panel/issues/enhance', 'POST', () => import('@/app/api/panel/issues/enhance/route')),
    route('/api/panel/issues/[number]', 'GET', () => import('@/app/api/panel/issues/[number]/route')),
  ],
  inbox: [
    route('/api/panel/supervisor-inbox', 'GET', () => import('@/app/api/panel/supervisor-inbox/route')),
    route('/api/panel/approvals', 'GET POST', () => import('@/app/api/panel/approvals/route')),
  ],
  diff: [
    route('/api/panel/commits/[hash]', 'GET', () => import('@/app/api/panel/commits/[hash]/route')),
    route('/api/orchestrator/review-state', 'GET', () => import('@/app/api/orchestrator/review-state/route')),
    route('/api/orchestrator/review', 'POST', () => import('@/app/api/orchestrator/review/route')),
    route('/api/lanes/[id]/diff', 'GET', () => import('@/app/api/lanes/[id]/diff/route')),
    route('/api/worktrees/diff', 'GET', () => import('@/app/api/worktrees/diff/route')),
    route('/api/review/last-turn', 'GET', () => import('@/app/api/review/last-turn/route')),
    route('/api/review/commit', 'POST', () => import('@/app/api/review/commit/route')),
  ],
  customize: [
    route('/api/customize/inventory', 'GET', () => import('@/app/api/customize/inventory/route')),
    route('/api/customize/actions', 'GET POST', () => import('@/app/api/customize/actions/route')),
    route('/api/cortex/directives', 'GET', () => import('@/app/api/cortex/directives/route')),
    route('/api/setup/mcp-servers', 'GET', () => import('@/app/api/setup/mcp-servers/route')),
    route('/api/prompt-library', 'GET POST', () => import('@/app/api/prompt-library/route')),
    route('/api/prompt-library/[id]', 'GET PATCH DELETE', () => import('@/app/api/prompt-library/[id]/route')),
  ],
};

// Authoritative producers requested by the existing WS checkpoint/command path.
const producers = [
  route('/api/panel/status', 'GET', () => import('@/app/api/panel/status/route')),
  route('/api/setup/identity', 'GET', () => import('@/app/api/setup/identity/route')),
  route('/api/mobile/sync', 'POST', () => import('@/app/api/mobile/sync/route')),
  route('/api/mobile/inbox', 'GET', () => import('@/app/api/mobile/inbox/route')),
  route('/api/command-center/snapshot', 'GET', () => import('@/app/api/command-center/snapshot/route')),
  route('/api/browser/inventory', 'GET', () => import('@/app/api/browser/inventory/route')),
  // Browser-automation verbs (canvas browser card / Browser tab). POST only, in
  // WORKER_CAPABILITIES so the operator ws-token OR a packet-worker token passes
  // panelGateMiddleware; the handler then calls workerPacketRefusal, scoping a
  // worker to its own packetId (operator acts as scope 'operator'). Device,
  // spectator and anonymous are refused at the middleware. The verb is validated
  // against the fixed VERBS set and args are JSON-encoded into the webview eval,
  // so a scoped caller cannot inject JS. Same gate over native as on Next.
  route('/api/browser/agent', 'POST', () => import('@/app/api/browser/agent/route')),
  route('/api/runtime/transcript', 'GET', () => import('@/app/api/runtime/transcript/route')),
  route('/api/runtime/launch', 'POST', () => import('@/app/api/runtime/launch/route')),
  route('/api/orchestrator/headless-tick', 'POST', () => import('@/app/api/orchestrator/headless-tick/route')),
  route('/api/review/auto-review', 'POST', () => import('@/app/api/review/auto-review/route')),
];
const routes = [...Object.values(nativeSurfaceRoutes).flat(), ...producers, ...viewerHttpRoutes];
function parameters(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index++) {
    const key = expected[index].match(/^\[(\w+)\]$/)?.[1];
    if (key && actual[index]) params[key] = decodeURIComponent(actual[index]);
    else if (expected[index] !== actual[index]) return null;
  }
  return params;
}

export function matchNativeHttpRoute(pathname: string, method?: string) {
  const matches = routes.map(route => ({ route, params: parameters(route.path, pathname) })).filter(entry => entry.params !== null);
  // Surfaces can share a path with different methods, so match on both.
  return method === undefined ? matches[0] : matches.find(entry => entry.route.methods.includes(method));
}
