import { saveRuntimeBillingMode } from '@/lib/providers/runtime-billing';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The CLI binary and OS sandbox are substituted. Authenticated routes, durable
// account/task/session state, Git isolation, child process and local gateway are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => {} }));
vi.mock('@/lib/runtimes/shared/owned-session/sandbox', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/owned-session/sandbox')>(),
  prepareWorkerSandbox: async (input: { binary: string; args: string[] }) => input,
}));

import { POST } from '@/app/api/plugins/mcp/route';
import { POST as control } from '@/app/api/plugins/task-drafts/control/route';
import { claudeCodeOwnedAdapter } from '@/lib/claude-code/owned';
import { getDataDir } from '@/lib/data-dir-migration';
import { mintPluginToken } from '@/lib/auth/plugin-token';
import { allowAccountRefresh, publishReadyAccountState, withAccountStateLease } from '@/lib/auth/account-state';
import { bumpSignInEpoch, readSignInEpoch, writeActiveIdentity } from '@/lib/github-broker/managed';
import { addRepoToProject, createProject } from '@/lib/projects/store';
import { upsertProjectLedgerRecord } from '@/lib/repos/projects';
import { listTaskDrafts, taskDraftRoot } from '@/lib/mcp/task-draft-store';
import { readTaskExecution } from '@/lib/mcp/task-execution-store';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { panelGateMiddleware } from '@/middleware';

const keyPair = generateKeyPairSync('ed25519');
const accountId = 'user_controlled_gateway_fixture';
const model = 'deepseek/deepseek-v4.1-flash';
const provider = { carrier: 'openrouter', reasoning: 'provider-default', maxRequests: 4,
  maxOutputTokens: 2048, maxRequestBytes: 64_000, costUsd: 0.01 };
