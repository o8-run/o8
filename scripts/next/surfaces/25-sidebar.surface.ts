/** Sidebar-owned fixture records, production routes and live event peer. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export async function prepare({ dataDir }: SurfaceContext): Promise<SurfaceRoutes> {
  process.env.O8_OWNED_PI_ROOT = join(dataDir, 'owned-pi');
  process.env.O8_OWNED_PI_BUILTIN_ROOT = join(dataDir, 'owned-pi-builtin');
  return {};
}
export default async function register({ dataDir, root, repo, seeds, fixtureToken, transcriptFixtures }: SurfaceContext): Promise<SurfaceRoutes> {
  const enabled = process.argv.includes('--sidebar');
  const auditKeyboard = process.argv.includes('--sidebar-keyboard-audit');
  const archives: Array<{ method: string; path: string; tabId?: string }> = [];
  // --sidebar-before-inbox serves the thread and runtime listings as a host
  // from before #5110 did: without inbox subjects or settlement fields.
  const beforeInbox = process.argv.includes('--sidebar-before-inbox');
  const { GET: historyList } = await import('../../../src/app/api/v2/chat-history/list/route');
  if (!enabled) return { routes: { 'GET /api/v2/chat-history/list': historyList } };
  const fixture = await import('../sidebar-fixture');
  seeds.push(...fixture.seedSidebar(dataDir, root));
  if (process.argv.includes('--sidebar-markers')) await (await import('./sidebar-markers')).seedSidebarMarkers(join(root, 'sidebar-alpha'));
  await fixture.installSidebarRuntime(dataDir, join(root, 'sidebar-alpha'));
  const { GET: sessions } = await import('../../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: history } = await import('../../../src/app/api/mobile/history/route');
  const { GET: context, PATCH: patchHistory, POST: saveHistory } = await import('../../../src/app/api/v2/chat-history/route');
  const runtimeArchive = await import('../../../src/app/api/runtime/archive/route');
  const { GET: inventory } = await import('../../../src/app/api/runtime/inventory/route');
  let pagingMessageSent = false;
  let socket: ReturnType<typeof import('../sidebar-socket').attachSidebarSocket> | undefined;
  return {
    priority: 15,
    routes: {
      'GET /api/mobile/orchestrator/threads': sessions, 'GET /api/mobile/history': history,
      'GET /api/v2/chat-history': context, 'PATCH /api/v2/chat-history': patchHistory,
      'POST /api/v2/chat-history': saveHistory, 'GET /api/v2/chat-history/list': historyList,
      'GET /api/runtime/archive': runtimeArchive.GET, 'POST /api/runtime/archive': runtimeArchive.POST,
      ...(auditKeyboard ? { 'GET /api/sidebar-fixture/archives': async () => Response.json({ archives }) } : {}),
      ...(beforeInbox ? { 'GET /api/runtime/inventory': inventory } : {}),
    },
    admit: ({ route, url, body, method }) => {
      if (route === patchHistory && body && Object.hasOwn(JSON.parse(body), 'inboxAction')) {
        return seeds.some(seed => seed.id === JSON.parse(body).tabId) ? 200 : 404;
      }
      if (auditKeyboard && body && (route === runtimeArchive.POST
        || route === patchHistory && Object.hasOwn(JSON.parse(body), 'archivedAt'))) {
        archives.push({ method, path: url.pathname, tabId: JSON.parse(body).tabId });
      }
      if (route === history && !seeds.some(seed => `llm-chat:${seed.id}` === url.searchParams.get('sessionKey'))
        && !(transcriptFixtures && url.searchParams.get('sessionKey') === 'opencode-owned:next-worker')
        && url.searchParams.get('sessionKey') !== 'pi-builtin-owned:grid-runtime') return 404;
      if (route === context && !seeds.some(seed => seed.id === url.searchParams.get('tabId'))) return 404;
      if (!body) return 200;
      const target = JSON.parse(body);
      return (route === runtimeArchive.POST ? target.sessionKey === 'pi-builtin-owned:grid-runtime'
        : (route === patchHistory || route === saveHistory) && seeds.some(seed => seed.id === target.tabId)
          // New thread creates a conversation in the owned fixture repository.
          || route === saveHistory && /^thoughts-next-\d+$/.test(target.tabId) && realpathSync(target.repoPath) === realpathSync(repo)) ? 200 : 400;
    },
    run: async (route, request) => {
      if (beforeInbox && (route === sessions || route === inventory)) {
        const key = route === sessions ? 'threads' : 'agents';
        const response = await route(request);
        const listed = await response.json() as Record<string, Array<Record<string, unknown>>>;
        const fields = ['inboxSubject', 'parentInboxSubject', 'settledOverride', 'settledAt', 'unsettledAt'];
        return Response.json({ ...listed, [key]: listed[key]?.map(row =>
          Object.fromEntries(Object.entries(row).filter(([field]) => !fields.includes(field)))) },
        { status: response.status, headers: { 'cache-control': 'no-store' } });
      }
      if (route === sessions) {
        if (process.argv.includes('--sidebar-paging-message') && request.nextUrl.searchParams.get('offset') === '500' && !pagingMessageSent) {
          pagingMessageSent = true;
          const incoming = await fetch(new URL('/api/v2/chat-history', request.url), {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken}` },
            body: JSON.stringify({ tabId: 'thoughts-sidebar-0001', repoPath: join(root, 'sidebar-beta'),
              messages: [{ id: 'paging-live-user', role: 'user', content: 'Message received between pages', timestamp: 1791000000000 }] }),
          });
          if (!incoming.ok) throw new Error('Between-page message failed');
          await incoming.arrayBuffer();
        }
        if (process.argv.includes('--sidebar-repeat-page')) request.nextUrl.searchParams.set('offset', '0');
      }
      return route(request);
    },
    after: async ({ route, body }, response) => {
      if ((route === patchHistory || route === saveHistory) && response.ok) {
        const target = JSON.parse(body);
        if (!seeds.some(seed => seed.id === target.tabId)) seeds.push({ id: target.tabId, title: target.title, messages: target.messages });
        await socket?.changed(target.tabId);
      }
      return false;
    },
    socket: async (server, token, requests) => {
      socket = (await import('../sidebar-socket')).attachSidebarSocket(server, token, requests);
      return socket.close;
    },
  };
}
