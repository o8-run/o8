import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export async function prepare(): Promise<SurfaceRoutes> {
  if (process.argv.includes('--onboarding')) createRequire(import.meta.url)('./setup/discovery.cjs');
  return {};
}
export default async function register({ dataDir, repo, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--onboarding')) return {};
  for (const file of readdirSync(join(dataDir, 'chat-history'))) rmSync(join(dataDir, 'chat-history', file));
  seeds.splice(0);
  if (process.argv.includes('--onboarding-new-project')) {
    // New project's `gh repo create` runs a fake gh on PATH; HOME keeps its projects folder in the fixture.
    const home = join(dataDir, 'home');
    const bin = join(dataDir, 'bin');
    mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
    process.env.HOME = home;
    process.env.PATH = `${bin}:${process.env.PATH}`;
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(join(dataDir, 'gh-argv.jsonl'))}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
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
  return { priority: 5, admit: () => 200,
    run: async (route, request) => {
      const response = await route(request);
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
  } };
}
