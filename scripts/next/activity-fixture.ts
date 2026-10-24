/** Disposable Activity transport. Production handlers own auth, mapping and writes;
 * only the upstream GitHub transport is authored. No account or network access. */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { NextRequest } from 'next/server';

export async function installActivityFixture(repo: string) {
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'fixture@example.test']);
  writeFileSync(join(repo, 'activity.txt'), 'Fixture activity\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'Fixture local commit']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/activity.git']);
  const { addRepo } = await import('../../src/lib/repos/registry');
  await addRepo(repo);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GITHUB_API_BASE_URL: 'http://activity-upstream.invalid' });
  const originalFetch = globalThis.fetch;
  const token = randomBytes(32).toString('hex');
  let mode = 'ready';
  let dropped = false;
  const mutations: string[] = [];
  const calls: string[] = [];
  const date = '2026-10-24T12:00:00Z';
  const pull = { id: 71, number: 7, title: 'Fixture pull request', state: 'open', user: { login: 'fixture' },
    html_url: 'https://github.com/example/activity/pull/7', created_at: date, updated_at: date, body: 'Fixture PR body',
    head: { ref: 'fixture', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) }, additions: 2, deletions: 1, changed_files: 1 };
  const run = { id: 91, display_title: 'Fixture failing CI', name: 'Checks', head_branch: 'fixture', head_sha: 'c'.repeat(40),
    status: 'completed', conclusion: 'failure', created_at: date, pull_requests: [{ number: 7, html_url: pull.html_url }] };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'http://activity-upstream.invalid') {
      if (url.hostname === '127.0.0.1' || url.hostname === '[::1]') return originalFetch(input, init);
      throw new Error('Activity fixture refuses external traffic');
    }
    const path = url.pathname; calls.push(path);
    if (path.endsWith('/installation')) return Response.json({ id: mode === 'refused' ? 2 : mode === 'malformed' ? 3 : 1 });
    if (path.endsWith('/access_tokens')) return Response.json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (mode === 'refused') return Response.json({ message: 'Fixture rate limit' }, { status: 429, headers: { 'Retry-After': '300' } });
    if (path.endsWith('/actions/runs/91/jobs')) return Response.json({ jobs: [{ id: 92, name: 'Typecheck', conclusion: 'failure', steps: [{ name: 'Compile', conclusion: 'failure' }] }] });
    if (path.endsWith('/actions/runs/91')) return Response.json(mode === 'malformed' ? { ...run, id: 999 } : run);
    if (path.endsWith('/actions/runs')) return Response.json({ workflow_runs: mode === 'empty' ? [] : [{ ...run, head_sha: mode === 'prefix' ? 'd'.repeat(40) : run.head_sha }] });
    if (path.endsWith('/commits')) return Response.json(mode === 'empty' ? [] : [{ sha: 'd'.repeat(40), commit: { message: 'Fixture remote commit', committer: { date } } }]);
    if (path.endsWith('/pulls/7')) return Response.json(pull);
    if (path.endsWith('/pulls/7/files')) return Response.json([{ filename: 'activity.txt', additions: 2, deletions: 1 }]);
    if (path.endsWith('/pulls')) return Response.json(url.searchParams.get('state') === 'closed' || mode === 'empty' ? [] : [pull]);
    if (path.endsWith('/issues')) return Response.json(url.searchParams.get('state') === 'closed' || mode === 'empty' ? [] : [{ id: 81, number: 8, title: 'Fixture issue', state: 'open', body: 'Fixture issue body', html_url: 'https://github.com/example/activity/issues/8', user: { login: 'fixture' }, labels: [], assignees: [], comments: 0, created_at: date, updated_at: date }]);
    if (path.endsWith('/stack')) return Response.json({}, { status: 404 });
    if (path.endsWith('/status')) return Response.json({ statuses: [] });
    if (path.endsWith('/check-runs')) return Response.json({ check_runs: [] });
    return Response.json([]);
  };
  const { createLane, setLaneStatus, updateLane } = await import('../../src/lib/lane/registry');
  const { createEmptyOrchestratorMissionState } = await import('../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../src/lib/orchestrator/control-plane');
  const { id: laneId } = createLane({ repoPath: repo, branch: 'fixture', runtime: 'codex', packetId: 'activity-packet', sessionKey: 'llm-chat:thoughts-review' });
  setLaneStatus(laneId, 'reviewing', 'system', 'fixture_ready');
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'activity-mission', repoPath: repo,
    packets: [{ id: 'activity-queued', referenceLabel: 'A0', title: 'Queued fixture', summary: 'Queued fixture summary', workspaceTargetPath: repo, branchTarget: 'fixture', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'idle', blockedReason: null, lane: null, review: null, attemptCount: 0 }, { id: 'activity-packet', referenceLabel: 'A1', title: 'Fixture packet', summary: 'Fixture packet summary',
      workspaceTargetPath: repo, branchTarget: 'fixture', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: 'awaiting_review', blockedReason: null, lane: null, review: null, attemptCount: 1 }], updatedAt: date });
  const commits = await import('../../src/app/api/panel/commits/route');
  const prs = await import('../../src/app/api/panel/prs/route');
  const issues = await import('../../src/app/api/panel/issues/route');
  const ci = await import('../../src/app/api/panel/ci/route');
  const detail = await import('../../src/app/api/panel/ci/[id]/route');
  const pr = await import('../../src/app/api/panel/pr/route');
  const repos = await import('../../src/app/api/panel/repos/route');
  const state = await import('../../src/app/api/orchestrator/state/route');
  const stop = await import('../../src/app/api/orchestrator/stop-mission/route');
  const routes: Record<string, (request: NextRequest) => Promise<Response>> = {
    'GET /api/panel/commits': commits.GET, 'GET /api/panel/prs': prs.GET, 'GET /api/panel/issues': issues.GET,
    'GET /api/panel/ci': ci.GET, 'GET /api/panel/pr': pr.GET, 'GET /api/panel/repos': repos.GET,
    'GET /api/panel/ci/91': request => detail.GET(request, { params: Promise.resolve({ id: '91' }) }),
    'PATCH /api/orchestrator/state': state.PATCH, 'POST /api/orchestrator/stop-mission': stop.POST,
    'GET /api/activity-fixture': async request => {
      mode = request.nextUrl.searchParams.get('mode') ?? mode;
      if (mode === 'drop-stop' || mode === 'stop-ready') updateLane(laneId, { sessionKey: null });
      if (request.nextUrl.searchParams.has('mode')) {
        const { invalidate } = await import('../../src/lib/github/cache'); invalidate('');
        const { invalidateGitHubSync } = await import('../../src/lib/github-broker/store');
        invalidateGitHubSync('example/activity', 'issues'); invalidateGitHubSync('example/activity', 'pull_requests');
      }
      return Response.json({ mode, calls, repo, laneId, mutations });
    },
  };
  // The operator token is still required by the host middleware for every route.
  return { routes, dropResponse(method: string | undefined, path: string, body: string, response: Response) {
    if (method === 'POST' && path === '/api/orchestrator/stop-mission') {
      mutations.push(body);
      if (mode === 'drop-stop' && response.ok && !dropped) { dropped = true; return true; }
    }
    return false;
  } };
}
