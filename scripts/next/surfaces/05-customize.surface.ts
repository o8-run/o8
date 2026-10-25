import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { SurfaceContext, SurfaceRoutes, Route } from '../surface-routes';

export async function prepare({ root }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.some(arg => arg.startsWith('--customize'))) return {};
  const profile = join(root, 'profile');
  mkdirSync(profile);
  Object.defineProperty(os, 'homedir', { value: () => profile });
  syncBuiltinESMExports();
  return {};
}
export default async function register({ dataDir, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.some(arg => arg.startsWith('--customize'))) return {};
  const { addRepo } = await import('../../../src/lib/repos/registry');
  await addRepo(repo);
  for (const [base, name] of [[os.homedir(), 'Personal'], [repo, 'Fixture']]) {
    mkdirSync(join(base, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(base, '.agents', 'skills', 'fixture'), { recursive: true });
    writeFileSync(join(base, '.claude', 'agents', 'fixture.md'), `---\nname: ${name} agent\ndescription: ${name} guidance\n---\nRead files.`);
    writeFileSync(join(base, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'fixture-hook --token fixture-sensitive-value' }] }] } }));
    writeFileSync(join(base, '.agents', 'skills', 'fixture', 'SKILL.md'), `---\nname: ${name} skill\ndescription: Read-only fixture skill\n---\nRead files.`);
  }
  mkdirSync(join(dataDir, 'directives'), { recursive: true });
  writeFileSync(join(dataDir, 'directives', 'fixture.md'), '---\nid: fixture\ntitle: Fixture instruction\nscope: global\n---\nFixture instruction body.');
  const inventory = await import('../../../src/app/api/customize/inventory/route');
  const directives = await import('../../../src/app/api/cortex/directives/route');
  const connections = await import('../../../src/app/api/setup/mcp-servers/route');
  const { insertExternalMcpServer } = await import('../../../src/lib/mcp/external-servers');
  insertExternalMcpServer({ name: 'Fixture MCP', transport: 'http', command: 'https://fixture-user:fixture-sensitive-value@fixture.example/mcp?token=fixture-sensitive-value', args: [], env: null, enabled: true });
  const prompts = await import('../../../src/app/api/prompt-library/route');
  const entry = await import('../../../src/app/api/prompt-library/[id]/route');
  const repos = await import('../../../src/app/api/panel/repos/route');
  const { panelGateMiddleware } = await import('../../../src/middleware');
  const gets: Record<string, Route> = {
    '/api/panel/repos': repos.GET, '/api/customize/inventory': inventory.GET,
    '/api/cortex/directives': directives.GET, '/api/setup/mcp-servers': connections.GET,
    '/api/prompt-library': prompts.GET,
  };
  return { priority: 5, admit: () => 200,
    run: async (route, request) => {
      if (process.argv.includes('--customize-denied')) {
        const headers = new Headers(request.headers);
        headers.delete('authorization');
        const unauthenticated = new NextRequest(request, { headers });
        const gate = panelGateMiddleware(unauthenticated);
        return gate.status === 200 ? route(unauthenticated) : gate;
      }
      return route(request);
    },
    match: (method, pathname) => {
      const id = pathname.match(/^\/api\/prompt-library\/([^/]+)$/)?.[1];
      if (id && method === 'GET') return request => entry.GET(request, { params: Promise.resolve({ id }) });
      if (id && method === 'PATCH') return request => entry.PATCH(request, { params: Promise.resolve({ id }) });
      if (id && method === 'DELETE') return request => entry.DELETE(request, { params: Promise.resolve({ id }) });
      return method === 'GET' ? gets[pathname] : method === 'POST' && pathname === '/api/prompt-library' ? prompts.POST : undefined;
    },
  };
}
