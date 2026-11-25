import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';

const inventory = vi.hoisted(() => ['codex', 'claude-code', 'opencode'].map((id) => ({ id, label: id, installed: true, available: true, unavailableReason: null, detail: 'Local credential evidence', fix: '' })));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  invalidateRuntimeAuthCache: vi.fn(),
  getDispatchableRuntimeAvailability: vi.fn(async () => inventory),
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: Object.fromEntries(inventory.map((item) => [item.id, { runtime: item.id, installed: true, authenticated: true }])), suggestedSubscriptionProfile: { profile: null, detail: null } })),
}));
vi.mock('@/lib/setup/runtime-setup-server', async () => {
  const { recommendRuntimeSetup } = await import('@/lib/setup/runtime-recommendation');
  return { readRuntimeSetupRecommendation: async (data: Parameters<typeof recommendRuntimeSetup>[0], runtimes: typeof inventory) => recommendRuntimeSetup({ ...data, inventory: runtimes as Parameters<typeof recommendRuntimeSetup>[0]['inventory'], activity: { codex: 1, claude: 0, complete: true } }) };
});
vi.mock('@/lib/repos/readiness', async (original) => ({ ...await original<typeof import('@/lib/repos/readiness')>(), enrichRepoReadiness: async (repo: unknown) => repo }));

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'o8-agent-setup-')));
const data = join(dir, 'data');
const repo = join(dir, 'project');
mkdirSync(data); mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
vi.stubEnv('O8_DATA_DIR', data); vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
const token = 'setup-operator-fixture-token';
writeFileSync(join(data, 'ws-token'), token);
writeFileSync(join(data, 'worker-token'), 'local-worker-token-setup-fixture');
const route = await import('@/app/api/setup/agent/route');
const configRoute = await import('@/app/api/setup/config/route');
const { panelGateMiddleware } = await import('@/middleware');
const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
let port = 0;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) });
    const gate = panelGateMiddleware(request);
    const response = gate.status !== 200 ? gate : req.url === '/api/setup/config' ? await configRoute.GET()
      : req.method === 'POST' ? await route.POST(request) : await route.GET(request);
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
beforeAll(async () => {
  execFileSync(process.execPath, [join(process.cwd(), 'cli/esbuild.config.mjs')], { cwd: process.cwd(), stdio: 'pipe', timeout: 60_000 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  setApiBase(`http://127.0.0.1:${port}`);
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); vi.unstubAllEnvs(); });
async function mcp(args: Record<string, unknown>) {
  const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_setup', arguments: args } });
  const result = response!.result as { isError?: boolean; content: Array<{ text: string }> };
  return { error: result.isError, text: result.content[0]!.text, data: result.isError ? null : JSON.parse(result.content[0]!.text) };
}
const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/setup/agent`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body.action === 'ack' ? { ...body, claimId: JSON.parse(readFileSync(join(data, 'agent-setup-request.json'), 'utf8')).claimId } : body) });

it('discovers the MCP tool and reports evidence without accepting a provider or completing setup', async () => {
  const list = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect((list!.result as { tools: { name: string }[] }).tools.some((tool) => tool.name === 'o8_setup')).toBe(true);
  const status = await mcp({ action: 'status' });
  expect(status.error).not.toBe(true);
  expect(status.data.runtimes[0]).toMatchObject({ installed: true, credentialEvidence: true, providerAcceptance: 'not_checked' });
  expect(status.data.incompleteSteps).not.toContain('privacy');
  expect(existsSync(join(data, 'agent-setup-request.json'))).toBe(false);
  for (const bearer of ['', 'local-worker-token-setup-fixture']) {
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/agent`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    expect([401, 403]).toContain(response.status);
  }
});

it('saves role-specific models and the pool through MCP; rejects unsupported choices', async () => {
  expect((await mcp({ action: 'configure', orchestratorRuntime: 'claude-code', workerRuntimes: [] })).error).toBe(true);
  const result = await mcp({ action: 'configure', orchestratorRuntime: 'claude-code', workerRuntimes: ['claude-code', 'codex'], leadModel: MODEL_IDS.orchestratorDefault, workerModel: MODEL_IDS.claudeWorkerDefault });
  expect(result.error, result.text).not.toBe(true);
  expect(result.data.result).toBe('saved');
  expect(result.data.choices.orchestratorModel).toMatchObject({ value: MODEL_IDS.orchestratorDefault, source: 'file' });
  expect(result.data.choices.workerRuntimes.value).toEqual(['claude-code', 'codex']);
  expect(result.data).not.toHaveProperty('privacyAnswered');
  expect(readFileSync(join(data, 'settings.toml'), 'utf8')).toContain(MODEL_IDS.claudeWorkerDefault);
  const opencode = await mcp({ action: 'configure', orchestratorRuntime: 'opencode', workerRuntimes: ['opencode'], leadModel: 'provider/lead', workerModel: 'provider/worker' });
  expect(opencode.error, opencode.text).not.toBe(true);
  expect(opencode.data.choices.opencodeOrchestratorModel.value).toBe('provider/lead');
  expect(opencode.data.choices.opencodeWorkerModel.value).toBe('provider/worker');
});

