import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mcp-http-'));
const token = 'vitest-mcp-route-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, 'utf-8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.PORT = '47120';

const { panelGateMiddleware } = await import('@/middleware');
const { POST } = await import('@/app/api/mcp/route');

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:47120/api/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('/api/mcp — real operator host reachability', () => {
  it('round-trips tools/list and a real o8_status call through the route', async () => {
    const gateResponse = panelGateMiddleware(new NextRequest(mcpRequest({})));
    expect(gateResponse.status).toBe(200);

    const listResponse = await POST(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    const toolNames = listBody.result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      'o8_status',
      'o8_list_repos',
      'o8_remove_repo',
      'o8_list_projects',
      'o8_set_active_project',
      'o8_set_project_repos',
      'o8_delete_project',
      'approve_and_merge',
      'o8_view_surface_state',
      'o8_spec_reply',
    ]));
    for (const tool of listBody.result.tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf('object');
    }

    const unexpected: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/operator/status')) {
        return Response.json({ agents: [], approvals: { items: [], count: 0 }, recentActivity: [] });
      }
      if (new URL(url).pathname === '/api/orchestrator/lead') return Response.json({ cursor: 0, leads: [] });
      if (url.endsWith('/api/panel/repos')) return Response.json({ repos: [] });
      if (url.endsWith('/api/panel/operator-defaults')) return Response.json({});
      unexpected.push(url);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const callResponse = await POST(mcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'o8_status', arguments: {} },
    }));
    expect(callResponse.status).toBe(200);
    const callBody = await callResponse.json() as {
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(callBody.result.isError).not.toBe(true);
    expect(JSON.parse(callBody.result.content[0].text)).toMatchObject({
      data: { agents: [], approvalCount: 0 },
    });
    expect(unexpected).toEqual([]);
  });

  it('deletes a project through the public MCP tool and returns disk-preservation receipts', async () => {
    let repos = [{
      id: 'repo-site',
      name: 'site',
      localPath: '/tmp/site',
      remoteUrl: null,
      defaultBranch: 'main',
      exists: true,
    }];
    const projects = [
      { id: 'workspace', name: 'Workspace', repoPaths: [] },
      { id: 'project-site', name: 'Site', repoPaths: ['/tmp/site'] },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/panel/projects') && (!init?.method || init.method === 'GET')) {
        return Response.json({ activeProjectId: 'project-site', projects });
      }
      if (url.endsWith('/api/panel/repos') && (!init?.method || init.method === 'GET')) {
        return Response.json({ repos });
      }
      if (url.endsWith('/api/panel/projects/project-site') && init?.method === 'DELETE') {
        repos = [];
        return Response.json({ activeProjectId: 'workspace', projects: [projects[0]] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    const callResponse = await POST(mcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'o8_delete_project', arguments: { projectId: 'project-site' } },
    }));
    expect(callResponse.status).toBe(200);
    const callBody = await callResponse.json() as {
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(callBody.result.isError).not.toBe(true);
    expect(JSON.parse(callBody.result.content[0].text)).toMatchObject({
      removedProject: { id: 'project-site', name: 'Site' },
      removedExclusiveRepoCount: 1,
      removedExclusiveRepos: [{ id: 'repo-site', repoPath: '/tmp/site' }],
      localFoldersPreserved: true,
      activeProjectId: 'workspace',
    });
  });
});

