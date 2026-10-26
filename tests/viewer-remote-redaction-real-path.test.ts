import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { viewerCredentialCorpus, knownViewerOperatorFixture, knownViewerDeviceFixture, knownViewerEnvironmentFixture } from './fixtures/viewer-credential-corpus';

vi.mock('@/lib/github-broker/env', async importOriginal => ({ ...await importOriginal<object>(), getGitHubAppConfig: () => null }));
vi.mock('@/lib/github-broker/managed', async importOriginal => ({ ...await importOriginal<object>(), readManagedGithubToken: () => ({ token: 'fixture-provider-scope', installationId: 5 }) }));
const originalFetch = globalThis.fetch;
let root: string;
let server: Server;
let origin: string;
const corpus = viewerCredentialCorpus.map(item => item.text).join('\n');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'o8-viewer-provider-'));
  vi.stubEnv('O8_VIEWER_FIXTURE_PASSWORD', knownViewerEnvironmentFixture);
  const { WS_TOKEN_PATH } = await import('@/lib/ws-auth');
  writeFileSync(WS_TOKEN_PATH, knownViewerOperatorFixture);
  const { writeActiveTokenHashes } = await import('@/lib/mobile/device-token-file');
  writeActiveTokenHashes([createHash('sha256').update(knownViewerDeviceFixture).digest('hex')]);
  writeFileSync(join(root, 'source.json'), JSON.stringify({ body: corpus, patch: corpus }));
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    if (url.hostname === '127.0.0.1') return originalFetch(input, init);
    const source = JSON.parse(readFileSync(join(root, 'source.json'), 'utf8'));
    if (url.pathname.endsWith('/files')) return Response.json([{ filename: 'control.txt', status: 'modified', additions: 1, deletions: 0, patch: source.patch }]);
    if (/\/pulls\/\d+$/.test(url.pathname)) return Response.json({ number: 1, title: 'fixture', body: source.body, state: 'open', html_url: 'https://example.invalid/pull/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', head: { sha: source.head ?? '1'.repeat(40), ref: 'fixture' }, base: { sha: '0'.repeat(40), ref: 'main' } });
    if (url.pathname.endsWith('/check-runs')) return Response.json({ check_runs: [] });
    return Response.json([]);
  });
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  server = createServer(async (req, res) => { if (!await handleNativeHttp(req, res)) res.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

describe('native remote viewer corpus from persisted provider state', () => {
  it.each(['/api/panel/prs/1', '/api/panel/pr'])('%s masks file patches and metadata through server and native HTTP', async route => {
    const url = new URL(route, origin); url.search = new URLSearchParams({ repo: 'example/widgets', number: '1' }).toString();
    const authorization = `Bearer ${knownViewerOperatorFixture}`;
    const handler = route.endsWith('/pr') ? (await import('@/app/api/panel/pr/route')).GET : (await import('@/app/api/panel/prs/[number]/route')).GET;
    const direct = await handler(new NextRequest(url, { headers: { authorization } }), { params: Promise.resolve({ number: '1' }) });
    for (const response of [direct, await fetch(url, { headers: { authorization } })]) {
      expect(response.status).toBe(200);
      const raw = await response.text(); const body = JSON.parse(raw);
      const strings: string[] = [];
      const visit = (value: unknown) => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
      visit(body);
      const leaked = viewerCredentialCorpus.find(item => raw.includes(item.clear) || strings.some(value => value.includes(item.clear)));
      expect(leaked?.name, 'response retained a corpus credential').toBeUndefined();
      expect(body.redaction).toMatchObject({ version: 1, offsetEncoding: 'utf-8' });
      expect(body.redaction.spans.length).toBeGreaterThan(0);
    }
    expect(JSON.parse(readFileSync(join(root, 'source.json'), 'utf8')).patch).toBe(corpus);
  });
  it.each(['+fixture-orphan-body\n', '@@ -4 +4 @\n+fixture-orphan-body\n'])('refuses an unverified patch even without a valid hunk heading', async patch => {
    writeFileSync(join(root, 'source.json'), JSON.stringify({ body: 'public', patch, head: (patch.startsWith('@@') ? '3' : '2').repeat(40) }));
    const url = new URL('/api/panel/prs/1?repo=example/widgets', origin);
    const authorization = `Bearer ${knownViewerOperatorFixture}`;
    const { GET } = await import('@/app/api/panel/prs/[number]/route');
    const direct = await GET(new NextRequest(url, { headers: { authorization } }), { params: Promise.resolve({ number: '1' }) });
    for (const response of [direct, await fetch(url, { headers: { authorization } })]) {
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body).includes('fixture-orphan-body')).toBe(false);
      expect(body.redaction.spans.length).toBeGreaterThan(0);
    }
  });

});
