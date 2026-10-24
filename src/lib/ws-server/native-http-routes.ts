/** The native surface and its WS producers use the existing Next route handlers.
 * Imports stay lazy so opting in does not preload unrelated orchestration code. */
import type { NextRequest } from 'next/server';

type Handler = (request: NextRequest) => Response | Promise<Response>;
type Routes = Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT' | 'HEAD' | 'OPTIONS', Handler>>;
const loaders: Record<string, () => Promise<Routes>> = {
  '/api/mobile/orchestrator/threads': () => import('@/app/api/mobile/orchestrator/threads/route'),
  '/api/mobile/history': () => import('@/app/api/mobile/history/route'),
  '/api/v2/chat-history': () => import('@/app/api/v2/chat-history/route'),
  '/api/orchestrator/state': () => import('@/app/api/orchestrator/state/route'),
  '/api/runtime/inventory': () => import('@/app/api/runtime/inventory/route'),
  '/api/orchestrator/composer-queue': () => import('@/app/api/orchestrator/composer-queue/route'),
  '/api/panel/ws-info': () => import('@/app/api/panel/ws-info/route'),
  '/api/orchestrator/review-state': () => import('@/app/api/orchestrator/review-state/route'),
  '/api/orchestrator/review': () => import('@/app/api/orchestrator/review/route'),
  '/api/worktrees/diff': () => import('@/app/api/worktrees/diff/route'),
  // These are also requested by the authoritative WS checkpoint and command producers.
  '/api/command-center/snapshot': () => import('@/app/api/command-center/snapshot/route'),
  '/api/browser/inventory': () => import('@/app/api/browser/inventory/route'),
  '/api/broadcast/commentary': () => import('@/app/api/broadcast/commentary/route'),
  '/api/runtime/transcript': () => import('@/app/api/runtime/transcript/route'),
  '/api/runtime/action': () => import('@/app/api/runtime/action/route'),
  '/api/runtime/launch': () => import('@/app/api/runtime/launch/route'),
  '/api/mobile/inbox': () => import('@/app/api/mobile/inbox/route'),
  '/api/mobile/sync': () => import('@/app/api/mobile/sync/route'),
  '/api/orchestrator/headless-tick': () => import('@/app/api/orchestrator/headless-tick/route'),
  '/api/review/auto-review': () => import('@/app/api/review/auto-review/route'),
  '/api/setup/identity': () => import('@/app/api/setup/identity/route'),
  '/api/setup/status': () => import('@/app/api/setup/status/route'),
  '/api/panel/status': () => import('@/app/api/panel/status/route'),
  '/api/mobile/symon': () => import('@/app/api/mobile/symon/route'),
  '/api/mobile/symon/text-turn': () => import('@/app/api/mobile/symon/text-turn/route'),
  '/api/mobile/symon/tool': () => import('@/app/api/mobile/symon/tool/route'),
  '/api/mobile/symon/confirm': () => import('@/app/api/mobile/symon/confirm/route'),
  '/api/symon/machine/session': () => import('@/app/api/symon/machine/session/route'),
  '/api/worktrees/conflicts': () => import('@/app/api/worktrees/conflicts/route'),
  '/api/mcp': () => import('@/app/api/mcp/route'),
  '/api/v2/proxy/llm': () => import('@/app/api/v2/proxy/llm/route'),
};

export async function resolveNativeHttpHandler(path: string, method: string): Promise<Handler | null> {
  const lane = /^\/api\/lanes\/([^/]+)\/diff$/.exec(path);
  if (lane && method === 'GET') {
    const { GET } = await import('@/app/api/lanes/[id]/diff/route');
    return request => GET(request, { params: Promise.resolve({ id: decodeURIComponent(lane[1]) }) });
  }
  const load = loaders[path];
  if (!load) return null;
  const routes = await load();
  return routes[method as keyof Routes] ?? (() => Response.json({ error: 'Method not allowed' }, { status: 405 }));
}

/** Bootstrap producers already own recovery; avoid an HTTP call back into the
 * listener that is waiting for that same bootstrap to finish. */
export async function dispatchNativeHttp(request: NextRequest): Promise<Response> {
  const { panelGateMiddleware } = await import('@/middleware');
  const denied = panelGateMiddleware(request);
  if (denied.status !== 200) return denied;
  const handler = await resolveNativeHttpHandler(request.nextUrl.pathname, request.method);
  return handler ? handler(request) : Response.json({ error: 'Not found' }, { status: 404 });
}
