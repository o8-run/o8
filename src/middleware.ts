/**
 * Global API auth middleware.
 *
 * Gates the dangerous local-only API surface (panel, orchestrator, directives,
 * cortex, runtime, lanes, worktrees, review) on loopback origin + bearer token.
 *
 * This runs before any route handler, so we don't have to thread
 * `requirePanelAuth` through every route file.
 *
 * Security posture:
 *   - Every stateful or sensitive API request needs an affirmative principal,
 *     including requests that originate on loopback.
 *   - The operator bearer matches the actual ws-token on disk. Worker and
 *     paired-device bearers are restricted to explicit capability lists.
 *   - A few read-only iframe resources may use socket-truth loopback because
 *     iframe navigation cannot attach an Authorization header.
 *   - Without this, any LAN device could reach the Next dev/prod server and
 *     dispatch Codex, approve merges, etc. (See audit 2026-04-09.)
 *
 * Read routes (GET /api/panel/status etc.) are still gated. If you need a
 * public read endpoint, add it to ALLOWLIST_PATHS below.
 */

import type { NextFetchEvent, NextMiddleware } from 'next/server';
import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  O8_CLIENT_ADDR_HEADER,
  hostHeaderToHostname,
  isLoopbackAddress,
  isLoopbackHostname,
  isTauriShellOrigin,
} from '@/lib/auth/loopback-request';
import { getDataDir, migrateDataDirOnce } from '@/lib/data-dir-migration';
// DB-free reader of the registry's derived active-token-hash file (#5). Importing
// this does NOT pull better-sqlite3 into the middleware bundle — it is pure fs.
import { readActiveTokenHashes } from '@/lib/mobile/device-token-file';
import { isLocalWorkerToken } from '@/lib/auth/worker-token';
import { isBrainReadWorkerBearer, resolveBrainReadWorkerToken } from '@/lib/auth/brain-read-worker-token';
import { readActiveSpectatorTokenHashes } from '@/lib/broadcast/spectator-token-file';
import { O8_BROADCAST_SURFACE_HEADER } from '@/lib/broadcast/surface';
import { resolvePluginToken } from '@/lib/auth/plugin-token';
import { browserWriteAllowed, isAllowedLocalHost } from '../scripts/lib/http-request-boundary.cjs';

migrateDataDirOnce();

// Middleware must run in Node runtime to read the ws-token file.
export const config = {
  matcher: ['/:path*'],
  runtime: 'nodejs',
};

// ── Token loader (cached, refreshed on mtime change) ──

let _cachedToken: { value: string; mtimeMs: number; size: number } | null = null;

function loadPanelToken(): string | null {
  try {
    const dataDir = getDataDir();
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) return null;

    // Cheap stat check to avoid re-reading every request. mtime alone has
    // ~1s resolution on some filesystems — include size so a same-tick token
    // rewrite can't keep validating against the stale value.
    const stat = statSync(tokenPath);
    if (_cachedToken && _cachedToken.mtimeMs === stat.mtimeMs && _cachedToken.size === stat.size) {
      return _cachedToken.value;
    }

    const raw = readFileSync(tokenPath, 'utf-8').trim();
    if (!raw) return null;
    _cachedToken = { value: raw, mtimeMs: stat.mtimeMs, size: stat.size };
    return raw;
  } catch {
    return null;
  }
}

/**
 * Paths that are allowed to pass through the middleware without auth.
 * Keep this list MINIMAL. These must be safe to expose unauthenticated.
 *
 * NOTE: `/api/setup/*` is NOT allowlisted (hardening #1562) — setup GETs
 * expose machine configuration and stay behind the operator bearer. The one
 * setup endpoint the pre-app boot page needs (`/api/setup/identity`) passes
 * via LOOPBACK_READ_CAPABILITIES below, never from LAN.
 */
const ALLOWLIST_READ_ONLY: RegExp[] = [
  // Health check for the Tauri shell to know the bundled server is up.
  /^\/api\/panel\/status(\/|$)/,
  // Session inspection authenticates with the o8-token cookie in its handler.
  /^\/api\/v2\/auth\/session\/?$/,
  // VAPID public key — public by definition; the mobile client needs it
  // to call pushManager.subscribe before any token handshake.
  /^\/api\/mobile\/push\/public-key(\/|$)/,
  // A paired phone's bounded stale-port probe. The response is public port
  // metadata signed with the already pinned E2EE server identity; it exposes
  // no bearer, enrollment code, or other operator capability.
  /^\/api\/mobile\/pairing-discovery\/?$/,
  // Backend availability is non-sensitive setup state for mobile runtime tabs.
  /^\/api\/mobile\/orchestrator\/backend-availability(\/|$)/,
];

