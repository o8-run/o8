import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/mcp/route';

const repo = '/fixture/page-audit';

async function call(name: string, args: Record<string, unknown>, profile?: string) {
  const response = await POST(new Request('http://localhost/api/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(profile ? { 'x-o8-mcp-profile': profile } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const rpc = await response.json();
  return { result: rpc.result, bytes: Buffer.byteLength(JSON.stringify(rpc)),
    payload: (() => { try { return JSON.parse(rpc.result.content[0].text); } catch { return null; } })() };
}

afterEach(() => vi.restoreAllMocks());

describe('large results through the MCP HTTP entry point', () => {
  it('pages a normal large read losslessly and never repeats its source call', async () => {
    const note = '# Operator note\n' + 'Check "quoted" paths \\ and unicode 🧭\n'.repeat(1800);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ agents: [], note }));
    let page = await call('o8_msg_agents', { repo });
    expect(page.bytes).toBeLessThanOrEqual(20_000);
    expect(page.payload.schema).toBe('o8/mcp/result-page/v1');
    expect(page.payload.summary).toContain('saved result');
    let serialized = '';
    let pages = 0;
    for (;;) {
      expect(page.bytes).toBeLessThanOrEqual(20_000);
      expect(page.result.isError).not.toBe(true);
      serialized += page.payload.text;
      pages += 1;
      if (!page.payload.nextArguments) break;
      expect(pages).toBeLessThan(100);
      page = await call('o8_result_page', page.payload.nextArguments);
    }
    expect(pages).toBeGreaterThan(1);
    const original = JSON.parse(serialized);
    expect(JSON.parse(original.content[0].text).note).toBe(note);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps small results in their existing shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ agents: [] }));
    const response = await call('o8_msg_agents', { repo });
    expect(response.payload).toMatchObject({ agents: [] });
    expect(response.payload.schema).toBeUndefined();
  });

  it('leaves room for the JSON-RPC envelope near the wire-size limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: 'x'.repeat(19_890) }));
    const response = await call('o8_msg_agents', { repo });
    expect(response.bytes).toBeLessThanOrEqual(20_000);
    expect(response.payload.schema).toBe('o8/mcp/result-page/v1');
  });

  it('reads a large mutation receipt without applying the mutation twice', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      ok: true, taskId: 'fixture-task', summary: 'Preserve this requirement.\n'.repeat(1800),
    }));
    const first = await call('o8_adopt_pr', { repoPath: repo, pullRequest: 7 });
    expect(first.payload.nextArguments).toBeDefined();
    await call('o8_result_page', first.payload.nextArguments);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBe('POST');
  });

  it('rejects an unavailable saved result without invoking a handler', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await call('o8_result_page', { resultId: 'unavailable', offset: 0 });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toBe('Saved result unavailable or expired. Rerun a read-only source call; check status before retrying a mutation.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cannot use a saved result to expand a narrowed tool profile', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ agents: [], note: 'Long note.\n'.repeat(2000) }));
    const first = await call('o8_msg_agents', { repo });
    expect(first.payload.nextArguments).toBeDefined();
    const response = await call('o8_result_page', first.payload.nextArguments, 'visualizations');
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Saved result unavailable');
  });

  it('expires saved results with a corrective error and no source retry', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ agents: [], note: 'Long note.\n'.repeat(2000) }));
    const first = await call('o8_msg_agents', { repo });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1);
    const expired = await call('o8_result_page', first.payload.nextArguments);
    expect(expired.result.isError).toBe(true);
    expect(expired.result.content[0].text).toContain('Saved result unavailable or expired');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the failure flag while paging a large structured gate refusal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      error: 'Gate blocked', checks: Array.from({ length: 300 }, (_, i) => ({ name: `check-${i}`, detail: 'Check the source input before approval.'.repeat(4) })),
    }, { status: 409 }));
    const first = await call('o8_merge_preview', { packetId: 'audit' });
    expect(first.bytes).toBeLessThanOrEqual(20_000);
    expect(first.result.isError).toBe(true);
    const next = await call('o8_result_page', first.payload.nextArguments);
    expect(next.result.isError).toBe(true);
    expect(next.bytes).toBeLessThanOrEqual(20_000);
  });
});
