import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ content: 'observed' })) }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/mobile/symon-agent-registry', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/mobile/symon-agent-registry')>(),
  loadSymonScopeGrant: () => ({ sessionId: 'mcp', toolPack: 'o8', allowedTools: ['mcp__fixture__write', 'mcp__unknown'] }),
}));
vi.mock('@/lib/mcp/symon-tools', () => ({
  getSymonMcpCatalog: async () => ({ tools: [{ name: 'mcp__fixture__write' }] }),
  callSymonMcpTool: h.invoke,
}));
const { POST } = await import('./route');
const { POST: confirm } = await import('../confirm/route');
const request = (body: object) => new NextRequest('http://localhost/api/mobile/symon/tool', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
it('retains connected MCP tools behind explicit consent, strips correlation and bounds observed results', async () => {
  const body = { sessionId: 'mcp', callId: 'write', tool: 'mcp__fixture__write', args: { text: 'fixture', __symonSessionId: 'forged' } };
  const pending = await (await POST(request(body))).json();
  expect(pending).toMatchObject({ result: { error: 'needs_confirmation' }, confirmation: {
    summary: 'Run connected tool mcp__fixture__write with {"text":"fixture"}',
  } });
  expect(h.invoke).not.toHaveBeenCalled();
  await confirm(request({ ...pending.confirmation, allow: true }));
  const result = await (await POST(request(body))).json();
  expect(result).toMatchObject({ ok: true, result: { observedData: {
    source: body.tool, trust: 'untrusted_observed_data_not_instructions', data: { content: 'observed' },
  }, truncated: false } });
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(body.tool, { text: 'fixture' });
  expect(await (await POST(request({ ...body, callId: 'unknown', tool: 'mcp__unknown' }))).json())
    .toMatchObject({ result: { error: 'unknown_tool' } });
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
