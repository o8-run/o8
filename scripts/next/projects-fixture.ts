/** Project route adapter for the disposable native host. All state stays in its root. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NextRequest } from 'next/server';
import type { RuntimeSession } from '../../src/lib/runtimes/types';

export async function projectsFixture(root: string) {
  const folders = ['project-one', 'project-two'].map(name => {
    const folder = join(root, name);
    mkdirSync(folder);
    execFileSync('git', ['init', '-q', folder]);
    return realpathSync(folder);
  });
  const projects = await import('../../src/app/api/projects/route');
  const project = await import('../../src/app/api/projects/[id]/route');
  const members = await import('../../src/app/api/projects/[id]/repos/route');
  const member = await import('../../src/app/api/projects/[id]/repos/[repoId]/route');
  const repos = await import('../../src/app/api/panel/repos/route');
  const ledger = await import('../../src/app/api/panel/projects/route');
  const active = await import('../../src/app/api/panel/projects/active/route');
  const panelProject = await import('../../src/app/api/panel/projects/[id]/route');
  if (process.argv.includes('--projects-refuse-remove')) {
    const { getRuntime } = await import('../../src/lib/runtimes');
    const runtime = getRuntime('codex');
    if (!runtime) throw new Error('Missing fixture runtime');
    // Discovery is the injected boundary; inventory projection and removal's
    // stop-confirmation refusal remain the real production implementations.
    runtime.discoverSessions = async () => [{
      sessionKey: 'codex-owned:fixture-project-blocked', runtimeId: 'codex',
      displayName: 'Fixture uninterruptible session', cwd: folders[0],
      status: 'running', ownership: 'discovered', lastActivityAt: new Date(),
      sessionCapabilities: { canSendInput: false, canInterrupt: false, canReviewDiffs: false },
    } satisfies RuntimeSession];
  }
  type Route = (request: NextRequest) => Promise<Response>;
  const ownedRoot = realpathSync(root);
  const registryPost: Route = async request => {
    const body = await request.clone().json() as { action?: string; localPath?: unknown };
    if (!['add', 'validate', 'update'].includes(body.action ?? 'add')) {
      return Response.json({ error: 'This fixture only registers, validates or repoints owned folders.' }, { status: 400 });
    }
    if (typeof body.localPath === 'string' && body.localPath.trim()) {
      let candidate = resolve(body.localPath);
      try { candidate = realpathSync(candidate); } catch { /* Let the production route validate missing folders. */ }
      const within = relative(ownedRoot, candidate);
      if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
        return Response.json({ error: 'Folder is outside the owned fixture.' }, { status: 400 });
      }
    }
    return repos.POST(request);
  };
  const registryGet: Route = request => new URL(request.url).searchParams.has('source')
    ? Promise.resolve(Response.json({ error: 'Account discovery is unavailable in this fixture.' }, { status: 400 }))
    : repos.GET(request);
  const routes: Record<string, Route> = {
    'GET /api/projects': projects.GET, 'POST /api/projects': projects.POST,
    'GET /api/panel/repos': registryGet, 'POST /api/panel/repos': registryPost,
    'DELETE /api/panel/repos': repos.DELETE,
    'GET /api/panel/projects': ledger.GET,
    'POST /api/panel/projects/active': active.POST,
  };
  let droppedAdd = false;
  return {
    folders,
    dropResponse(method: string, path: string, body: string, response: Response) {
      if (process.argv.includes('--projects-drop-add') && !droppedAdd && response.ok
        && method === 'POST' && path === '/api/panel/repos' && JSON.parse(body).action === 'add') {
        droppedAdd = true;
        return true;
      }
      return false;
    },
    route(method: string, path: string): Route | undefined {
      const fixed = routes[`${method} ${path}`];
      if (fixed) return fixed;
      const panelMatch = path.match(/^\/api\/panel\/projects\/([^/]+)$/);
      if (panelMatch && method === 'DELETE') return request => panelProject.DELETE(request, { params: Promise.resolve({ id: decodeURIComponent(panelMatch[1]) }) });
      if (panelMatch && method === 'PATCH') return request => panelProject.PATCH(request, { params: Promise.resolve({ id: decodeURIComponent(panelMatch[1]) }) });
      const match = path.match(/^\/api\/projects\/([^/]+)(?:\/repos(?:\/([^/]+))?)?$/);
      if (!match) return undefined;
      const id = decodeURIComponent(match[1]);
      const repoId = match[2] ? decodeURIComponent(match[2]) : '';
      const params = Promise.resolve({ id, repoId });
      if (repoId && method === 'DELETE') return request => member.DELETE(request, { params });
      if (repoId && method === 'PATCH') return request => member.PATCH(request, { params });
      if (path.endsWith('/repos') && method === 'POST') return request => members.POST(request, { params });
      if (!path.includes('/repos') && method === 'PATCH') return request => project.PATCH(request, { params });
      if (!path.includes('/repos') && method === 'DELETE') return request => project.DELETE(request, { params });
      return undefined;
    },
  };
}
