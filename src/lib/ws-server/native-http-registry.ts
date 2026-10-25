/** Shared shell transport registrations; importing this module loads no handlers or middleware. */
interface Route {
  path: string;
  methods: string[];
  load: () => Promise<unknown>;
}
const route = (path: string, methods: string, load: Route['load']): Route => ({ path, methods: methods.split(' '), load });

// Keys mirror register_surfaces!, including surfaces whose transport is WebSocket-only.
// Imports are lazy: flag-off startup never loads a surface's HTTP implementation.
export const nativeSurfaceRoutes: Record<string, Route[]> = {
  session: [
    route('/api/mobile/orchestrator/threads', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_mobile_orchestrator_threads)),
    route('/api/orchestrator/state', 'GET PATCH', () => import('./native-http-handlers').then(handlers => handlers.api_orchestrator_state)),
    route('/api/runtime/inventory', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_runtime_inventory)),
    route('/api/mobile/history', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_mobile_history)),
    route('/api/v2/chat-history', 'GET POST', () => import('./native-http-handlers').then(handlers => handlers.api_v2_chat_history)),
    route('/api/orchestrator/composer-queue', 'GET POST PATCH DELETE', () => import('./native-http-handlers').then(handlers => handlers.api_orchestrator_composer_queue)),
    route('/api/panel/ws-info', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_ws_info)),
  ],
  brain: [route('/api/cortex/ask', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_cortex_ask))],
  activity: [
    route('/api/panel/commits', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_commits)),
    route('/api/panel/ci', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_ci)),
    route('/api/panel/ci/[id]', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_ci_id)),
    route('/api/panel/pr', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_pr)),
    route('/api/orchestrator/stop-mission', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_orchestrator_stop_mission)),
  ],
  pull_requests: [
    route('/api/panel/prs', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_prs)),
    route('/api/panel/prs/[number]', 'GET POST', () => import('./native-http-handlers').then(handlers => handlers.api_panel_prs_number)),
    route('/api/panel/github-status', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_github_status)),
    route('/api/orchestrator/merge-preview', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_orchestrator_merge_preview)),
  ],
  grid: [],
  terminal: [route('/api/mobile/terminal-sessions', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_mobile_terminal_sessions))],
  palette: [], // Local commands and workspace navigation reuse the selected surface's transport.
  settings: [
    route('/api/panel/operator-defaults', 'GET POST', () => import('./native-http-handlers').then(handlers => handlers.api_panel_operator_defaults)),
    route('/api/v2/keys', 'GET POST PATCH DELETE', () => import('./native-http-handlers').then(handlers => handlers.api_v2_keys)),
  ],
  setup: [route('/api/setup/config', 'GET POST', () => import('./native-http-handlers').then(handlers => handlers.api_setup_config))],
  projects: [
    route('/api/panel/projects', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_projects)),
    route('/api/panel/projects/active', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_panel_projects_active)),
    route('/api/panel/projects/[id]', 'PATCH DELETE', () => import('./native-http-handlers').then(handlers => handlers.api_panel_projects_id)),
    route('/api/panel/repos', 'GET POST DELETE', () => import('./native-http-handlers').then(handlers => handlers.api_panel_repos)),
    route('/api/projects', 'GET POST', () => import('./native-http-handlers').then(handlers => handlers.api_projects)),
    route('/api/projects/[id]', 'PATCH DELETE', () => import('./native-http-handlers').then(handlers => handlers.api_projects_id)),
    route('/api/projects/[id]/repos', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_projects_id_repos)),
    route('/api/projects/[id]/repos/[repoId]', 'PATCH DELETE', () => import('./native-http-handlers').then(handlers => handlers.api_projects_id_repos_repoId)),
  ],
  issues: [
    route('/api/panel/issues', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_issues)),
    route('/api/panel/issues/create', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_panel_issues_create)),
    route('/api/panel/issues/enhance', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_panel_issues_enhance)),
    route('/api/panel/issues/[number]', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_issues_number)),
  ],
  inbox: [
    route('/api/panel/supervisor-inbox', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_supervisor_inbox)),
    route('/api/panel/approvals', 'GET POST', () => import('./native-http-handlers').then(handlers => handlers.api_panel_approvals)),
  ],
  diff: [
    route('/api/orchestrator/review-state', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_orchestrator_review_state)),
    route('/api/orchestrator/review', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_orchestrator_review)),
    route('/api/lanes/[id]/diff', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_lanes_id_diff)),
    route('/api/worktrees/diff', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_worktrees_diff)),
  ],
  customize: [
    route('/api/customize/inventory', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_customize_inventory)),
    route('/api/cortex/directives', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_cortex_directives)),
    route('/api/setup/mcp-servers', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_setup_mcp_servers)),
    route('/api/prompt-library', 'GET POST', () => import('./native-http-handlers').then(handlers => handlers.api_prompt_library)),
    route('/api/prompt-library/[id]', 'GET PATCH DELETE', () => import('./native-http-handlers').then(handlers => handlers.api_prompt_library_id)),
  ],
};

// Authoritative producers requested by the existing WS checkpoint/command path.
const producers = [
  route('/api/panel/status', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_panel_status)),
  route('/api/setup/identity', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_setup_identity)),
  route('/api/mobile/sync', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_mobile_sync)),
  route('/api/mobile/inbox', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_mobile_inbox)),
  route('/api/command-center/snapshot', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_command_center_snapshot)),
  route('/api/browser/inventory', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_browser_inventory)),
  route('/api/runtime/transcript', 'GET', () => import('./native-http-handlers').then(handlers => handlers.api_runtime_transcript)),
  route('/api/runtime/action', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_runtime_action)),
  route('/api/runtime/launch', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_runtime_launch)),
  route('/api/orchestrator/headless-tick', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_orchestrator_headless_tick)),
  route('/api/review/auto-review', 'POST', () => import('./native-http-handlers').then(handlers => handlers.api_review_auto_review)),
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