const ALLOWLIST_ANY_METHOD: RegExp[] = [
  // Logout authenticates and revokes the o8-token cookie in its handler.
  /^\/api\/v2\/auth\/logout\/?$/,
  // Mobile device enrollment (#5): an UNPAIRED phone has no bearer token yet, so
  // this bootstrap POST bypasses the bearer gate. It is NOT unauthenticated — the
  // handler requires a valid single-use enroll code (and the E2EE flag) before
  // minting a per-device token.
  /^\/api\/mobile\/enroll(\/|$)/,
];

const DEVICE_CAPABILITIES: Array<{ methods: ReadonlySet<string>; path: RegExp }> = [
  { methods: new Set(['GET']), path: /^\/api\/mobile\/conversation-pr-context\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/mobile\/ripple\/resolve\/?$/ },
  // Phone-facing routes only. Keep internal desktop/ws-server routes out of
  // this list: devices*, push-url, symon/tool, and ws-token all require the
  // operator credential. New mobile routes fail closed until named here.
  { methods: new Set(['GET', 'POST', 'PATCH', 'DELETE']), path: /^\/api\/mobile\/(?:action|activity|bootstrap|chat(?:\/send)?|diff-comment(?:s|\/resolve)?|enhance|genui\/stream|history|inbox|live-activity\/(?:register|sync)|media|orchestrator\/(?:backend-availability|openclaw-agents|openclaw-availability|packets|threads(?:\/[^/]+\/reveal|\/reveal)?)|push\/(?:public-key|subscribe|test)|review-file|search|session-media|symon(?:\/session|\/text-session)?|sync|terminal-input|terminal-sessions)\/?$/ },
  // A paired phone reads its own standing intents and clears one. Read + cancel
  // ONLY: registering a watch stays inside a Symon turn, where it raises a card,
  // and the tools' own surface (/api/symon/watches) keeps the operator bearer.
  { methods: new Set(['GET']), path: /^\/api\/mobile\/symon\/watches\/?$/ },
  { methods: new Set(['DELETE']), path: /^\/api\/mobile\/symon\/watches\/[^/]+\/?$/ },
  { methods: new Set(['GET', 'POST']), path: /^\/api\/panel\/approvals\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/panel\/(?:status|github-status|repos|operator-defaults|projects|search)\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/panel\/(?:operator-defaults|pr\/review)\/?$/ },
  { methods: new Set(['GET', 'POST', 'PATCH', 'DELETE']), path: /^\/api\/v2\/chat-history(?:\/list)?\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/v2\/repos\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/v2\/proxy\/(?:llm|cli)\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/runtime\/launch\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/worktrees\/merge\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/orchestrator\/reset-session\/?$/ },
  // Layer-3 steer from the phone. The relay connector forwards the per-device
  // bearer verbatim (stamping a NON-loopback client-addr), so the steer route is
  // gated per-principal, never loopback-trusted; its handler accepts operator +
  // device and still 403s a worker. Real-path coverage: tests/principal-authz.
  { methods: new Set(['POST']), path: /^\/api\/orchestrator\/steer-packet\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/orchestrator\/merge-preview\/?$/ },
  // Phone-facing surfaces reached OUTSIDE /api/mobile/* (the app grew into these
  // and each failed closed until named). All device-safe: repo o8.md notes (read
  // + autosave write), fleet runtime inventory, review diffs, dictation + TTS.
  // The repo-spec/asset srcPath (local-file) branch is separately blocked to
  // devices in its handler.
  { methods: new Set(['GET', 'PUT', 'POST']), path: /^\/api\/repo-spec\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/repo-spec\/asset\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/runtime\/inventory\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/worktrees\/(?:diff|diff-summary)\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/dictation\/(?:polish|transcribe)\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/tts\/?$/ },
  // Pairing refresh: an enrolled phone re-pulls host/port config when the
  // desktop's ports or relay change (#1529). The handler returns token:'' to a
  // device — the operator ws-token is NEVER handed to a device principal.
  { methods: new Set(['GET']), path: /^\/api\/panel\/mobile-pairing\/?$/ },
];

