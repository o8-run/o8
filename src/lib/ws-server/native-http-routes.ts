import { apiFrontDoorEnabled, nativeHttpTransportEnabled } from '@/lib/ws-server/api-front-door-config';
import { viewerRedactionGrant } from './native-git-diff-context';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/** Shell transport work: reuse surface handlers on the opt-in WS listener without Next. */
import nativeRoutes from '../../../crates/o8d/native-routes.json';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NextRequest } from 'next/server';
import { panelGateMiddleware } from '@/middleware';
import { mutationWorkspace } from '@/lib/repos/mutation-workspace';
import { matchNativeHttpRoute, nativeHttpMethods } from './native-http-registry';
import { nativeSessionReadsEnabled } from './native-session-reads';
import { markNativeCortexReader } from '@/lib/cortex/owner-process';
import { isLoopbackAddress } from '@/lib/auth/loopback-request';
import { O8_RELAY_FORWARD_HEADER, O8_RELAY_FORWARD_MARKER, O8_RELAY_SURFACE_HEADER, O8_WEB_MACHINE_SURFACE } from '@/lib/connect/web-machine-surface';
import { browserWriteAllowed, isShellHost, requestTargetAllowed } from '../../../scripts/lib/http-request-boundary.cjs';
export { nativeSurfaceRoutes } from './native-http-registry';

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const REQUEST_LIMIT = 16 * 1024 * 1024;

/**
 * The x-o8-client-addr stamp for a native request, matching the production
 * wrapper's: the caller's real address, with every boundary able only to
 * remove loopback trust. No address (an unattested relay) is never loopback.
 */
export function nativeClientAddr(clientAddress: string | null, get: (name: string) => string | null,
  method: string, target: string, publicPort: number | undefined): { address: string; relaySurface: string | null } {
  if (!clientAddress) return { address: 'unverified-proxy', relaySurface: null };
  if (!isLoopbackAddress(clientAddress)) return { address: clientAddress, relaySurface: null };
  // A same-host relay (the mobile connector, a Next route forwarding here)
  // replays a remote caller, so its request is remote, never loopback.
  if (get(O8_RELAY_FORWARD_HEADER) === '1') {
    return { address: O8_RELAY_FORWARD_MARKER,
      relaySurface: get(O8_RELAY_SURFACE_HEADER) === O8_WEB_MACHINE_SURFACE ? O8_WEB_MACHINE_SURFACE : null };
  }
  const host = get('host');
  if (!host || publicPort === undefined || !isShellHost(host, publicPort) || !requestTargetAllowed(target, publicPort)
    || !browserWriteAllowed(method, get, 'http:')) return { address: 'unverified-proxy', relaySurface: null };
  return { address: clientAddress, relaySurface: null };
}