const names = ['OPENROUTER_API_KEY', 'O8_LICENSE_PUBKEY', 'O8_CLAUDE_CODE_BIN', 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT'];
const ownedRoot = process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT || claudeCodeOwnedAdapter.rootDefault;
const previousEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const dirs: string[] = [];
let root: string;
let repo: string;
let repoId: string;
let projectId: string;
let calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>;
let cost: number | null = 0.001;
let fakeContentCost = false;
let upstreamGate: Promise<void> | undefined;

async function account(subject = accountId) {
  await withAccountStateLease(() => {
    writeActiveIdentity(subject); bumpSignInEpoch();
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: subject, plan: 'free', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const license = `${unsigned}.${sign(null, Buffer.from(unsigned), keyPair.privateKey).toString('base64url')}`;
    writeFileSync(join(getDataDir(), 'entitlement.json'), JSON.stringify({ plan: 'free', licenseKey: license }));
    rmSync(join(getDataDir(), 'auth-signed-out-at'), { force: true });
    allowAccountRefresh(); publishReadyAccountState(subject, readSignInEpoch()!, license);
  });
}
function git(...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }); }
async function call(name: string, args: unknown, subject = accountId,
  grant: { scopes?: string[]; clientId?: string; expiresAt?: number } = {}) {
  const req = new NextRequest('http://localhost/api/plugins/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mintPluginToken({
      machineId: 'gateway-machine', clientId: grant.clientId ?? 'gateway-client', accountId: subject,
      scopes: grant.scopes ?? ['o8:read', 'o8:prepare-task'],
    }, { expiresAt: grant.expiresAt })}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  expect(panelGateMiddleware(req).status).toBe(200);
  const response = await POST(req);
  return { status: response.status, result: (await response.json()).result.structuredContent };
}
async function options() {
  const result = await call('o8_task_options', { machineId: 'gateway-machine', repoId, projectId });
  expect(result.status).toBe(200); return result.result;
}
async function prepare(overrides = {}) {
  const snapshot = await options();
  const args = { machineId: 'gateway-machine', repoId, projectId, snapshotId: snapshot.snapshotId,
    idempotencyKey: 'gateway-draft', objective: 'Read the fixture and report the actual value.',
    allowedFiles: ['value.txt'], runtime: 'claude-code', model, effort: 'provider-default', provider,
    workMode: 'read-only', evidence: ['Report the actual value.'], sealedTaskContract: {
      version: 1, requirements: [{ id: 'R1', source: 'Explicit fixture request', expectedBehavior: 'Read the actual value.',
        productionPath: 'value.txt', verification: 'Return the observed value.' }],
      smallestRoute: [{ path: 'value.txt', requirements: ['R1'], reason: 'The only permitted file.' }], exclusions: ['No writes or delegation.'],
    }, ...overrides };
  const result = await call('o8_prepare_task', args);
  return { ...result, args, draft: listTaskDrafts(accountId)[0] };
}
async function decision(taskId: string, contractHash: string, action = 'launch') {
  const response = await control(new NextRequest('http://localhost/api/plugins/task-drafts/control', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getOrCreateWsToken()}` },
    body: JSON.stringify({ taskId, contractHash, action }) }));
  return { status: response.status, body: await response.json() };
}
function session() {
  const base = process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT!;
  return JSON.parse(readFileSync(join(base, readdirSync(base)[0]!, 'session.json'), 'utf8'));
}
function childReceipt() { return JSON.parse(readFileSync(join(root, 'child.json'), 'utf8')); }

function childConfig(config: Record<string, unknown>) { writeFileSync(join(root, 'child-config.json'), JSON.stringify(config)); }
async function replayGateway(body = childReceipt().body, path = '/v1/messages?beta=true'): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = childReceipt(); const request = httpRequest(child.base + path,
      { method: 'POST', headers: child.headers }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
}
async function readCatalog(path = '/v1/models', headers = childReceipt().headers): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(childReceipt().base + path, { method: 'GET', headers }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
    });
    request.on('error', reject); request.end();
  });
}
async function launchedTask(config = {}) {
  childConfig(config); const prepared = await prepare(); expect(prepared.status).toBe(200);
  const draft = prepared.draft!; expect((await decision(draft.taskId, draft.contractHash)).status).toBe(200);
  await vi.waitFor(() => expect(existsSync(join(root, 'child.json'))).toBe(true), { timeout: 10000 }); return draft;
}
beforeEach(async () => {
  saveRuntimeBillingMode('claude-code', 'api');
  vi.restoreAllMocks(); cost = 0.001; fakeContentCost = false; upstreamGate = undefined; calls = [];
  process.env.O8_LICENSE_PUBKEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture-parent-only';
  process.env.O8_CLAUDE_CODE_BIN = process.execPath;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-controlled-provider-'))); dirs.push(root);
  repo = join(root, 'repository'); execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  writeFileSync(join(repo, 'value.txt'), '40\n'); writeFileSync(join(repo, 'AGENTS.md'), 'Read only; report observed evidence.\n');
  git('add', '.'); git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'fixture');
  rmSync(taskDraftRoot(), { recursive: true, force: true }); await account();
  process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = ownedRoot;
  rmSync(ownedRoot, { recursive: true, force: true });
  repoId = randomUUID(); const project = createProject({ name: `Gateway fixture ${randomUUID()}` }); projectId = project.id;
  addRepoToProject(projectId, repoId);
  writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: repoId, name: 'Gateway fixture',
    localPath: repo, remoteUrl: null, defaultBranch: 'main', isGitRepo: true, addedAt: new Date().toISOString(),
    lastOpenedAt: null, storagePressureParkingDisabled: false, setup: {} }] }));
  await upsertProjectLedgerRecord({ id: projectId, name: project.name, slug: project.slug, repoPaths: [repo] });
  const child = join(root, 'worker.cjs');
  childConfig({});
  writeFileSync(child, `const fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',async()=>{
    const cfg=JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'child-config.json'))},'utf8'));
    const headers={'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY};
    const body={model:${JSON.stringify(model)},messages:[{role:'user',content:'Read value.txt'}],tools:[{name:'Read',input_schema:{type:'object'}}],max_tokens:99999,thinking:{type:'adaptive'},context_management:{edits:[{type:'clear_thinking_20251015'}]},...cfg.body};
    const base=process.env.ANTHROPIC_BASE_URL;if(!base.startsWith('http://127.0.0.1:'))process.exit(98);
    let validation;
    if(cfg.validateModels){
      const requested=cfg.validationModel||body.model;let ids=[];let status=0;
      if(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY==='1'){
        const catalog=await fetch(base+'/v1/models',{headers});status=catalog.status;
        const data=await catalog.json();ids=(data.data||[]).map(item=>item.id);
      }
      validation={requested,ids,status};
      if(!ids.includes(requested)){
        const error='Unknown controlled model: '+requested+'. Available models: '+ids.join(', ');
        fs.writeFileSync(${JSON.stringify(join(root, 'child.json'))},JSON.stringify({pid:process.pid,status:400,input,env:process.env,base,headers,body,validation,error}));
        process.stderr.write(error+'\\n');process.exit(1);
      }
    }
    const statuses=await Promise.all(Array.from({length:cfg.requests||1},async()=>{const r=await fetch(base+(cfg.path||'/v1/messages?beta=true'),{method:'POST',headers,body:JSON.stringify(body)});await r.text();return r.status;}));
    fs.writeFileSync(${JSON.stringify(join(root, 'child.json'))},JSON.stringify({pid:process.pid,status:statuses[0],statuses,input,env:process.env,base,headers,body,validation}));
    if(cfg.hold)setInterval(()=>{},1000);else{const answer=fs.readFileSync('value.txt','utf8').trim();const success=statuses.every(s=>s===200);
    process.stdout.write(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Observed '+answer}]}})+'\\n');
    process.stdout.write(JSON.stringify({type:'result',subtype:success?'success':'error',is_error:!success,result:'Observed '+answer})+'\\n');process.exit(success?0:1);}});`);
  vi.spyOn(claudeCodeOwnedAdapter, 'launchArgs').mockImplementation(() => [child]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== 'https://openrouter.ai/api/v1/messages') {
      const requested = new URL(String(url));
      if (requested.origin === 'https://openrouter.ai' && requested.pathname === '/api/v1/generation') {
        return new Response(JSON.stringify({ data: { id: requested.searchParams.get('id'), total_cost: cost } }), { status: 200 });
      }
      if (!['localhost', '127.0.0.1'].includes(requested.hostname)) throw new Error(`Unexpected external request: ${requested.origin}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (upstreamGate) await upstreamGate;
    return new Response(JSON.stringify({ type: 'message', id: `gen-fixture-${calls.length}`, model,
      content: fakeContentCost ? [{ type: 'tool_use', name: 'Read', input: { cost: 0, total_cost: 0 } }] : [{ type: 'text', text: 'Observed 40' }], usage: { input_tokens: 10, output_tokens: 4, cost } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(async () => {
  const sessions = ownedRoot;
  if (existsSync(sessions)) {
    for (const dir of readdirSync(sessions)) {
      const saved = JSON.parse(readFileSync(join(sessions, dir, 'session.json'), 'utf8'));
      const gateway = await import('@/lib/claude-code/controlled-gateway'); gateway.revokeControlledGateway(saved.surfaceId);
      for (const run of saved.recentRuns ?? []) {
        if (!Number.isInteger(run.pid) || run.pid <= 1) continue; // Prepared attempts have no child PID.
        try { process.kill(-run.pid, 'SIGKILL'); } catch { /* Already clear. */ }
      }
    }
  }
  if (existsSync(join(root, 'child.json'))) { try { process.kill(-childReceipt().pid, 'SIGKILL'); } catch { /* Already clear. */ } }
  vi.restoreAllMocks();
  for (const name of names) { if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name]; }
});
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('controlled OpenRouter preparation, owned child and actual local gateway', () => {
  const hostedArgs = (draft: NonNullable<Awaited<ReturnType<typeof prepare>>['draft']>) => ({
    machineId: 'gateway-machine', taskId: draft.taskId, contractHash: draft.contractHash,
  });
  const launchGrant = { scopes: ['o8:launch-task'] };

  it.each([['o8:read'], ['o8:prepare-task'], ['o8:read', 'o8:prepare-task', 'o8:follow-up']])(
    'does not upgrade an existing grant into hosted launch authority %j', async (...scopes) => {
      const { draft } = await prepare();
      expect((await call('o8_launch_task', hostedArgs(draft!), accountId, { scopes })).status).toBe(403);
      expect(readTaskExecution(draft!)).toBeNull(); expect(calls).toHaveLength(0);
    });

  it('launches the exact hosted provider contract once and records its plugin grant', async () => {
    const { draft, result } = await prepare();
    expect(result.contractHash).toBe(draft!.contractHash);
    const receipt = await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant);
    expect(receipt.status).toBe(200); expect(receipt.result.execution.replayed).toBe(false);
    await vi.waitFor(() => expect(existsSync(join(root, 'child.json'))).toBe(true), { timeout: 10000 });
    expect(childReceipt().status).toBe(200);
    expect(readTaskExecution(draft!)?.pluginLaunchGrant).toMatchObject({ clientId: 'gateway-client', machineId: 'gateway-machine' });
    await vi.waitFor(async () => expect((await call('o8_task_result', { machineId: 'gateway-machine', taskId: draft!.taskId })).result.completed).toBe(true), { timeout: 10_000 });
    const replay = await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant);
    expect(replay.result.execution.replayed).toBe(true); expect(session().runIdentityLedger.totalRuns).toBe(1);
    expect(calls).toHaveLength(1); expect(git('status', '--porcelain')).toBe('');
  });

  it('refuses a different client and changed contract before reserving an attempt', async () => {
    const { draft } = await prepare();
    expect((await call('o8_launch_task', hostedArgs(draft!), accountId, { ...launchGrant, clientId: 'other-client' })).status).toBe(404);
    expect((await call('o8_launch_task', { ...hostedArgs(draft!), contractHash: '0'.repeat(64) }, accountId, launchGrant)).status).toBe(409);
    expect(readTaskExecution(draft!)).toBeNull(); expect(calls).toHaveLength(0);
  });

  it('rechecks a hosted grant that expires during provider setup before actual child creation', async () => {
    const { draft } = await prepare();
    const resolver = await import('@/lib/claude-code/worker-profile');
    vi.spyOn(resolver, 'resolveClaudeCodeWorkerGatewayKey').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500)); return 'sk-or-fixture-parent-only';
    });
    await call('o8_launch_task', hostedArgs(draft!), accountId, { ...launchGrant, expiresAt: Date.now() + 1000 });
    expect(existsSync(join(root, 'child.json'))).toBe(false); expect(calls).toHaveLength(0);
    expect(readTaskExecution(draft!)?.state).not.toBe('running');
  });

  it('refuses an expired grant after the prepared run journal, immediately before spawning', async () => {
    const { draft } = await prepare();
    const persistence = await import('@/lib/runtimes/shared/owned-session/restricted-session-persistence');
    const save = persistence.saveRestrictedOwnedSession; const now = Date.now; let expired = false;
    vi.spyOn(persistence, 'saveRestrictedOwnedSession').mockImplementation((file, saved) => {
      save(file, saved);
      if (!expired && saved.activeRun?.spawnState === 'prepared') {
        expired = true; vi.spyOn(Date, 'now').mockReturnValue(now() + 60_001);
      }
    });
    expect((await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant)).status).toBe(403);
    expect(expired).toBe(true); expect(readTaskExecution(draft!)?.runId).toBeTruthy();
    expect(existsSync(join(root, 'child.json'))).toBe(false); expect(calls).toHaveLength(0);
  });

  it('refuses expiry during source verification before creating the permanent reservation', async () => {
    const { draft } = await prepare();
    const workspace = await import('@/lib/mcp/task-draft-workspace');
    const capture = workspace.captureTaskDraftWorkspace; const now = Date.now;
    vi.spyOn(workspace, 'captureTaskDraftWorkspace').mockImplementation(async (...args) => {
      const snapshot = await capture(...args); vi.spyOn(Date, 'now').mockReturnValue(now() + 60_001); return snapshot;
    });
    expect((await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant)).status).toBe(403);
    expect(readTaskExecution(draft!)).toBeNull();
    expect(existsSync(join(taskDraftRoot(), 'execution-reservations', draft!.taskId))).toBe(false);
    expect(existsSync(join(root, 'child.json'))).toBe(false); expect(calls).toHaveLength(0);
  });

  it('holds native-provider tasks instead of changing the hosted launch route', async () => {
    const prepared = await prepare({ provider: null, model: 'claude-sonnet-4-6', effort: 'high' });
    expect(prepared.status).toBe(200);
    expect((await call('o8_launch_task', hostedArgs(prepared.draft!), accountId, launchGrant)).status).toBe(403);
    expect(readTaskExecution(prepared.draft!)).toBeNull(); expect(calls).toHaveLength(0);
  });

  it('conceals foreign and stale-epoch tasks from hosted launch', async () => {
    const { draft } = await prepare();
    await account('user_other');
    expect((await call('o8_launch_task', hostedArgs(draft!), 'user_other', launchGrant)).status).toBe(404);
    expect((await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant)).status).toBe(403);
    await account();
    expect((await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant)).status).toBe(403);
    expect(readTaskExecution(draft!)).toBeNull(); expect(calls).toHaveLength(0);
  });

  it('keeps the full launch grant out of operator approvals and the local control route', async () => {
    const { draft } = await prepare();
    expect((await call('approve_and_merge', hostedArgs(draft!), accountId, launchGrant)).status).toBe(403);
    const token = mintPluginToken({ machineId: 'gateway-machine', clientId: 'gateway-client', accountId, scopes: launchGrant.scopes });
    const req = new NextRequest('http://localhost/api/plugins/task-drafts/control', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'launch', taskId: draft!.taskId, contractHash: draft!.contractHash }) });
    expect((await control(req)).status).toBe(403); expect(readTaskExecution(draft!)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('stops the hosted bound attempt and replay never launches a replacement', async () => {
    childConfig({ hold: true }); const { draft } = await prepare();
    expect((await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant)).status).toBe(200);
    await vi.waitFor(() => expect(existsSync(join(root, 'child.json'))).toBe(true), { timeout: 10000 });
    expect((await call('o8_stop_task', hostedArgs(draft!), accountId, launchGrant)).status).toBe(200);
    expect(await replayGateway()).toBe(403);
    expect((await call('o8_launch_task', hostedArgs(draft!), accountId, launchGrant)).result.execution.replayed).toBe(true);
    expect(calls).toHaveLength(1); expect(session().runIdentityLedger.totalRuns).toBe(1);
  });

  it('initializes CLI model validation from the controlled gateway catalog before inference', async () => {
    const draft = await launchedTask({ validateModels: true });
    expect(childReceipt().status, childReceipt().error).toBe(200);
    expect(childReceipt().validation).toEqual({ requested: model, ids: [model], status: 200 });
    expect(childReceipt().env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe('1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.model).toBe(model);
    await vi.waitFor(async () => expect((await decision(draft.taskId, draft.contractHash, 'inspect')).body.execution.state)
      .toBe('completed'), { timeout: 10_000 });
    expect(readTaskExecution(draft)?.state).toBe('completed');
    expect(session().runIdentityLedger.totalRuns).toBe(1);
  });

  it('keeps an unknown CLI model explicit and terminal with zero inference or fallback', async () => {
    const unknown = 'fixture/unknown-model';
    const draft = await launchedTask({ validateModels: true, validationModel: unknown });
    expect(childReceipt().status).toBe(400);
    expect(childReceipt().validation).toEqual({ requested: unknown, ids: [model], status: 200 });
    expect(childReceipt().error).toContain(`Unknown controlled model: ${unknown}`);
    expect(calls).toHaveLength(0);
    await vi.waitFor(async () => expect((await decision(draft.taskId, draft.contractHash, 'inspect')).body.execution)
      .toMatchObject({ state: 'blocked', errorCode: 'worker_failed' }), { timeout: 10_000 });
    expect(readTaskExecution(draft)).toMatchObject({ state: 'blocked', errorCode: 'worker_failed' });
    const saved = session();
    expect(saved.recentRuns[0].childExit).toMatchObject({ code: 1, classification: 'nonzero-exit' });
    expect(readFileSync(saved.recentRuns[0].stderrPath, 'utf8')).toContain(`Unknown controlled model: ${unknown}`);
    expect(saved.runIdentityLedger.totalRuns).toBe(1);
    expect((await decision(draft.taskId, draft.contractHash)).body.execution.replayed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('keeps model discovery authenticated, bounded and revoked on Stop without consuming inference', async () => {
    const draft = await launchedTask({ validateModels: true, hold: true });
    const catalog = await readCatalog('/v1/models?limit=1000');
    expect(catalog.status).toBe(200);
    expect(catalog.body).toMatchObject({ data: [{ id: model, type: 'model', display_name: model }],
      has_more: false, first_id: model, last_id: model });
    expect((await readCatalog('/v1/models', { ...childReceipt().headers, 'x-api-key': randomUUID() })).status).toBe(403);
    expect((await readCatalog('/v1/models?limit=1001')).status).toBe(403);
    expect((await readCatalog('/v1/models?model=fixture')).status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(session().sessionDir, 'controlled-provider-usage.json'), 'utf8')).requests).toBe(1);
    expect((await decision(draft.taskId, draft.contractHash, 'stop')).status).toBe(200);
    expect((await readCatalog()).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it('refuses an unknown requested model before preparing or reserving an attempt', async () => {
    const refused = await prepare({ model: 'fixture/unknown-model' });
    expect(refused.status).toBe(400);
    expect(refused.result).toMatchObject({ ok: false, code: 'model_incompatible',
      message: expect.stringContaining('exact model') });
    expect(listTaskDrafts(accountId)).toHaveLength(0);
    expect(existsSync(join(taskDraftRoot(), 'executions'))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('seals the payer and limits, runs once, and returns provider usage with the bound report', async () => {
    const prepared = await prepare(); expect(prepared.status).toBe(200);
    const draft = prepared.draft!; expect(draft.contract.provider).toEqual(provider);
    expect(readTaskExecution(draft)).toBeNull(); expect(calls).toHaveLength(0);
    const launched = await decision(draft.taskId, draft.contractHash);

    expect(launched.status).toBe(200);
    await vi.waitFor(() => expect(existsSync(join(root, 'child.json'))).toBe(true), { timeout: 10000 });
    expect(childReceipt().status).toBe(200);
    expect(childReceipt().input).toContain('Your working directory is the admitted isolated workspace.');
    expect(childReceipt().input).not.toContain('## Project Brief');
    expect(childReceipt().input).not.toContain(repo);
    expect(JSON.stringify(childReceipt().env)).not.toContain('sk-or-fixture-parent-only');
    expect(calls).toHaveLength(1); expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-or-fixture-parent-only');
    expect(calls[0]!.body).toMatchObject({ model, max_tokens: 2048 }); expect(calls[0]!.body.thinking).toBeUndefined();
    expect(calls[0]!.body.context_management).toBeUndefined();
    await vi.waitFor(async () => expect((await decision(draft.taskId, draft.contractHash, 'inspect')).body.execution.state).toBe('completed'), { timeout: 10_000 });
    const result = await call('o8_task_result', { machineId: 'gateway-machine', taskId: draft.taskId });
    expect(result.result).toMatchObject({ completed: true, effort: 'provider-default',
      provider: { carrier: 'openrouter', model, requests: 1, costUsd: 0.001 }, completion: { summary: 'Observed 40' } });
    expect(session().runIdentityLedger.totalRuns).toBe(1);
    expect((await call('o8_prepare_task', prepared.args)).result.replayed).toBe(true);
    expect((await decision(draft.taskId, draft.contractHash)).body.execution.replayed).toBe(true);
    expect(calls).toHaveLength(1); expect(git('status', '--porcelain')).toBe('');
  });

  it.each([{ runtime: 'codex' }, { model: 'gpt-6.1-sol' }, { effort: 'high' },
    { provider: { ...provider, maxRequests: 100 } }])('refuses incompatible provider pins before durable preparation %j', async (override) => {
    expect((await prepare(override)).status).toBe(400); expect(listTaskDrafts(accountId)).toHaveLength(0); expect(calls).toHaveLength(0);
  });

  it('refuses a missing key at launch with zero inference and no native fallback', async () => {
    const prepared = await prepare(); expect(prepared.status).toBe(200);
    delete process.env.OPENROUTER_API_KEY;
    const resolver = await import('@/lib/claude-code/worker-profile'); vi.spyOn(resolver, 'resolveClaudeCodeWorkerGatewayKey').mockResolvedValue(null);
    await decision(prepared.draft!.taskId, prepared.draft!.contractHash);
    expect(calls).toHaveLength(0); expect(existsSync(join(root, 'child.json'))).toBe(false);
    expect(readTaskExecution(prepared.draft!)?.state).toBe('blocked');
  });
  it('serializes concurrent calls and refuses the fifth inference before forwarding', async () => {
    const draft = await launchedTask({ requests: 5 });
    expect(childReceipt().statuses.filter((status: number) => status === 200)).toHaveLength(4);
    expect(childReceipt().statuses.filter((status: number) => status !== 200)).toHaveLength(1);
    expect(calls).toHaveLength(4);
    expect(await replayGateway()).toBe(403); expect(calls).toHaveLength(4);
    await vi.waitFor(async () => expect((await decision(draft.taskId, draft.contractHash, 'inspect')).body.execution.state).toBe('blocked'), { timeout: 10_000 });
  });

  it.each([{ tools: [{ name: 'Bash', input_schema: { type: 'object' } }] }, { model: 'gpt-6.1-sol' }])
    ('refuses child-side model/tool substitution with zero inference %j', async (body) => {
      await launchedTask({ body }); expect(childReceipt().status).toBe(403); expect(calls).toHaveLength(0);
    });

  it('does not trust generated cost fields when authoritative provider cost is missing', async () => {
    cost = null; fakeContentCost = true;
    const draft = await launchedTask({ requests: 2 });
    expect(childReceipt().statuses.every((status: number) => status !== 200)).toBe(true);
    expect(calls).toHaveLength(1);
    await vi.waitFor(async () => expect((await decision(draft.taskId, draft.contractHash, 'inspect')).body.execution.state).toBe('blocked'), { timeout: 10_000 });
    expect((await call('o8_task_result', { machineId: 'gateway-machine', taskId: draft.taskId })).result.completed).toBe(false);
  });

  it('latches the post-charge cost stop before a queued second request', async () => {
    cost = 0.01; await launchedTask({ requests: 2 });
    expect(calls).toHaveLength(1); expect(childReceipt().statuses.every((status: number) => status !== 200)).toBe(true);
    expect(await replayGateway()).toBe(403); expect(calls).toHaveLength(1);
  });

  it('revokes the actual gateway token on Stop and never starts another inference', async () => {
    const draft = await launchedTask({ hold: true }); expect(childReceipt().status).toBe(200);
    const stopped = await decision(draft.taskId, draft.contractHash, 'stop'); expect(stopped.status).toBe(200);
    expect(await replayGateway()).toBe(403); expect(calls).toHaveLength(1);
    expect((await decision(draft.taskId, draft.contractHash)).body.execution.replayed).toBe(true);
  });

  it('refuses further requests after switching accounts and conceals the prior report', async () => {
    const draft = await launchedTask({ hold: true }); await account('user_another_gateway_fixture');
    expect((await readCatalog()).status).toBe(403);
    expect(await replayGateway()).toBe(403); expect(calls).toHaveLength(1);
    expect((await call('o8_task_result', { machineId: 'gateway-machine', taskId: draft.taskId }, 'user_another_gateway_fixture')).status).toBe(404);
  });

  it('refuses response disclosure after the same account changes sign-in epoch while inference is pending', async () => {
    let settle!: () => void; upstreamGate = new Promise<void>((resolve) => { settle = resolve; });
    const prepared = await prepare(); const draft = prepared.draft!;
    expect((await decision(draft.taskId, draft.contractHash)).status).toBe(200);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    await account(); settle();
    await vi.waitFor(() => expect(existsSync(join(root, 'child.json'))).toBe(true), { timeout: 10000 });
    expect(childReceipt().status).toBe(403); expect(calls).toHaveLength(1);
    expect((await call('o8_task_result', { machineId: 'gateway-machine', taskId: draft.taskId })).status).toBe(404);
  });

  it('refuses inference when durable gateway admission cannot be synced', async () => {
    const storage = await import('@/lib/mcp/task-draft-store');
    const original = storage.atomicWriteTaskState;
    vi.spyOn(storage, 'atomicWriteTaskState').mockImplementation((path, value) => {
      if (path.endsWith('controlled-provider-usage.json') && (value as { requests?: number }).requests! > 0) throw new Error('Fixture sync failure');
      original(path, value);
    });
    await launchedTask({ requests: 2 });
    expect(childReceipt().statuses.every((status: number) => status !== 200)).toBe(true); expect(calls).toHaveLength(0);
  });

  it('refuses changed persisted provider limits before actual spawn', async () => {
    const prepared = await prepare(); const draft = prepared.draft!;
    const original = claudeCodeOwnedAdapter.extraSpawnEnv!;
    vi.spyOn(claudeCodeOwnedAdapter, 'extraSpawnEnv').mockImplementation(async (saved) => {
      const env = await original(saved); const execution = readTaskExecution(draft)!;
      const storage = await import('@/lib/mcp/task-execution-store');
      storage.writeTaskExecution({ ...execution, provider: { ...provider, maxRequests: 100 } as unknown as typeof execution.provider });
      return env;
    });
    expect((await decision(draft.taskId, draft.contractHash)).status).toBe(409);
    expect(calls).toHaveLength(0); expect(existsSync(join(root, 'child.json'))).toBe(false);
  });

  it('refuses an options disclosure if account epoch changes while resolving the provider catalog', async () => {
    let release!: (value: string | null) => void;
    const resolver = await import('@/lib/claude-code/worker-profile');
    const entered = vi.spyOn(resolver, 'resolveClaudeCodeWorkerGatewayKey').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = call('o8_task_options', { machineId: 'gateway-machine', repoId, projectId });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled(), { timeout: 10_000 }); await account(); release('sk-or-fixture-parent-only');
    expect((await pending).status).toBe(403); expect(calls).toHaveLength(0);
  });

});