const WORKER_CAPABILITIES: Array<{ methods: ReadonlySet<string>; path: RegExp }> = [
  // Packet-bound device authority; this route exposes only the device tool profile.
  { methods: new Set(['POST']), path: /^\/api\/devices\/agent\/?$/ },
  // Display-only pages are checked against the worker's exact packet in every handler.
  { methods: new Set(['GET', 'POST']), path: /^\/api\/visualizations\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/visualizations\/vis-[0-9a-f-]+\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/visualizations\/preview\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/panel\/(?:approvals|problem-dossiers|status)\/?$/ },
  { methods: new Set(['GET', 'POST', 'DELETE']), path: /^\/api\/panel\/managed-runs\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/panel\/artifacts(?:\/mirror)?\/?$/ },
  // Agents can coordinate named resources but cannot bypass ownership checks in the handler.
  { methods: new Set(['GET', 'POST']), path: /^\/api\/leases\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/lanes(?:\/[^/]+(?:\/(?:scope|diff))?)?\/?$/ },
  // Scope expansion is the worker's bounded escape hatch. The handler binds
  // the bearer to the resolved lane packet before it mutates the allowlist.
  { methods: new Set(['POST']), path: /^\/api\/lanes\/[^/]+\/scope\/?$/ },
  { methods: new Set(['GET', 'POST']), path: /^\/api\/lanes\/[^/]+\/(?:events|heartbeat)\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/(?:browser\/agent|cortex\/ask\/answer)\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/cortex\/proposals\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/broadcast\/post\/?$/ },
  // A packet-bound worker reaches this only from a lane whose durable label
  // proves it was launched by the Automation scheduler. The handler rechecks
  // that provenance and deduplicates by packet; the shared speaker applies policy and the speech cap.
  { methods: new Set(['POST']), path: /^\/api\/broadcast\/automation-say\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/agents\/message\/?$/ },
  { methods: new Set(['GET']), path: /^\/api\/agents\/(?:inbox|presence)\/?$/ },
  { methods: new Set(['GET', 'POST', 'PATCH', 'DELETE']), path: /^\/api\/repo-spec(?:\/|$)/ },
  { methods: new Set(['GET']), path: /^\/api\/tasks(?:\/[^/]+)?\/?$/ },
  { methods: new Set(['POST']), path: /^\/api\/tasks\/[^/]+\/(?:report|block)\/?$/ },
  // Read-only admission is packet-bound again in the route handler.
  { methods: new Set(['GET']), path: /^\/api\/orchestrator\/merge-preview\/?$/ },
];

const SPECTATOR_CAPABILITIES: Array<{ methods: ReadonlySet<string>; path: RegExp }> = [
  { methods: new Set(['GET', 'HEAD']), path: /^\/api\/broadcast\/(?:commentary|events|snapshot)\/?$/ },
  { methods: new Set(['GET', 'HEAD']), path: /^\/api\/orchestrator\/truth\/?$/ },
];

const LOOPBACK_READ_CAPABILITIES: RegExp[] = [
  /^\/api\/browser\/proxy\/?$/,
  /^\/api\/browser\/engine\/view\/?$/,
  /^\/api\/panel\/proxy\/?$/,
  // Inline media in o8.md render as plain <img> tags, which CANNOT attach a
  // bearer — when the mobile-auth hardening removed blanket loopback trust,
  // every spec-panel image silently 401'd (regression found 2026-07-31). The
  // route itself is jailed: workspace must resolve through the registered-repo
  // scope, descriptor validation contains the opened file, and an image/pdf
  // extension allowlist bounds what it will ever serve. GET/HEAD only here.
  /^\/api\/panel\/file-asset\/?$/,
  // Boot-gate identity probe (v0.1.600 stuck-boot incident): the packaged
  // boot page is static HTML served by the Tauri shell — it CANNOT attach a
  // bearer, and it must confirm "this port is MY server" before navigating to
  // the app (its route even sets Access-Control-Allow-Origin:* for exactly
  // this cross-origin probe). GET/HEAD only via the gate below; LAN callers
  // still hit the default deny (socket truth in packaged, Host heuristics in
  // dev). Hardening #1562 removed the old blanket /api/setup/* allowlist and
  // this probe went down with it — every packaged boot then stalled on the
  // boot screen. Real-path tests: tests/middleware-gate.test.ts "boot-gate
  // identity probe".
  /^\/api\/setup\/identity\/?$/,
];

