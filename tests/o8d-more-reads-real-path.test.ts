import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-more-reads-'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('O8_DATA_DIR', directory);
// The operator credential is a startup prerequisite, not state owned by GET.
vi.stubEnv('WS_TOKEN', 'more-reads-fixture-credential');
const fetcher = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetcher);
const { GET } = await import('@/app/api/runtime/acp-registry/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function request(refresh = false) {
  return new NextRequest(`http://fixture.invalid/api/runtime/acp-registry${refresh ? '?refresh=1' : ''}`, {
    headers: { authorization: 'Bearer more-reads-fixture-credential' },
  });
}

function catalog(version: string) {
  return Response.json({ agents: [{ id: 'fixture-agent', name: 'Fixture agent', version,
    distribution: { npx: { package: `fixture-agent@${version}`, args: [] } } }] });
}

it('registers the production ACP GET for the native settings caller', async () => {
  const route = nativeSurfaceRoutes.settings.find(route => route.path === '/api/runtime/acp-registry');
  expect(route, 'ACP settings GET registration').toBeDefined();
  expect(route!.methods).toEqual(['GET']);
  expect(await route!.load()).toMatchObject({ GET });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/runtime/acp-registry', method)).toBeUndefined();
  }
  for (const path of ['/api/setup/detect', '/api/review/push']) {
    expect(matchNativeHttpRoute(path), path).toBeUndefined();
  }
});

it('reads and refreshes the public ACP catalog on a cold data dir without creating state', async () => {
  expect(readdirSync(directory)).toEqual([]);
  fetcher.mockResolvedValueOnce(catalog('1.0.0'));
  const first = await GET(request());
  expect(first.status).toBe(200);
  const original = await first.json();
  expect(original).toMatchObject({ stale: false, agents: [{ id: 'fixture-agent', version: '1.0.0' }] });
  expect(readdirSync(directory)).toEqual([]);

  const cached = await GET(request());
  expect(await cached.json()).toEqual(original);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(catalog('2.0.0'));
  const refreshed = await GET(request(true));
  expect(await refreshed.json()).toMatchObject({ stale: false, agents: [{ version: '2.0.0' }] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).toBe('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json');
    expect(options).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(options?.headers).toBeUndefined();
  }
  expect(readdirSync(directory)).toEqual([]);

  fetcher.mockRejectedValueOnce(new Error('fixture offline'));
  const stale = await GET(request(true));
  expect(await stale.json()).toMatchObject({ stale: true, agents: [{ version: '2.0.0' }] });
  expect(readdirSync(directory)).toEqual([]);
});
