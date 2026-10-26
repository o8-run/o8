/** Shared shell transport registrations; importing this module loads no handlers or middleware. */
interface Route {
  path: string;
  methods: string[];
  load: () => Promise<unknown>;
}
const route = (path: string, methods: string, load: Route['load']): Route => ({ path, methods: methods.split(' '), load });

// Keys mirror register_surfaces!, including surfaces whose transport is WebSocket-only.
// Each route loads its own implementation; unrelated surfaces stay cold.
export const nativeSurfaceRoutes: Record<string, Route[]> = {
  session: [
    route('/api/mobile/orchestrator/threads', 'GET', () => import('@/app/api/mobile/orchestrator/threads/route')),
    route('/api/orchestrator/state', 'GET PATCH', () => import('@/app/api/orchestrator/state/route')),
    route('/api/runtime/inventory', 'GET', () => import('@/app/api/runtime/inventory/route')),
    route('/api/mobile/history', 'GET', () => import('@/app/api/mobile/history/route')),
    route('/api/v2/chat-history', 'GET POST PATCH', () => import('@/app/api/v2/chat-history/route')),
    route('/api/orchestrator/composer-queue', 'GET POST PATCH DELETE', () => import('@/app/api/orchestrator/composer-queue/route')),
    route('/api/panel/ws-info', 'GET', () => import('@/app/api/panel/ws-info/route')),
  ],
  brain: [route('/api/cortex/ask', 'POST', () => import('@/app/api/cortex/ask/route'))],
  activity: [
    route('/api/panel/commits', 'GET', () => import('@/app/api/panel/commits/route')),
    route('/api/panel/ci', 'GET', () => import('@/app/api/panel/ci/route')),
    route('/api/panel/ci/[id]', 'GET', () => import('@/app/api/panel/ci/[id]/route')),
    route('/api/panel/pr', 'GET', () => import('@/app/api/panel/pr/route')),
    route('/api/orchestrator/stop-mission', 'POST', () => import('@/app/api/orchestrator/stop-mission/route')),
  ],
  pull_requests: [
    route('/api/panel/prs', 'GET', () => import('@/app/api/panel/prs/route')),
    route('/api/panel/prs/[number]', 'GET POST', () => import('@/app/api/panel/prs/[number]/route')),
    route('/api/panel/github-status', 'GET', () => import('@/app/api/panel/github-status/route')),
    route('/api/orchestrator/merge-preview', 'GET', () => import('@/app/api/orchestrator/merge-preview/route')),
  ],
  grid: [],
  shortcuts: [], // Local shortcut reference has no HTTP transport.
  terminal: [route('/api/mobile/terminal-sessions', 'GET', () => import('@/app/api/mobile/terminal-sessions/route'))],
  palette: [], // Local commands and workspace navigation reuse the selected surface's transport.
  sidebar: [
    route('/api/mobile/orchestrator/threads', 'GET', () => import('@/app/api/mobile/orchestrator/threads/route')),
    route('/api/orchestrator/state', 'GET', () => import('@/app/api/orchestrator/state/route')),
    route('/api/runtime/inventory', 'GET', () => import('@/app/api/runtime/inventory/route')),
    route('/api/v2/chat-history/list', 'GET', () => import('@/app/api/v2/chat-history/list/route')),
    route('/api/v2/chat-history', 'GET POST PATCH', () => import('@/app/api/v2/chat-history/route')),
    route('/api/runtime/archive', 'POST', () => import('@/app/api/runtime/archive/route')),
  ],
  workers: [
    route('/api/lanes', 'GET', () => import('@/app/api/lanes/route')),
    route('/api/lanes/[id]', 'GET', () => import('@/app/api/lanes/[id]/route')),
    route('/api/orchestrator/state', 'GET', () => import('@/app/api/orchestrator/state/route')),
    route('/api/orchestrator/lane-events', 'GET', () => import('@/app/api/orchestrator/lane-events/route')),
  ],
  settings: [
    route('/api/panel/operator-defaults', 'GET POST', () => import('@/app/api/panel/operator-defaults/route')),
    route('/api/v2/keys', 'GET POST PATCH DELETE', () => import('@/app/api/v2/keys/route')),
  ],
  setup: [route('/api/setup/config', 'GET POST', () => import('@/app/api/setup/config/route'))],
  projects: [
    route('/api/panel/projects', 'GET', () => import('@/app/api/panel/projects/route')),
    route('/api/panel/projects/active', 'POST', () => import('@/app/api/panel/projects/active/route')),
    route('/api/panel/projects/[id]', 'PATCH DELETE', () => import('@/app/api/panel/projects/[id]/route')),
    route('/api/panel/repos', 'GET POST DELETE', () => import('@/app/api/panel/repos/route')),
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
    route('/api/orchestrator/review-state', 'GET', () => import('@/app/api/orchestrator/review-state/route')),
    route('/api/orchestrator/review', 'POST', () => import('@/app/api/orchestrator/review/route')),
    route('/api/lanes/[id]/diff', 'GET', () => import('@/app/api/lanes/[id]/diff/route')),
    route('/api/worktrees/diff', 'GET', () => import('@/app/api/worktrees/diff/route')),
  ],
  customize: [
    route('/api/customize/inventory', 'GET', () => import('@/app/api/customize/inventory/route')),
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
  route('/api/runtime/transcript', 'GET', () => import('@/app/api/runtime/transcript/route')),
  route('/api/runtime/action', 'POST', () => import('@/app/api/runtime/action/route')),
  route('/api/runtime/launch', 'POST', () => import('@/app/api/runtime/launch/route')),
  route('/api/orchestrator/headless-tick', 'POST', () => import('@/app/api/orchestrator/headless-tick/route')),
  route('/api/review/auto-review', 'POST', () => import('@/app/api/review/auto-review/route')),
];
const routes = [...Object.values(nativeSurfaceRoutes).flat(), ...producers];
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
  const match = routes.map(route => ({ route, params: parameters(route.path, pathname) })).find(entry => entry.params !== null);
  return match && (method === undefined || match.route.methods.includes(method)) ? match : undefined;
}