/**
 * Self-authenticating routes bypass the loopback/token gate because they are
 * reachable OFF-HOST by design and verify their own credential in the handler:
 *   /api/worker/*        — worker protocol, Bearer against the worker_tokens table.
 *   /api/cloud/*         — self-hosted worker pool, verifyCloudWorkerKey (#514).
 *   /api/github/webhook  — GitHub delivery, HMAC-SHA256 (github-broker/auth.ts).
 * EVERYTHING else under /api/* is DENIED by default (see the gate below) — there
 * is no fail-open "ungated family" any more. To expose a new route publicly, add
 * it to ALLOWLIST_READ_ONLY (GET) or, for a self-authenticating external caller,
 * here — never by omission. Full per-family rationale: docs/internals/loopback-api.md.
 */
const SELF_AUTH_PREFIXES = ['/api/worker/', '/api/cloud/', '/api/github/webhook'];

function isTrustedLocalRequest(req: NextRequest): boolean {
  // Tier 1 — socket truth. The bundled production server stamps the real TCP
  // peer address into x-o8-client-addr on EVERY request, overwriting anything
  // the client sent (see the server.js wrapper in scripts/tauri-export.mjs).
  // When present it is authoritative: every header below (Origin, Host,
  // sec-fetch-*) is client-controlled, so a direct LAN connection can spoof
  // them all. A known-remote socket can only be authorized by the bearer token.
  const clientAddr = req.headers.get(O8_CLIENT_ADDR_HEADER);
  if (clientAddr) {
    return isLoopbackAddress(clientAddr);
  }

  // Tier 2 — dev fallback (next dev / dev-bridge run Next's stock server,
  // which doesn't stamp the header). Best-effort heuristics; a deliberate
  // spoofer on the LAN can defeat these in dev, which is the accepted
  // trade-off for keeping curl/scripts/dev-browser friction-free.

  // Origin header (CORS-ish) — set by browsers, not by curl or same-origin fetches.
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if (isLoopbackHostname(url.hostname)) return true;
    } catch {
      // Malformed origin — fall through.
    }
    // Tauri webview boot-page origin: `tauri://localhost` on WebKit,
    // `http(s)://tauri.localhost` on WebView2 (Windows). Exact-match set —
    // never a `*.localhost` suffix rule (#1673 audit).
    // NOTE: `origin === req.nextUrl.origin` was deliberately REMOVED — a LAN
    // browser that loaded our page is same-origin too, which made the gate a
    // no-op for any phone/laptop on the network.
    if (isTauriShellOrigin(origin)) return true;
  }

  // sec-fetch-site from a browser is only meaningful when the page was served
  // to a loopback client — a LAN browser's fetches are same-origin as well,
  // and non-browser clients can fabricate the header. Require loopback Host.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (
    (fetchSite === 'same-origin' || fetchSite === 'none')
    && isLoopbackHostname(req.nextUrl.hostname)
  ) {
    return true;
  }

  // Direct fetches without a browser (curl, MCP server, Node scripts) won't
  // send origin or sec-fetch-*. Accept if the Host targets loopback.
  if (!origin && !fetchSite && isLoopbackHostname(req.nextUrl.hostname)) return true;

  // Also trust the host header matching loopback (some clients set only Host).
  const host = hostHeaderToHostname(req.headers.get('host'));
  if (!origin && !fetchSite && isLoopbackHostname(host)) return true;

  return false;
}

/**
 * Loopback-read routes pass on socket-truth loopback alone — but socket truth
 * only proves the TCP peer is on this host, NOT that the CALLER is trusted. A
 * malicious web page the user has open can `fetch('http://127.0.0.1:<port>/…')`;
 * that request rides a loopback socket, so socket truth stamps it loopback. For
 * /api/setup/identity (which sets Access-Control-Allow-Origin:* so the boot page
 * can read it cross-origin) that let any origin read the instance id / boot id /
 * ports (adversarial review 2026-07-15). Require the Origin, when present, to be
 * local: the real boot page is `tauri://localhost`, in-app pages are loopback,
 * and curl / same-origin navigations send no Origin at all. Only a genuine
 * cross-site page sends a non-local Origin — deny it.
 */
