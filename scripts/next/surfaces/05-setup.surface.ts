import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
import type { SetupRuntime } from '../../../src/lib/setup/runtime-recommendation';

/** `--onboarding-tools`: two ready tools, one that needs sign-in and two not installed. */
const FIXTURE_TOOLS: SetupRuntime[] = [
  { id: 'codex', label: 'Codex', available: true, installed: true, unavailableReason: null, detail: 'Ready', fix: '' },
  { id: 'claude-code', label: 'Claude Code', available: true, installed: true, unavailableReason: null, detail: 'Signed in on this computer.', fix: '' },
  { id: 'opencode', label: 'OpenCode', available: false, installed: true, unavailableReason: 'needs_auth', detail: 'OpenCode is installed but has no provider connected.', fix: 'Connect a provider in OpenCode, then refresh.' },
  { id: 'gemini', label: 'Gemini CLI', available: false, installed: false, unavailableReason: 'not_installed', detail: 'Gemini CLI was not found on this computer.', fix: '' },
  { id: 'antigravity', label: 'Antigravity CLI', available: false, installed: false, unavailableReason: 'not_installed', detail: 'Antigravity CLI was not found on this computer.', fix: '' },
];
/** `--onboarding-no-tools`: the same tools, none installed. */
const NO_TOOLS: SetupRuntime[] = FIXTURE_TOOLS.map((tool) => ({
  ...tool, available: false, installed: false, unavailableReason: 'not_installed',
  detail: `${tool.label} was not found on this computer.`, fix: '',
}));
/** `--onboarding-github`: a connected account's repositories, in GitHub's shape. */
const GITHUB_REPOS = [
  { id: 1, full_name: 'fixture-org/fixture-app', name: 'fixture-app', description: 'A public fixture project.', language: 'TypeScript', stargazers_count: 0, updated_at: '2026-11-01T00:00:00Z', private: false, default_branch: 'main', clone_url: 'https://github.com/fixture-org/fixture-app.git' },
  { id: 2, full_name: 'fixture-org/fixture-private', name: 'fixture-private', description: 'A private fixture project.', language: 'Rust', stargazers_count: 0, updated_at: '2026-11-01T00:00:00Z', private: true, default_branch: 'main', clone_url: 'https://github.com/fixture-org/fixture-private.git' },
  { id: 3, full_name: 'fixture-org/fixture-unreachable', name: 'fixture-unreachable', description: null, language: null, stargazers_count: 0, updated_at: '2026-11-01T00:00:00Z', private: false, default_branch: 'main', clone_url: 'https://github.com/fixture-org/fixture-unreachable.git' },
];
export async function prepare(): Promise<SurfaceRoutes> {
  if (process.argv.includes('--onboarding')) createRequire(import.meta.url)('./setup/discovery.cjs');
  return {};
}
export default async function register({ dataDir, repo, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--onboarding')) return {};
  for (const file of readdirSync(join(dataDir, 'chat-history'))) rmSync(join(dataDir, 'chat-history', file));
  seeds.splice(0);
  const github = process.argv.includes('--onboarding-github');
  const signedOut = process.argv.includes('--onboarding-github-signed-out');
  const unreachable = process.argv.includes('--onboarding-github-unreachable');
  if (process.argv.includes('--onboarding-new-project') || github || signedOut) {
    // New project's `gh repo create`, the GitHub list and clones run a fake gh on PATH; HOME keeps
    // projects and clones in the fixture.
    const home = join(dataDir, 'home');
    const bin = join(dataDir, 'bin');
    mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
    process.env.HOME = home;
    process.env.PATH = `${bin}:${process.env.PATH}`;
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(join(dataDir, 'gh-argv.jsonl'))}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'api') { process.stdout.write(${JSON.stringify(JSON.stringify(GITHUB_REPOS))}); process.exit(0); }
if (args[0] === 'repo' && args[1] === 'clone') {
  // The private one takes a while, so a check can see a clone in progress.
  if (args[2].includes('fixture-private')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  if (args[2].includes('fixture-unreachable')) { process.stderr.write('fatal: could not read from remote repository.\\n'); process.exit(1); }
  require('node:fs').mkdirSync(args[3], { recursive: true });
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: args[3] });
  require('node:child_process').execFileSync('git', ['remote', 'add', 'origin', args[2]], { cwd: args[3] });
  process.exit(0);
}
if (args[2] === 'taken-name') { process.stderr.write('GraphQL: Name already exists on this account (createRepository)\\n'); process.exit(1); }
const dest = require('node:path').join(process.cwd(), args[2]);
require('node:fs').mkdirSync(dest);
require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dest });
`);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(dataDir, 'ssh-machines.json'), JSON.stringify({ schema: 'o8/cli/machines/v1', machines: [{
      id: '00000000-0000-4000-8000-000000000001', label: 'build-box', target: 'build-box', port: 22,
      remoteCli: 'o8', sshConfig: null, enabled: true,
    }] }));
  }
  const { addRepo } = await import('../../../src/lib/repos/registry');
  await addRepo(repo);
  const defaults = await import('../../../src/app/api/panel/operator-defaults/route');
  const repos = await import('../../../src/app/api/panel/repos/route');
  const projects = await import('../../../src/app/api/panel/projects/route');
  const config = await import('../../../src/app/api/setup/config/route');
  const history = await import('../../../src/app/api/mobile/history/route');
  const context = await import('../../../src/app/api/v2/chat-history/route');
  const queue = await import('../../../src/app/api/orchestrator/composer-queue/route');
  const wsInfo = await import('../../../src/app/api/panel/ws-info/route');
  const machines = await import('../../../src/app/api/panel/ssh-machines/route');
  const { getAllRuntimes } = await import('../../../src/lib/runtimes');
  for (const runtime of getAllRuntimes()) runtime.discoverSessions = async () => [];
  const { GET: sessions } = await import('../../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: state } = await import('../../../src/app/api/orchestrator/state/route');
  const { GET: inventory } = await import('../../../src/app/api/runtime/inventory/route');
  const { recommendRuntimeSetup } = await import('../../../src/lib/setup/runtime-recommendation');
  return { priority: 5, admit: () => 200,
    run: async (route, request) => {
      const response = await route(request);
      // A fixed tool inventory, so setup's tool pages never read this machine's tools.
      const tools = process.argv.includes('--onboarding-no-tools') ? NO_TOOLS
        : process.argv.includes('--onboarding-tools') ? FIXTURE_TOOLS : null;
      if (tools && response.ok
        && request.method === 'GET' && request.nextUrl.pathname === '/api/panel/operator-defaults'
        && request.nextUrl.searchParams.get('include') === 'setup') {
        const payload = await response.json();
        payload.dispatchableRuntimes = tools;
        payload.setupRecommendation = recommendRuntimeSetup({
          inventory: tools, values: payload.values, sources: payload.sources,
          activity: { codex: 0, claude: 0, complete: false },
        });
        return Response.json(payload, { status: response.status, headers: response.headers });
      }
      if (process.argv.includes('--onboarding-empty-model') && response.ok
        && request.method === 'GET' && request.nextUrl.pathname === '/api/panel/operator-defaults'
        && request.nextUrl.searchParams.get('include') === 'setup') {
        const payload = await response.json();
        payload.setupRecommendation.leadModel = '';
        return Response.json(payload, { status: response.status, headers: response.headers });
      }
      return response;
    }, routes: {
    'GET /api/panel/repos': repos.GET, 'POST /api/panel/repos': repos.POST,
    'GET /api/panel/projects': projects.GET,
    'GET /api/panel/operator-defaults': defaults.GET, 'POST /api/panel/operator-defaults': defaults.POST,
    'GET /api/setup/config': config.GET, 'POST /api/setup/config': config.POST,
    'GET /api/mobile/history': history.GET, 'GET /api/v2/chat-history': context.GET,
    'POST /api/v2/chat-history': context.POST, 'GET /api/orchestrator/composer-queue': queue.GET,
    'POST /api/orchestrator/composer-queue': queue.POST, 'GET /api/panel/ws-info': wsInfo.GET,
    'GET /api/mobile/orchestrator/threads': sessions, 'GET /api/orchestrator/state': state,
    'GET /api/runtime/inventory': inventory, 'GET /api/panel/ssh-machines': machines.GET,
    // A fixed answer, so the fixture never reads this machine's GitHub sign-in.
    ...(github || signedOut ? { 'GET /api/panel/github-status': async () => Response.json({
      authenticated: github, username: github ? 'fixture' : '', repos: 0, deviceFlowEnabled: false,
    }) } : {}),
    // The status answer breaks off mid-body, as a dropped connection does.
    ...(unreachable ? { 'GET /api/panel/github-status': async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"authenti')); controller.error(new Error('dropped')); },
    }), { headers: { 'Content-Type': 'application/json' } }) } : {}),
  } };
}