/** Returns false for unregistered paths so the existing listener keeps its behavior. */
export async function handleNativeHttp(req: IncomingMessage, res: ServerResponse, publicPort = req.socket.localPort,
  authenticatedBridge = false, clientAddress: string | null = null): Promise<boolean> {
  if (!req.url?.startsWith('/api/')) return false;
  const abort = new AbortController();
  const disconnected = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', disconnected);
  try {
    // o8d relays from the public port to a private listener and keeps the
    // client's Host, so the gate must compare Host with the public port.
    const url = new URL(req.url, `http://127.0.0.1:${publicPort}`);
    const match = matchNativeHttpRoute(url.pathname, req.method) ?? matchNativeHttpRoute(url.pathname);
    if (!match) return false;
    if (nativeHttpTransportEnabled()) markNativeCortexReader();
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    // The listener passes the caller's real address: o8d's attested peer on its
    // private upstream, never the relay's own loopback socket.
    const stamp = nativeClientAddr(clientAddress, name => headers.get(name), req.method ?? 'GET', req.url, publicPort);
    headers.set('x-o8-client-addr', stamp.address);
    headers.delete(O8_RELAY_SURFACE_HEADER);
    if (stamp.relaySurface) headers.set(O8_RELAY_SURFACE_HEADER, stamp.relaySurface);
    headers.delete('x-o8d-peer');
    headers.delete('x-o8d-bridge');
    headers.delete('x-o8d-relay');
    const completeDirectives = req.headers['x-o8d-session-read'] === 'complete-directives/1';
    const composeThreads = typeof req.headers['x-o8d-session-read'] === 'string' && req.headers['x-o8d-session-read'].startsWith('compose-threads/');
    // The private POST carries the pieces for an already-admitted GET. Apply
    // that GET's existing gate; never execute the public POST writer here.
    const init = { method: (composeThreads || completeDirectives) && authenticatedBridge ? 'GET' : req.method, headers, signal: abort.signal };
    const gate = panelGateMiddleware(new NextRequest(url, init));
    let response: Response;
    let admission = false;
    if (gate.headers.get('x-middleware-next') !== '1') response = gate;
    else if (completeDirectives) {
      response = url.pathname === '/api/cortex/directives' && nativeHttpTransportEnabled()
        ? await (await import('./native-directives-completion')).completeNativeDirectives(req, authenticatedBridge, new NextRequest(url, init))
        : new Response(null, { status: 409 });
    } else if (composeThreads) {
      response = url.pathname === '/api/mobile/orchestrator/threads' && nativeHttpTransportEnabled()
        ? await (await import('./native-thread-list-compose')).composeNativeThreadList(req, authenticatedBridge)
        : new Response(null, { status: 409 });
    } else if (authenticatedBridge && req.headers['x-o8d-session-read'] === 'authorize') {
      // Admission probes must never execute a writer when disabled or unmatched.
      const retiredProjectPath = ['/api/projects/context', '/api/projects/dismissed-suggestions'].includes(url.pathname);
      const ownedRoute = nativeRoutes.find(route => route.path === match.route.path && route.methods.includes(req.method ?? 'GET') && 'owned' in route && route.owned === true);
      const threadListRoute = ownedRoute && 'composition' in ownedRoute && ownedRoute.composition === 'mobile-threads/1';
      const composerQueueRoute = ownedRoute && 'admission' in ownedRoute && ownedRoute.admission === 'composer-queue';
      const viewerRoute = ownedRoute && 'redaction' in ownedRoute && ownedRoute.redaction === 'viewer';
      const diffCommentRoute = ownedRoute && ['/api/mobile/diff-comment', '/api/mobile/diff-comments'].includes(url.pathname);
      if ((!nativeSessionReadsEnabled() && !(nativeHttpTransportEnabled() && ownedRoute)) || retiredProjectPath
        || !nativeRoutes.some(route => route.path === match.route.path && route.methods.includes(req.method ?? 'GET'))) {
        response = new Response(null, { status: 409 });
      } else {
        // Admission only. Keep the middleware and queue's existing defense-in-depth
        // gate authoritative; the bridge credential cannot authorize a principal.
        // Diff comments have only the mobile middleware gate, including paired
        // devices. Do not add the unrelated remote operator-only panel gate.
        const denied = !diffCommentRoute && (req.method !== 'GET' || ['/api/orchestrator/composer-queue', '/api/runtime/provider-instances', '/api/runtime/capabilities', '/api/runtime/service-tiers', '/api/v2/keys', '/api/projects'].includes(url.pathname) || match.route.path === '/api/projects/[id]')
          ? (await import('@/lib/panel/auth')).requirePanelAuth(new NextRequest(url, init)) : null;
        let projectDenied: Response | null = null;
        if (url.pathname === '/api/panel/repo-icon') {
          const principal = (await import('@/lib/auth/principal')).resolveRequestPrincipal(new NextRequest(url, init));
          if (principal !== 'operator' && principal !== 'worker') projectDenied = Response.json({ error: 'Repository icon access requires an operator or dispatched-worker credential.' }, { status: 403 });
        }
        if (url.pathname === '/api/worktrees/diff' || url.pathname === '/api/worktrees/diff-summary') {
          const principal = (await import('@/lib/auth/principal')).resolveRequestPrincipal(new NextRequest(url, init));
          if (principal !== 'operator' && principal !== 'device') projectDenied = new Response(null, { status: 409 });
        }
        const projectRegistryRead = ['/api/panel/repos', '/api/panel/projects', '/api/projects', '/api/panel/repo-icon'].includes(url.pathname);
        // The settings handler's window-owner hop is a refusal floor. Defer it
        // to the original handler even when the public bearer gate passed.
        const deferSettingsHop = url.pathname === '/api/panel/operator-defaults'
          && headers.has('x-o8-settings-window-owner-hop');
        // Scope remains the live Node registry/target resolver's authority.
        // Bind its result to this admitted request; never replicate the registry in Rust.
        const laneDiffTarget = viewerRoute && match.route.path === '/api/lanes/[id]/diff' && !denied && !projectDenied
          ? await (await import('./native-lane-diff-context')).nativeLaneDiffTarget(new NextRequest(url, init), match.params?.id ?? '') : undefined;
        let fileScopeDenied = false;
        let fileContentScope: { repoRoot: string } | undefined;
        let fileReadTarget: { root: string; relativePath: string } | undefined;
        let fileAssetTarget: Awaited<ReturnType<typeof import('@/lib/files/asset-scope').nativeAssetTarget>>;
        let repoSpecTarget: ReturnType<typeof import('@/lib/o8md/read-scope').nativeSpecReadTarget> | undefined;
        if (viewerRoute && !denied && !projectDenied) {
          try {
            const workspace = url.searchParams.get('workspace');
            if (url.pathname === '/api/repo-spec') {
              repoSpecTarget = (await import('@/lib/o8md/read-scope')).nativeSpecReadTarget(new NextRequest(url, init));
              if (repoSpecTarget === null) fileScopeDenied = true;
            }
            if (['/api/panel/file-io', '/api/panel/file-asset', '/api/panel/serve-image', '/api/mobile/media'].includes(url.pathname)) {
              fileAssetTarget = await (await import('@/lib/files/asset-scope')).nativeAssetTarget(new NextRequest(url, init));
              if (fileAssetTarget === null) fileScopeDenied = true;
            }
            if (url.pathname === '/api/panel/file-content' && workspace) {
              const scope = await (await import('@/lib/llm/repo-scope')).resolveRegisteredRepoScope((await import('@/lib/fs/safe-path')).expandHome(workspace));
              if (!scope.repoRoot) fileScopeDenied = true;
              else fileContentScope = { repoRoot: scope.repoRoot };
            } else if (url.pathname === '/api/v2/files') {
              const target = await (await import('@/lib/files/file-target')).resolveFileTarget(url.searchParams.get('path') ?? '', workspace);
              if ('error' in target) fileScopeDenied = true;
              else fileReadTarget = target;
            }
          } catch { fileScopeDenied = true; }
        }
        const deferChatHistory = url.pathname === '/api/v2/chat-history' && req.method === 'GET'
          && !(await import('./native-chat-history-admission')).nativeChatHistoryAllowed(url.searchParams.get('tabId'));
        const deferMobileHistory = url.pathname === '/api/mobile/history' && req.method === 'GET'
          && !(await import('./native-chat-history-admission')).nativeMobileHistoryAllowed(url.searchParams.get('sessionKey'));
        const composerQueue = composerQueueRoute && !denied && !projectDenied
          ? (await import('./native-composer-queue-context')).nativeComposerQueueContext(url) : undefined;
        let threadList: { machineDisplayName: string } | null | undefined;
        if (threadListRoute && !denied && !projectDenied) {
          try {
            const backend = url.searchParams.get('backend')?.trim();
            if (url.searchParams.get('archived') !== '1' && (!backend || (await import('@/lib/lane/orchestrator-backends/types')).isOrchestratorBackendId(backend))) {
              (await import('@/lib/bots/network-projection')).projectAllNetworkThreads();
              (await import('@/lib/mobile/orchestrator-thread-history')).ensureHistoryReady();
            }
            const machineDisplayName = (await import('@/lib/mobile/machine-name')).localMachineName();
            threadList = Buffer.byteLength(machineDisplayName) <= 16 * 1024 ? { machineDisplayName } : null;
          } catch { threadList = null; }
        }
        const directivesScope = url.pathname === '/api/cortex/directives' && !denied && !projectDenied
          ? await (await import('./native-directives-context')).nativeDirectivesScope(url) : undefined;
        const laneLive = url.pathname === '/api/lanes'
        ? url.searchParams.get('view') === 'live'
          && (await import('@/lib/lane/live-occupancy')).canReadLiveLaneOccupancy(
            (await import('@/lib/auth/principal')).resolveRequestPrincipalContext(new NextRequest(url, init)))
        : undefined;
      const defaultsContext = {
        laneLive,
          ...(diffCommentRoute ? { diffCommentAuthority: apiFrontDoorEnabled() } : {}),
          composerQueue, threadList, laneDiffTarget, directivesScope,
          fileContentScope, fileReadTarget, fileAssetTarget, repoSpecTarget,
          gitRefsCommitRoot: viewerRoute && match.route.path === '/api/panel/commits/[hash]'
            ? resolve((await import('@/lib/panel/git-commits')).resolveWorkspaceRoot(url.searchParams.get('workspace'))) : undefined,
          fileTreeLocale: url.pathname === '/api/panel/files' ? new Intl.Collator().resolvedOptions().locale : undefined,
          projectIconCachePresent: ['/api/panel/repos', '/api/panel/repo-icon'].includes(url.pathname) && (await import('@/lib/repos/project-icon-resolver')).projectIconResolver.hasFreshEntries(),
          projectRepoDigest: projectRegistryRead ? await (await import('@/lib/repos/registry')).nativeRepoRegistryFingerprint() : null,
          projectReadinessCached: url.pathname === '/api/panel/repos' && (await import('@/lib/repos/readiness')).hasCachedRepoReadiness(),
          projectsCwd: process.cwd(), projectsHome: homedir(),
          fileReadMaxBytes: viewerRoute ? (await import('@/lib/fs/file-size-caps')).FILE_EDIT_MAX_BYTES : undefined,
          filesTreeRoot: viewerRoute ? process.env.CORTEX_IDE_REVIEW_REPO_ROOT || null : undefined,
          gitDiffDefaultRoot: viewerRoute ? process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd() : undefined,
          operatorEnvClean: [
            'O8_ACTION_EFFORT',
            'O8_ACTION_MODEL',
            'O8_ACTION_RUNTIME',
            'O8_AUTO_APPLY_UPDATES',
            'O8_BRAIN_ROUTING_MODE',
            'O8_BRAIN_USE_CLAUDE_CLI',
            'O8_BRAIN_WARMUP',
            'O8_BRANCH_PREFIX',
            'O8_BUYIN_DOC',
            'O8_CLASS_A_COMPOSER',
            'O8_CLAUDE_WORKER_EFFORT',
            'O8_CODEX_WORKER_EFFORT',
            'O8_COLLIDE_AGGREGATOR_DEFAULT',
            'O8_COMMIT_ATTRIBUTION',
            'O8_CRASH_REPORTS',
            'O8_DEFAULT_DISPATCH_RUNTIME',
            'O8_DISPATCH_LOAD_PER_CORE',
            'O8_DISPATCH_MODEL',
            'O8_EXPERIMENTAL_CANVAS',
            'O8_EXPERIMENTAL_CHAT',
            'O8_EXPERIMENTAL_GEMINI',
            'O8_EXPERIMENTAL_OPENCODE',
            'O8_HEAL_BOT_ENABLED',
            'O8_IN_APP_ORCHESTRATOR_ENABLED',
            'O8_LOCAL_CHAT_MODEL',
            'O8_LOCAL_EMBED_MODEL',
            'O8_LOCAL_INFERENCE_BASE_URL',
            'O8_MAX_PARALLEL_DISPATCHES',
            'O8_NATIVE_BROWSER_VIEW',
            'O8_NO_PHONE_HOME',
            'O8_ORCHESTRATOR_BACKEND',
            'O8_ORCHESTRATOR_MODEL',
            'O8_PROMPT_CACHING',
            'O8_PR_LINK_DESTINATION',
            'O8_REVIEWER_BACKEND',
            'O8_STORAGE_RESERVE_FLOOR_GB',
            'O8_STORAGE_RESERVE_RATIO',
            'O8_STRICT_OVERLAP_GATE',
            'O8_SUBSCRIPTION_PROFILE',
            'O8_SUPERVISOR_AUTO_ESCALATE',
            'O8_TELEMETRY_INGEST_URL',
            'O8_TELEMETRY_OPT_IN',
            'O8_THINKING_EFFORT',
            'O8_TRIAGE_EFFORT',
            'O8_TRIAGE_MODEL',
            'O8_TRIAGE_RUNTIME',
            'O8_UPDATE_AUTO_APPLY',
            'O8_WORKERS_USE_BRAIN',
            'O8_WORKSPACE_MANIFEST_POLICY',
            'O8_WORKSPACE_PARKING_MODE',
            'O8_WORKTREE_MAX_COUNT',
            'O8_WORKTREE_MAX_TOTAL_GB',
          ].every(name => process.env[name] === undefined),
          grokAgentRoot: process.env.O8_GROK_AGENT_DATA?.trim() || join(homedir(), 'agent-data', 'agents'),
          machineId: url.pathname === '/api/panel/operator-defaults'
            ? (await import('@/lib/panel/instance-identity')).peekCachedInstanceIdentity()?.instanceId ?? null : null,
          claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
          disableClaudeFast: process.env.CLAUDE_CODE_DISABLE_FAST_MODE === '1',
          ambientKeysPresent: ['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some(name => Boolean(process.env[name]?.trim())),
        };
        response = denied ?? projectDenied ?? ((laneDiffTarget === null || directivesScope === null || threadList === null || composerQueue === null || fileScopeDenied || deferChatHistory || deferMobileHistory || deferSettingsHop || laneLive === false) ? new Response(null, { status: 409 }) : new Response(null, { status: 204, headers: {
          'x-o8d-defaults-context': Buffer.from(JSON.stringify(defaultsContext)).toString('base64'),
        } }));
        if (viewerRoute && response.status === 204) {
          const grant = req.headers['x-o8d-redaction'] === 'viewer/1' ? viewerRedactionGrant(defaultsContext) : null;
          response = grant === null ? new Response(null, { status: 409 }) : new Response(grant, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        }
        if (composerQueueRoute && response.status === 204) {
          const grant = req.headers['x-o8d-composer-queue'] === 'capabilities/1'
            ? (await import('./native-composer-queue-context')).composerQueueGrant(defaultsContext) : null;
          response = grant === null ? new Response(null, { status: 409 }) : new Response(grant, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        }
        if (threadListRoute && response.status === 204) {
          response = new Response(JSON.stringify({ version: 1, defaultsContext: { threadList } }), { status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        }
        admission = (!(viewerRoute || composerQueueRoute || threadListRoute) || response.status === 200) && composerQueue !== null && threadList !== null && laneDiffTarget !== null && directivesScope !== null && !denied && !projectDenied && !fileScopeDenied && !deferChatHistory && !deferMobileHistory && !deferSettingsHop && !(laneLive === false);
      }
    } else if (!match.route.methods.includes(req.method ?? 'GET')) {
      response = Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: nativeHttpMethods(url.pathname).join(', ') } });
    } else if (match.route.path === '/api/runtime/archive' && typeof mutationWorkspace({ url: url.href }) !== 'string') {
      response = Response.json({ error: 'An absolute workspace is required for native archive' }, { status: 400 });
    } else {
      const requestLimit = match.route.maxBodyBytes ?? REQUEST_LIMIT;
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > requestLimit) break;
        chunks.push(Buffer.from(chunk));
      }
      if (size > requestLimit) response = Response.json({ error: requestLimit === REQUEST_LIMIT ? 'Request exceeds 16 MiB' : `Request exceeds ${requestLimit} bytes` }, { status: 413 });
      else {
        const handlers = await match.route.load() as Record<string, Handler>;
        const request = new NextRequest(url, { ...init, ...(size ? { body: Buffer.concat(chunks) } : {}) });
        response = await handlers[req.method ?? 'GET'](request, { params: Promise.resolve(match.params!) });
      }
    }
    if (res.destroyed) { await response.body?.cancel(); return true; }
    const responseHeaders = Object.fromEntries(response.headers);
    // A tunnelled client socket closes after each response so the next request
    // is classified and stamped again. An admission comes only from o8d's own pooled
    // backhaul client with the bridge key on every request, so it may stay open.
    if (admission) res.removeHeader('connection');
    else if (process.env.O8_WS_O8D === '1') responseHeaders.connection = 'close';
    res.writeHead(response.status, responseHeaders);
    if (response.body) {
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      abort.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await once(res, 'drain', { signal: abort.signal });
        }
      } finally {
        abort.signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
      }
    }
    res.end();
    return true;
  } catch {
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"Native route unavailable"}');
    }
    return true;
  } finally {
    req.resume();
    res.off('close', disconnected);
  }
}
