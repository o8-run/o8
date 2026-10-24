import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const modulePath = '@/app/syntax/[kind]/[version]/[name]/route';
const params = (kind: string, version: string, name: string) => ({ params: Promise.resolve({ kind, version, name }) });
const request = (path: string) => new Request(`http://localhost${path}`);
afterEach(() => vi.unstubAllGlobals());

it('serves a pinned optional grammar through a same-origin module URL compatible with desktop CSP', async () => {
  const { GET } = await import(modulePath);
  const source = readFileSync(resolve('node_modules/@shikijs/langs/dist/scala.mjs'), 'utf8');
  const upstream = vi.fn(async () => new Response(source));
  vi.stubGlobal('fetch', upstream);
  const path = '/syntax/langs/4.5.0/scala.mjs';
  const response = await GET(request(path), params('langs', '4.5.0', 'scala.mjs'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('javascript');
  expect(response.headers.get('cache-control')).toContain('immutable');
  expect(await response.text()).toBe(source);
  expect(upstream).toHaveBeenCalledWith('https://cdn.jsdelivr.net/npm/@shikijs/langs@4.5.0/dist/scala.mjs', expect.objectContaining({ cache: 'no-store', redirect: 'error' }));
  const csp = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8')).app.security.csp as string;
  expect(csp).toContain("script-src 'self'");
  expect(new URL(path, request(path).url).origin).toBe(new URL(request(path).url).origin);
});

it('preserves relative imports for grammars with embedded languages', async () => {
  const { GET } = await import(modulePath);
  const upstream = vi.fn(async (url: string) => new Response(readFileSync(resolve(
    'node_modules/@shikijs/langs/dist', new URL(url).pathname.split('/').pop()!,
  ), 'utf8')));
  vi.stubGlobal('fetch', upstream);
  const path = '/syntax/langs/4.5.0/vue.mjs';
  const response = await GET(request(path), params('langs', '4.5.0', 'vue.mjs'));
  const source = await response.text();
  const imports = [...source.matchAll(/from ['"](.+?\.mjs)['"]/g)].map(match => match[1]);
  expect(imports.length).toBeGreaterThan(0);
  for (const dependency of imports) {
    const url = new URL(dependency, request(path).url);
    expect(url.origin).toBe(new URL(request(path).url).origin);
    const name = url.pathname.split('/').pop()!;
    const child = await GET(new Request(url), params('langs', '4.5.0', name));
    expect(child.status, name).toBe(200);
    expect(await child.text()).toBe(readFileSync(resolve('node_modules/@shikijs/langs/dist', name), 'utf8'));
  }
});

it.each([
  ['other', '4.5.0', 'scala.mjs'], ['langs', 'latest', 'scala.mjs'],
  ['langs', '4.5.0', '../package.json'], ['langs', '4.5.0', 'unknown.mjs'],
  ['themes', '4.5.0', 'nord.js'],
])('rejects unknown syntax asset coordinates %s %s %s without a fetch', async (kind, version, name) => {
  const { GET } = await import(modulePath);
  const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
  const response = await GET(request('/syntax/fixture'), params(kind, version, name));
  expect(response.status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});

it('does not cache an upstream failure and lets the existing view retry', async () => {
  const { GET } = await import(modulePath);
  const upstream = vi.fn().mockRejectedValueOnce(new Error('fixture offline')).mockResolvedValueOnce(new Response('export default [];'));
  vi.stubGlobal('fetch', upstream);
  const path = '/syntax/themes/4.5.0/nord.mjs';
  expect((await GET(request(path), params('themes', '4.5.0', 'nord.mjs'))).status).toBe(502);
  expect((await GET(request(path), params('themes', '4.5.0', 'nord.mjs'))).status).toBe(200);
});

it('serves attempt directories while keeping embedded grammar imports in that attempt', async () => {
  const retryModulePath = '@/app/syntax/attempt/[attempt]/[kind]/[version]/[name]/route';
  const { GET } = await import(retryModulePath);
  const source = readFileSync(resolve('node_modules/@shikijs/langs/dist/vue.mjs'), 'utf8');
  const upstream = vi.fn(async () => new Response(source));
  vi.stubGlobal('fetch', upstream);
  const path = '/syntax/attempt/attempt-fixture/langs/4.5.0/vue.mjs';
  const context = { params: Promise.resolve({ kind: 'langs', version: '4.5.0', attempt: 'attempt-fixture', name: 'vue.mjs' }) };
  const response = await GET(request(path), context);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(source);
  expect(upstream).toHaveBeenCalledWith('https://cdn.jsdelivr.net/npm/@shikijs/langs@4.5.0/dist/vue.mjs', expect.anything());
  const dependencies = [...source.matchAll(/from ['"](.+?\.mjs)['"]/g)];
  expect(dependencies.length).toBeGreaterThan(0);
  for (const dependency of dependencies) {
    expect(new URL(dependency[1], request(path).url).pathname).toContain('/syntax/attempt/attempt-fixture/langs/4.5.0/');
  }
});
