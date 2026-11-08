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
    route('/api/review/workspace', 'GET', () => import('@/app/api/review/workspace/route')),
    route('/api/runtime/service-tiers', 'GET', () => import('@/app/api/runtime/service-tiers/route')),
    route('/api/runtime/telemetry', 'GET', () => import('@/app/api/runtime/telemetry/route')),
    route('/api/orchestrator/status', 'GET', () => import('@/app/api/orchestrator/status/route')),
    route('/api/orchestrator/archive', 'GET', () => import('@/app/api/orchestrator/archive/route')),
    route('/api/mobile/orchestrator/threads', 'GET', () => import('@/app/api/mobile/orchestrator/threads/route')),
    route('/api/orchestrator/state', 'GET PATCH', () => import('@/app/api/orchestrator/state/route')),
    route('/api/orchestrator/shared-team/active', 'GET', () => import('@/app/api/orchestrator/shared-team/active/route')),
    route('/api/runtime/inventory', 'GET', () => import('@/app/api/runtime/inventory/route')),
    route('/api/mobile/history', 'GET', () => import('@/app/api/mobile/history/route')),
    route('/api/v2/chat-history', 'GET POST PATCH', () => import('@/app/api/v2/chat-history/route')),
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
    route('/api/runtime/action', 'POST', () => import('@/app/api/runtime/action/route')),
  ],
  brain: [route('/api/cortex/ask', 'POST', () => import('@/app/api/cortex/ask/route'))],
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
    route('/api/orchestrator/stop-mission', 'POST', () => import('@/app/api/orchestrator/stop-mission/route')),
    route('/api/orchestrator/discard-packet', 'POST', () => import('@/app/api/orchestrator/discard-packet/route')),
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
  ],
  workers: [
    route('/api/lanes', 'GET', () => import('@/app/api/lanes/route')),
    route('/api/lanes/[id]', 'GET', () => import('@/app/api/lanes/[id]/route')),
    route('/api/orchestrator/state', 'GET', () => import('@/app/api/orchestrator/state/route')),
    route('/api/orchestrator/lane-events', 'GET', () => import('@/app/api/orchestrator/lane-events/route')),
    route('/api/orchestrator/steer-packet', 'POST', () => import('@/app/api/orchestrator/steer-packet/route')),
  ],
  settings: [
    route('/api/cortex/codebase-memory', 'GET', () => import('@/app/api/cortex/codebase-memory/route')),
    route('/api/cortex/diagnostics', 'GET', () => import('@/app/api/cortex/diagnostics/route')),
    route('/api/runtime/acp-registry', 'GET', () => import('@/app/api/runtime/acp-registry/route')),
    route('/api/panel/o8-update-summary', 'GET', () => import('@/app/api/panel/o8-update-summary/route')),
    route('/api/panel/status', 'GET', () => import('@/app/api/panel/status/route')),
    route('/api/runtime/capabilities', 'GET', () => import('@/app/api/runtime/capabilities/route')),
    route('/api/runtime/capacity', 'GET', () => import('@/app/api/runtime/capacity/route')),
    route('/api/setup/cli-updates', 'GET', () => import('@/app/api/setup/cli-updates/route')),
    route('/api/panel/operator-defaults', 'GET POST', () => import('@/app/api/panel/operator-defaults/route')),
    route('/api/v2/keys', 'GET POST PATCH DELETE', () => import('@/app/api/v2/keys/route')),
    route('/api/cortex/reingest', 'POST', () => import('@/app/api/cortex/reingest/route')),
  ],
  setup: [
    route('/api/setup/cli-updates', 'GET', () => import('@/app/api/setup/cli-updates/route')),
    route('/api/setup/config', 'GET POST', () => import('@/app/api/setup/config/route')),
  ],
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
    route('/api/panel/commits/[hash]', 'GET', () => import('@/app/api/panel/commits/[hash]/route')),
    route('/api/orchestrator/review-state', 'GET', () => import('@/app/api/orchestrator/review-state/route')),
    route('/api/orchestrator/review', 'POST', () => import('@/app/api/orchestrator/review/route')),
    route('/api/lanes/[id]/diff', 'GET', () => import('@/app/api/lanes/[id]/diff/route')),
    route('/api/worktrees/diff', 'GET', () => import('@/app/api/worktrees/diff/route')),
    route('/api/review/last-turn', 'GET', () => import('@/app/api/review/last-turn/route')),
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