function readOriginIsLocalOrAbsent(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  // Shell boot-page origins: tauri://localhost (WebKit) or
  // http(s)://tauri.localhost (WebView2 on Windows) — exact-match set.
  if (isTauriShellOrigin(origin)) return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Constant-time token comparison (length leak is fine — tokens are fixed-size). */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Per-device token (#5): accept a bearer that sha256-hashes to an ACTIVE enrolled
 * device. The hash is a one-way function and the active set is read from the
 * registry's derived file (DB-free), so no constant-time compare is needed — a
 * revoked device drops out of the set the instant the registry rewrites it.
 */
function isActiveDeviceToken(presented: string): boolean {
  if (!presented) return false;
  const hash = createHash('sha256').update(presented, 'utf-8').digest('hex');
  return readActiveTokenHashes().has(hash);
}

function isActiveSpectatorToken(presented: string): boolean {
  if (!presented) return false;
  const hash = createHash('sha256').update(presented, 'utf-8').digest('hex');
  return readActiveSpectatorTokenHashes().has(hash);
}

function deviceMayAccess(pathname: string, method: string): boolean {
  return DEVICE_CAPABILITIES.some((capability) => (
    capability.methods.has(method) && capability.path.test(pathname)
  ));
}

function workerMayAccess(pathname: string, method: string): boolean {
  return WORKER_CAPABILITIES.some((capability) => (
    capability.methods.has(method) && capability.path.test(pathname)
  ));
}

function spectatorMayAccess(pathname: string, method: string): boolean {
  return SPECTATOR_CAPABILITIES.some((capability) => (
    capability.methods.has(method) && capability.path.test(pathname)
  ));
}

function isAllowlisted(pathname: string, method: string): boolean {
  // Any-method allowlist (OAuth handshakes).
  if (ALLOWLIST_ANY_METHOD.some((p) => p.test(pathname))) return true;
  // Read-only allowlist — only GET/HEAD pass without auth.
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && ALLOWLIST_READ_ONLY.some((p) => p.test(pathname))) return true;
  return false;
}

/**
 * True for a self-authenticating route (worker protocol + HMAC webhook). Uses a
 * trailing-boundary match so a prefix entry can't accidentally cover a sibling
 * path — the structural fix for the trailing-slash gate gap (§MED-2).
 */
function isSelfAuthRoute(pathname: string): boolean {
  return SELF_AUTH_PREFIXES.some((p) =>
    p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`),
  );
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function localRequestRefusal(req: NextRequest): NextResponse | null {
  // Next supplies a canonical URL to direct route callers without raw headers.
  // The production wrapper validates the raw Host against its socket port first.
  const host = req.headers.get('host') ?? req.nextUrl.host;
  const port = Number(req.nextUrl.port) || (req.nextUrl.protocol === 'https:' ? 443 : 80);
  if (!isAllowedLocalHost(host, port)) {
    return NextResponse.json({ error: 'Misdirected Request' }, { status: 421 });
  }
  if (!browserWriteAllowed(req.method, name => req.headers.get(name), req.nextUrl.protocol)) {
    return NextResponse.json({ error: 'Origin is not allowed' }, { status: 403 });
  }

  return null;
}

/** Exported for the vitest gate suite (tests/middleware-gate.test.ts). */
export function panelGateMiddleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();
  const boundary = localRequestRefusal(req);
  if (boundary) return boundary;

  // Broadcast HTML is an unprivileged shell. Stamp the request so RootLayout
  // omits every operator bootstrap, then let its client present a spectator
  // bearer explicitly to the two read routes below.
  if (pathname === '/broadcast' || pathname.startsWith('/broadcast/')) {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(O8_BROADCAST_SURFACE_HEADER, '1');
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  if (!pathname.startsWith('/api/')) return NextResponse.next();

  // A recognized spectator bearer is a strict capability, even on routes that
  // are otherwise public or self-authenticating. It never inherits an ambient
  // mutation surface merely because an anonymous caller could begin a separate
  // credential handshake there.
  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (isBrainReadWorkerBearer(bearer)) {
    if (!resolveBrainReadWorkerToken(bearer)) {
      return NextResponse.json({ error: 'Invalid or expired Brain read credential.' }, { status: 401 });
    }
    if (pathname === '/api/cortex/ask/answer' && method === 'POST') return NextResponse.next();
    return NextResponse.json({ error: 'Brain read credential is not authorized for this endpoint.' }, { status: 403 });
  }
  if (bearer.startsWith('o8ro_')) {
    return NextResponse.json({ error: 'Read-only worker has no API capability.' }, { status: 403 });
  }
  if (resolvePluginToken(bearer)) {
    if (pathname === '/api/plugins/mcp' && method === 'POST') return NextResponse.next();
    return NextResponse.json({ error: 'Plugin token is not authorized for this endpoint.' }, { status: 403 });
  }
  if (isActiveSpectatorToken(bearer)) {
    if (spectatorMayAccess(pathname, method)) return NextResponse.next();
    return NextResponse.json({ error: 'Spectator token is not authorized for this endpoint.' }, { status: 403 });
  }

  // Self-authenticating routes (worker protocol + HMAC webhook) run their own
  // auth in-handler and bypass the loopback/token gate.
  if (isSelfAuthRoute(pathname)) {
    return NextResponse.next();
  }

  // Explicit public allowlist (setup GETs, OAuth handshakes, VAPID key, enroll).
  if (isAllowlisted(pathname, method)) {
    return NextResponse.next();
  }

  // A small number of iframe resources cannot attach Authorization headers.
  // Keep them read-only and require socket-truth loopback; all other API calls
  // need an affirmative principal even when they originate on localhost.
  if (
    (method === 'GET' || method === 'HEAD')
    && LOOPBACK_READ_CAPABILITIES.some((pattern) => pattern.test(pathname))
    && isTrustedLocalRequest(req)
    && readOriginIsLocalOrAbsent(req)
  ) {
    return NextResponse.next();
  }

  // An operator bearer is valid on every API route. The root layout installs
  // it on same-origin fetches before hydration for local desktop pages.
  const panelToken = loadPanelToken();
  if (panelToken) {
    if (bearer && tokenMatches(bearer, panelToken)) {
      return NextResponse.next();
    }
  }

  if (isLocalWorkerToken(bearer)) {
    if (workerMayAccess(pathname, method)) return NextResponse.next();
    return NextResponse.json({ error: 'Worker token is not authorized for this endpoint.' }, { status: 403 });
  }

  // A per-device credential is a capability token, not an operator credential.
  // It can reach only the explicit mobile surface above; new routes fail closed.
  if (isActiveDeviceToken(bearer)) {
    if (deviceMayAccess(pathname, method)) return NextResponse.next();
    return NextResponse.json({ error: 'Device token is not authorized for this endpoint.' }, { status: 403 });
  }

  return NextResponse.json(
    {
      error: 'Unauthorized',
      detail:
        'This endpoint is restricted to local o8 clients. Requests from other origins must present a valid bearer token.',
    },
    { status: 401 },
  );
}

const clerkPublishableKey =
  optionalEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY') ?? optionalEnv('CLERK_PUBLISHABLE_KEY');
const clerkSecretKey = optionalEnv('CLERK_SECRET_KEY');

// clerkMiddleware REQUIRES a secret key — with a publishable key but NO secret it
// throws on every request (verified: all gated routes 500'd, even allowlisted GETs,
// because the wrapper fails before our gate runs). The DESKTOP never ships the
// secret: Clerk runs client-side via the publishable key + the o8:// ticket flow,
// and server-side user resolution verifies the session token networklessly in the
// route handler (not via auth()/clerkMiddleware). So only wrap with clerkMiddleware
// when BOTH keys are present (the hosted/web path); otherwise — fresh install OR the
// desktop (publishable-only) — run the bare loopback gate. Clerk-gated routes like
// /api/v2/chat still fail closed inside their own handlers.
let hostedMiddleware: Promise<NextMiddleware> | undefined;
export default async function middleware(req: NextRequest, event?: NextFetchEvent) {
  const boundary = localRequestRefusal(req);
  if (boundary) return boundary;
  if (!clerkPublishableKey || !clerkSecretKey) return panelGateMiddleware(req);
  hostedMiddleware ??= import('@clerk/nextjs/server').then(({ clerkMiddleware }) =>
    clerkMiddleware((_auth, request) => panelGateMiddleware(request), {
      publishableKey: clerkPublishableKey,
      secretKey: clerkSecretKey,
    }));
  return (await hostedMiddleware)(req, event!);
}

// Default-deny is a love language.
