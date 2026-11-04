import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { withVisualizationContext } from '@/lib/mcp/visualization-context';
import { createO8CommandTools, O8_COMMAND_OUTPUT_BYTES } from '@/lib/pi/orchestrator/o8-commands';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

const dir = mkdtempSync(join(tmpdir(), 'o8-visual-mcp-'));
writeFileSync(join(dir, 'ws-token'), 'visual-mcp-token');
process.env.O8_DATA_DIR = dir;
process.env.CORTEX_IDE_DATA_DIR = dir;
const { POST } = await import('@/app/api/mcp/route');
const { buildToolRegistry } = await import('@/lib/mcp/tool-spine/build');
const { closeDb } = await import('@/lib/db');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => { closeDb(); rmSync(dir, { force: true, recursive: true }); });

function req(message: unknown, profile = 'visualizations') {
  return new Request('http://localhost:3001/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-o8-mcp-profile': profile }, body: JSON.stringify(message) });
}
describe('visualization tools use the actual MCP route and narrow profile', () => {
  it('advertises only visualization tools, refuses dispatch, and intersects the server profile', async () => {
    const list = async () => (await (await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).json()).result.tools;
    expect((await list()).map((tool: { name: string }) => tool.name)).toEqual(['o8_html_preview', 'o8_html_render', 'o8_visualization_read', 'o8_result_page']);
    const denied = await (await POST(req({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dispatch_mission', arguments: {} } }))).json();
    expect(denied.result.isError).toBe(true);
    vi.stubEnv('O8_OPERATOR_MCP_PROFILE', 'dogfood');
    // #4834: every profile carries the result-page reader, which reads only results of tools the profile allows.
    expect((await list()).map((tool: { name: string }) => tool.name)).toEqual(['o8_result_page']);
    vi.stubEnv('O8_OPERATOR_MCP_PROFILE', 'typo');
    expect(await list()).toEqual([]);
  });

  it('passes a render reference, preview image and revision source through the real tool handlers', async () => {
    const reference = { kind: 'o8-visualization', id: 'vis-12345678-1234-1234-1234-123456789abc', title: 'Explore', height: 240, createdAt: new Date().toISOString() };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => Response.json({ ok: true, result: String(url).endsWith('/preview')
      ? { image: 'aGVsbG8=', mimeType: 'image/png', width: 728, height: 240, contentHeight: 240, diagnostics: [] }
      : { visualization: reference, warnings: [], source: { html: '<p>Explore</p>' }, versions: [reference] } }));
    for (const name of ['o8_html_render', 'o8_html_preview', 'o8_visualization_read']) {
      const response = await POST(req({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: name.endsWith('read') ? { id: reference.id } : { title: 'Explore', html: '<p>Explore</p>' } } }));
      const body = await response.json();
      expect(body.result.isError).not.toBe(true);
      expect(body.result.content[0].type).toBe(name.endsWith('preview') ? 'image' : 'text');
      if (name.endsWith('read')) expect(JSON.parse(body.result.content[0].text).result.source).toMatchObject({ kind: 'html', text: '<p>Explore</p>', complete: true });
    }
  });

  it('reads complete large and escaped sources through the managed command cap with valid JSON in every chunk', async () => {
    const reference = { kind: 'o8-visualization', id: 'vis-12345678-1234-1234-1234-123456789abc', title: 'Explore', height: 240, createdAt: new Date().toISOString() };
    const server = { name: 'visualizations', request: async (_method: string, params: Record<string, unknown>) =>
      (await (await POST(req({ jsonrpc: '2.0', id: 7, method: 'tools/call', params }))).json()).result };
    const tool = { name: 'o8_visualization_read', description: 'Read', inputSchema: { type: 'object' } };
    const run = createO8CommandTools([{ name: tool.name, tool, server }]).find(tool => tool.definition.name === 'o8_run')!;
    for (const source of [{ html: '<p>' + 'a'.repeat(50_000) + '</p>' }, { html: '<p>' + '\u0000🌱"\\'.repeat(6_000) + '</p>' }]) {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { visualization: reference, source, versions: [reference] } }));
      let offset = 0, complete = false, rebuilt = '', chunks = 0;
      while (!complete && chunks++ < 100) {
        const result = await run.execute({ name: tool.name, arguments: JSON.stringify({ id: reference.id, offset }) }, new AbortController().signal);
        const output = result.content[0]; expect(output.type).toBe('text');
        if (output.type !== 'text') throw new Error('Missing source text');
        expect(Buffer.byteLength(output.text, 'utf8')).toBeLessThan(O8_COMMAND_OUTPUT_BYTES);
        const read = JSON.parse(output.text).result;
        expect(read.latest.id).toBe(reference.id); expect(read.source.offset).toBe(offset);
        expect(read.source.text).not.toContain('\uFFFD'); expect(read.source.nextOffset).toBeGreaterThan(offset);
        rebuilt += read.source.text; offset = read.source.nextOffset; complete = read.source.complete;
      }
      expect(complete).toBe(true); expect(rebuilt).toBe(source.html); expect(offset).toBe(Buffer.byteLength(source.html, 'utf8'));
      fetch.mockRestore();
    }
  });

  it('adds display-only tools in Solo and proposer registries, with current transcript defaults', () => {
    for (const profile of ['solo', 'propose', 'fable-solo'] as const) {
      const registry = buildToolRegistry(dir, { profile, threadId: 'thoughts-current' });
      expect(registry.entries.find(entry => entry.id === 'builtin:operator')).toBeUndefined();
      const visual = registry.entries.find(entry => entry.id === 'builtin:visualizations')!;
      expect(visual.config).toMatchObject({ env: { O8_OPERATOR_MCP_PROFILE: 'visualizations', O8_VISUALIZATION_REPO_PATH: dir, O8_VISUALIZATION_THREAD_ID: 'thoughts-current' } });
    }
    const message = { method: 'tools/call', params: { name: 'o8_html_render', arguments: { title: 'Chart', html: '<p>x</p>' } } };
    expect(withVisualizationContext(message, { repoPath: '/workspace', threadId: 'thoughts-current' }).params.arguments).toMatchObject({ repoPath: '/workspace', threadId: 'thoughts-current' });
    const other = { method: 'tools/call', params: { name: 'dispatch_mission', arguments: {} } };
    expect(withVisualizationContext(other, { repoPath: '/workspace' })).toBe(other);
  });

  it('preserves a bounded screenshot for the managed lead rather than an omitted-image placeholder', async () => {
    const tool = { name: 'o8_html_preview', description: 'Preview', inputSchema: { type: 'object' } };
    const server = { name: 'visualizations', request: vi.fn(async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'text', text: '{"height":240}' }] })) };
    const run = createO8CommandTools([{ name: tool.name, tool, server }]).find(tool => tool.definition.name === 'o8_run')!;
    const result = await run.execute({ name: tool.name, arguments: '{}' }, new AbortController().signal);
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
    expect(result.content[1]).toMatchObject({ type: 'text' });
  });

  it('delivers the current visualization target through a real ACP session/new handshake', async () => {
    const { makeAcpBackend } = await import('@/lib/lane/orchestrator-backends/acp');
    const peer = String.raw`
      const readline = require('node:readline');
      let servers;
      const send = message => process.stdout.write(JSON.stringify(message) + '\n');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
        else if (message.method === 'session/new') {
          servers = message.params.mcpServers;
          send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'visual-session' } });
        } else if (message.method === 'session/prompt') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'visual-session',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(servers) } } } });
          send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
          setTimeout(() => process.exit(0), 20);
        } else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      });
    `;
    const backend = makeAcpBackend({ id: 'acp', label: 'Visualization fixture', requestTimeoutMs: 5_000,
      resolveLaunch: () => ({ command: process.execPath, args: ['-e', peer] }) });
    const events: OrchestratorEvent[] = [];
    await backend.sendTurn(dir, 'Show a diagram', event => events.push(event), { threadId: 'thoughts-acp-visual' });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    const output = events.find(event => event.type === 'text');
    expect(output?.type).toBe('text');
    const servers = JSON.parse(output!.type === 'text' ? output!.text : '[]') as { name: string; env: { name: string; value: string }[] }[];
    const o8 = servers.find(server => server.name === 'o8');
    expect(o8?.env).toEqual(expect.arrayContaining([
      { name: 'O8_VISUALIZATION_REPO_PATH', value: dir },
      { name: 'O8_VISUALIZATION_THREAD_ID', value: 'thoughts-acp-visual' },
    ]));
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'visual-session' });
  }, 15_000);
});
