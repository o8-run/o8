import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/mcp/route';
import * as specRoute from '@/app/api/repo-spec/route';

const repoPath = join(process.env.CORTEX_IDE_DATA_DIR!, 'page-audit');
mkdirSync(repoPath, { recursive: true });

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
  it('pages a normal large spec losslessly and never repeats its source call', async () => {
    const content = '# Operator spec\n' + 'Check "quoted" paths \\ and unicode 🧭\n'.repeat(1800);
    writeFileSync(join(repoPath, 'o8.md'), content);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      return specRoute.GET(new NextRequest(new Request(input, init)));
    });
    let page = await call('o8_spec_read', { repoPath });
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
    expect(JSON.parse(original.content[0].text).content).toBe(content);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(repoPath, 'o8.md'), 'utf8')).toBe(content);
  });

  it('keeps small results in their existing shape', async () => {
    writeFileSync(join(repoPath, 'o8.md'), '# Small spec\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => specRoute.GET(new NextRequest(new Request(input, init))));
    const response = await call('o8_spec_read', { repoPath });
    expect(response.payload).toMatchObject({ ok: true, content: '# Small spec\n' });
    expect(response.payload.schema).toBeUndefined();
  });

  it('leaves room for the JSON-RPC envelope near the wire-size limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: 'x'.repeat(19_890) }));
    const response = await call('o8_spec_read', { repoPath });
    expect(response.bytes).toBeLessThanOrEqual(20_000);
    expect(response.payload.schema).toBe('o8/mcp/result-page/v1');
  });

  it('reads a large mutation receipt without applying the mutation twice', async () => {
    writeFileSync(join(repoPath, 'o8.md'), '# Spec\n' + 'Preserve this requirement.\n'.repeat(1800));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new NextRequest(new Request(input, init));
      return request.method === 'POST' ? specRoute.POST(request) : specRoute.GET(request);
    });
    const first = await call('o8_spec_comment', { repoPath, body: 'Check the empty case' });
    expect(first.payload.nextArguments).toBeDefined();
    const persisted = readFileSync(join(repoPath, 'o8.md'), 'utf8');
    expect(persisted).toContain('Check the empty case');
    await call('o8_result_page', first.payload.nextArguments);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(repoPath, 'o8.md'), 'utf8')).toBe(persisted);
  });

  it('rejects an unavailable saved result without invoking a handler', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await call('o8_result_page', { resultId: 'unavailable', offset: 0 });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toBe('Saved result unavailable or expired. Rerun a read-only source call; check status before retrying a mutation.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cannot use a saved result to expand a narrowed tool profile', async () => {
    writeFileSync(join(repoPath, 'o8.md'), 'Long specification.\n'.repeat(2000));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => specRoute.GET(new NextRequest(new Request(input, init))));
    const first = await call('o8_spec_read', { repoPath });
    expect(first.payload.nextArguments).toBeDefined();
    const response = await call('o8_result_page', first.payload.nextArguments, 'visualizations');
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Saved result unavailable');
  });

  it('expires saved results with a corrective error and no source retry', async () => {
    writeFileSync(join(repoPath, 'o8.md'), 'Specification.\n'.repeat(2000));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => specRoute.GET(new NextRequest(new Request(input, init))));
    const first = await call('o8_spec_read', { repoPath });
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