it('registers once, keeps requests pending until the app acknowledges, and makes cancellation safe', async () => {
  const first = await mcp({ action: 'open', path: repo });
  expect(first.error, first.text).not.toBe(true);
  const id = first.data.request.id;
  expect(first.data.result).toBe('pending');
  expect((await mcp({ action: 'open', path: repo })).data.request.id).toBe(id);
  const nested = join(repo, 'nested'); mkdirSync(nested);
  expect((await mcp({ action: 'open', path: nested })).data.request.id).toBe(id);
  expect((await mcp({ action: 'open', path: nested, requestId: id })).data.request.id).toBe(id);
  expect(JSON.parse(readFileSync(join(data, 'repos.json'), 'utf8')).repos).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(data, 'agent-setup-request.json'), 'utf8')).status).toBe('pending');
  const second = join(dir, 'another-project'); mkdirSync(second); execFileSync('git', ['init', '-q', '-b', 'main', second]);
  expect((await mcp({ action: 'open', path: second })).error).toBe(true);
  expect(JSON.parse(readFileSync(join(data, 'repos.json'), 'utf8')).repos).toHaveLength(1);
  expect((await post({ action: 'claim', requestId: id })).ok).toBe(true);
  expect((await post({ action: 'claim', requestId: id })).ok).toBe(false);
  expect((await mcp({ action: 'cancel', requestId: id })).error).toBe(true);
  expect((await post({ action: 'ack', requestId: id, status: 'needs_privacy' })).ok).toBe(true);
  expect((await mcp({ action: 'status' })).data.request.status).toBe('needs_privacy');
  expect((await mcp({ action: 'cancel', requestId: id })).data.request.status).toBe('cancelled');
  expect((await post({ action: 'ack', requestId: id, status: 'opened' })).ok).toBe(false);
  expect(JSON.parse(readFileSync(join(data, 'repos.json'), 'utf8')).repos).toHaveLength(1);
  const retry = await mcp({ action: 'open', path: repo });
  expect(retry.data.request.id).not.toBe(id);
  const claim = await post({ action: 'claim', requestId: retry.data.request.id }); expect(claim.ok).toBe(true);
  expect((await post({ action: 'ack', requestId: retry.data.request.id, status: 'error', error: 'Temporary failure' })).ok).toBe(true);
  expect((await post({ action: 'claim', requestId: retry.data.request.id })).ok).toBe(true);
  const ack = await post({ action: 'ack', requestId: retry.data.request.id, status: 'opened' }); expect(ack.ok).toBe(true);
  expect((await ack.json()).request.error).toBeUndefined();
  const cli = await promisify(execFile)(process.execPath, ['cli/dist/o8.mjs', 'setup', 'status'], { env: { ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: token }, timeout: 20_000 });
  expect(JSON.parse(cli.stdout).request.status).toBe('opened');
  expect(JSON.parse(readFileSync(join(data, 'agent-setup-request.json'), 'utf8')).status).toBe('opened');
  expect((await mcp({ action: 'open', path: repo, requestId: retry.data.request.id })).data.request.id).toBe(retry.data.request.id);
  const fresh = await mcp({ action: 'open', path: repo });
  expect(fresh.data.request.id).not.toBe(retry.data.request.id);
  expect(fresh.data.result).toBe('pending');
  const reclaimed = await post({ action: 'claim', requestId: fresh.data.request.id }); expect(reclaimed.ok).toBe(true);
  const receiptPath = join(data, 'agent-setup-request.json');
  const expired = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, JSON.stringify({ ...expired, leaseExpiresAt: new Date(0).toISOString() }));
  expect((await mcp({ action: 'status' })).data.request.status).toBe('interrupted');
  expect((await post({ action: 'renew', requestId: expired.id, claimId: expired.claimId })).ok).toBe(false);
  expect((await mcp({ action: 'cancel', requestId: expired.id })).data.request.status).toBe('cancelled');
});

it('restores setup recovery after completion was saved but the app receipt was lost', async () => {
  const open = await mcp({ action: 'open', path: repo });
  const id = open.data.request.id;
  expect((await post({ action: 'claim', requestId: id })).ok).toBe(true);
  writeFileSync(join(data, 'setup.json'), JSON.stringify({ setupComplete: true }));
  const receiptPath = join(data, 'agent-setup-request.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, leaseExpiresAt: new Date(0).toISOString() }));
  const readConfig = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/config`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.ok).toBe(true);
    return response.json();
  };
  expect(await readConfig()).toMatchObject({ setupComplete: true, agentSetupPending: true });
  expect((await mcp({ action: 'status' })).data.request.status).toBe('interrupted');
  expect((await post({ action: 'claim', requestId: id })).ok).toBe(true);
  expect((await post({ action: 'ack', requestId: id, status: 'opened' })).ok).toBe(true);
  expect(await readConfig()).toMatchObject({ setupComplete: true, agentSetupPending: false });
  const next = await mcp({ action: 'open', path: repo });
  expect((await mcp({ action: 'cancel', requestId: next.data.request.id })).error).not.toBe(true);
  expect((await readConfig()).agentSetupPending).toBe(false);
});