const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {} };
function modern(method = 'server/discover', params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: 'modern', method, params: { ...params, _meta: modernMeta } };
}
function modernHeaders(method = 'server/discover', name?: string) {
  return { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
    ...(name ? { 'Mcp-Name': name } : {}) };
}
describe('stateless MCP revision through the real HTTP route', () => {
  it('discovers the modern revision without a handshake or session', async () => {
    const response = await POST(mcpRequest(modern(), modernHeaders()));
    expect(response.status).toBe(200);
    expect(response.headers.has('mcp-session-id')).toBe(false);
    expect(await response.json()).toMatchObject({ result: { resultType: 'complete',
      supportedVersions: ['2026-07-28', '2024-11-05'], capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'o8-operator' } } } });
  });
  it('serves a self-contained catalog and retains the legacy initialization shape', async () => {
    const response = await POST(mcpRequest(modern('tools/list'), modernHeaders('tools/list')));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    expect(body.result.tools.some((tool: { name: string }) => tool.name === 'o8_status')).toBe(true);
    const legacy = await POST(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));
    expect(legacy.headers.has('mcp-session-id')).toBe(true);
    expect(await legacy.json()).toMatchObject({ result: { protocolVersion: '2024-11-05' } });
    const legacyList = await POST(mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect((await legacyList.json()).result.resultType).toBeUndefined();
  });
  it.each([
    ['missing version header', modern(), { 'Mcp-Method': 'server/discover' }, -32020],
    ['mismatched method', modern(), modernHeaders('tools/list'), -32020],
    ['mismatched version', modern(), { ...modernHeaders(), 'MCP-Protocol-Version': '1900-01-01' }, -32020],
    ['missing capabilities', { ...modern(), params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, modernHeaders(), -32602],
    ['unsupported version', { ...modern(), params: { _meta: { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } }, { ...modernHeaders(), 'MCP-Protocol-Version': '1900-01-01' }, -32022],
    ['batch', [modern()], modernHeaders(), -32600],
  ])('rejects %s before executing a tool', async (_label, body, headers, code) => {
    const response = await POST(mcpRequest(body, headers));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
  });
  it.each([undefined, 'o8_delete_project'])('refuses a missing or contradictory tool-name header (%s) without side effects', async (name) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Tool must not execute'));
    const response = await POST(mcpRequest(modern('tools/call', { name: 'o8_list_projects', arguments: {} }), modernHeaders('tools/call', name)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32020 } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns modern method-not-found and does not initialize a session', async () => {
    const response = await POST(mcpRequest(modern('initialize'), modernHeaders('initialize')));
    expect(response.status).toBe(404);
    expect(response.headers.has('mcp-session-id')).toBe(false);
    expect(await response.json()).toMatchObject({ error: { code: -32601 } });
  });
  it('refuses routing-only malformed modern requests instead of downgrading', async () => {
    const response = await POST(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Mcp-Method': 'tools/list' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32020 } });
  });
  it('rejects an untrusted browser origin before tools execute', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Tool must not execute'));
    const response = await POST(mcpRequest(modern('tools/call', { name: 'o8_list_projects' }), {
      ...modernHeaders('tools/call', 'o8_list_projects'), origin: 'https://untrusted.invalid',
    }));
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('decodes sentinel tool names before comparing routing to the body', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ projects: [] }));
    const response = await POST(mcpRequest(modern('tools/call', { name: 'o8_list_projects' }),
      modernHeaders('tools/call', `=?base64?${Buffer.from('o8_list_projects').toString('base64')}?=`)));
    expect(response.status).toBe(200);
    expect((await response.json()).result.resultType).toBe('complete');
    expect(fetch).toHaveBeenCalled();
  });
  it.each([null, [], 'invalid'])('refuses malformed modern tool arguments (%j) before dispatch', async (args) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Tool must not execute'));
    const response = await POST(mcpRequest(modern('tools/call', { name: 'mission_tail', arguments: args }), modernHeaders('tools/call', 'mission_tail')));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps profile narrowing local to each modern request', async () => {
    const scoped = await POST(mcpRequest(modern('tools/list'), { ...modernHeaders('tools/list'), 'x-o8-mcp-profile': 'solo' }));
    const scopedNames = (await scoped.json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(scopedNames).not.toContain('approve_and_merge');
    const full = await POST(mcpRequest(modern('tools/list'), modernHeaders('tools/list')));
    expect((await full.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain('approve_and_merge');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Tool must not execute'));
    const refused = await POST(mcpRequest(modern('tools/call', { name: 'approve_and_merge', arguments: {} }),
      { ...modernHeaders('tools/call', 'approve_and_merge'), 'x-o8-mcp-profile': 'solo' }));
    expect((await refused.json()).result).toMatchObject({ resultType: 'complete', isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});
