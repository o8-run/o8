import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';

const local = vi.hoisted(() => vi.fn());
vi.mock('@/lib/llm/proxy-route', () => ({ POST: local }));
import { POST } from '@/app/api/v2/proxy/llm/route';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('forwards body and conversation context without initializing the local handler', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response('data: first\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetcher);
  const body = JSON.stringify({ model: 'fixture', provider: 'openai', messages: [] });
  const response = await POST(new NextRequest('http://localhost/api/v2/proxy/llm', { method: 'POST',
    headers: { authorization: 'Bearer fixture', cookie: 'o8-token=session', 'x-tab-id': 'tab',
      'x-cortex-repo-path': '/fixture', 'x-o8-client-addr': 'remote', 'x-o8d-peer': '127.0.0.1' }, body }));
  expect(local).not.toHaveBeenCalled();
  const init = fetcher.mock.calls[0][1] as RequestInit;
  const headers = new Headers(init.headers);
  expect(headers.get('x-tab-id')).toBe('tab');
  expect(headers.get('x-cortex-repo-path')).toBe('/fixture');
  expect(headers.get('cookie')).toBe('o8-token=session');
  expect(headers.get('authorization')).toBe('Bearer fixture');
  expect(headers.get('x-o8-relay-forward')).toBe('1');
  expect(headers.has('x-o8-client-addr')).toBe(false);
  expect(headers.has('x-o8d-peer')).toBe(false);
  expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
  expect(await response.text()).toBe('data: first\n\n');
});
it('forwards every state-sharing sibling without loading local handlers', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  for (const [path, module, methods] of [
    ['/api/panel/models/chatgpt', () => import('@/app/api/panel/models/chatgpt/route'), ['GET', 'POST', 'DELETE']],
    ['/api/panel/approvals', () => import('@/app/api/panel/approvals/route'), ['GET', 'POST']],
    ['/api/mobile/action', () => import('@/app/api/mobile/action/route'), ['POST']],
  ] as const) {
    const handlers: Partial<Record<'GET' | 'POST' | 'DELETE', (request: Request) => Promise<Response>>> = await module();
    for (const method of methods) {
      const handler = handlers[method]!;
      expect((await handler(new NextRequest(`http://localhost${path}`, { method,
        headers: { authorization: 'Bearer fixture', 'x-clerk-session-token': 'fixture-session', 'x-o8-agent-tool': '1' },
        ...(method === 'GET' ? {} : { body: '{}' }) }))).status).toBe(200);
    }
  }
  expect(fetcher).toHaveBeenCalledTimes(6);
});
