import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';

// With the native transport on, Next hands o8_device to the WS owner (#5422).
// A large result must page in Next, where o8_result_page will look for it.
afterEach(() => vi.unstubAllEnvs());

it('pages a large owner result in Next so its continuation resolves there', async () => {
  const marker = 'device-snapshot-line';
  const snapshot = Array.from({ length: 2_000 }, (_, index) => `${marker} ${index}`).join('\n');
  const received: Array<{ path?: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const owner = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: { content: [{ type: 'text', text: snapshot }] } }));
    });
  });
  await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', String((owner.address() as AddressInfo).port));
  try {
    const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
    const context = { conversation: 'fixture-thread', worker: 'fixture-worker', pid: process.pid };
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, 'devices', context);
      const result = response?.result as { content?: Array<{ type: string; text?: string }> } | undefined;
      const part = result?.content?.[0];
      return part?.text ?? '';
    };
    const first = JSON.parse(await call(1, 'o8_device', { action: 'snapshot', deviceId: 'fixture-device' }));
    expect(first.nextArguments).toBeTruthy();
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/api/devices/owner');
    expect(received[0].body).toEqual({ args: { action: 'snapshot', deviceId: 'fixture-device' }, context });
    expect(received[0].headers.authorization).toMatch(/^Bearer /);
    let text = '';
    let next: unknown = first.nextArguments;
    for (let page = 0; next && page < 20; page += 1) {
      const value = JSON.parse(await call(2 + page, 'o8_result_page', next as Record<string, unknown>));
      expect(value.error ?? null).toBeNull();
      text += value.text ?? value.content ?? '';
      next = value.nextArguments;
    }
    expect(text).toContain(`${marker} 1999`);
    // Continuations come from Next's cache; the owner ran the action once.
    expect(received).toHaveLength(1);
  } finally {
    await new Promise<void>(resolve => owner.close(() => resolve()));
  }
});
