/**
 * Real reviewer-entry regression for #3016.
 *
 * The fake CLI is the only process stub. The test drives the production review
 * wrapper, backend registry, Codex session launcher, generated CODEX_HOME, and
 * persisted review-turn receipts. Speculative provider prewarms are disabled so
 * this fixture cannot make a provider request.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { NextRequest } from 'next/server';
import { join } from 'node:path';

import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';
import { MODEL_IDS } from '@/lib/models';

import { parse } from 'smol-toml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({
  prewarmHaiku: vi.fn(async () => {}),
}));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({
  prewarmSonnetCli: vi.fn(async () => {}),
}));

const root = mkdtempSync(join(tmpdir(), 'o8-review-config-isolation-'));
const home = join(root, 'home');
const userCodexHome = join(home, '.codex');
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const fakeCodexBin = join(root, 'codex-fixture');
const generatedHomeReceipt = join(root, 'generated-codex-home.txt');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'O8_TEST_REVIEW_INSPECT',
  'O8_TEST_REVIEW_PACKET',
  'O8_TEST_REVIEW_HEAD',
  'O8_API_PORT',
  'O8_REVIEWER_BACKEND',
  'O8_REVIEW_MODEL',
  'O8_THINKING_EFFORT',
  'O8_SUBSCRIPTION_PROFILE',
  'O8_TEST_CODEX_ARGS_RECEIPT',
  'HOME',
  'O8_DATA_DIR',
  'CORTEX_IDE_DATA_DIR',
  'O8_CODEX_BIN',
  'O8_CRASH_SURVIVABLE_ORCHESTRATOR',
  'O8_TEST_CODEX_HOME_RECEIPT',
  'O8_WORKER_ENV_ALLOW',
] as const;
for (const key of envKeys) priorEnv.set(key, process.env[key]);

mkdirSync(userCodexHome, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(join(userCodexHome, 'config.toml'), [
  'model_provider = "fixture-provider"',
  '',
  '[features]',
  'web_search = false',
  '',
  '[model_providers.fixture-provider]',
  'name = "Fixture provider"',
  'base_url = "http://127.0.0.1:43123/v1"',
  '',
  '[projects."/tmp/review-fixture"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers."poison-reviewer"]',
  'command = "fixture-must-not-run"',
].join('\n'));
writeFileSync(fakeCodexBin, [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then',
  '  printf "codex-cli 0.150.0\\n"',
  '  exit 0',
  'fi',
  'printf "%s\\n" "$@" > "$O8_TEST_CODEX_ARGS_RECEIPT"',
  'printf "%s" "$CODEX_HOME" > "$O8_TEST_CODEX_HOME_RECEIPT"',
  'if [ -n "$O8_TEST_REVIEW_INSPECT" ]; then',
  '  exec node "$O8_TEST_REVIEW_INSPECT" "$@"',
  'fi',
  'if grep -q "poison-reviewer" "$CODEX_HOME/config.toml"; then',
  '  printf "unrelated MCP reached reviewer\\n" >&2',
  '  exit 86',
  'fi',
  'printf "%s\\n" \'{"type":"thread.started","thread_id":"fixture-review-thread"}\'',
  'printf "%s\\n" \'{"type":"item.completed","item":{"type":"agent_message","text":"CODEX_AUTO_REVIEW: {\\"approved\\":true,\\"findings\\":[]}"}}\'',
  'printf "%s\\n" \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'',
].join('\n'), { mode: 0o700 });
chmodSync(fakeCodexBin, 0o700);

execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
writeFileSync(join(repoPath, 'README.md'), '# review fixture\n');
execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
execFileSync('git', [
  '-c', 'user.name=o8 test',
  '-c', 'user.email=test@o8.local',
  'commit', '-qm', 'test: review fixture',
], { cwd: repoPath });

delete process.env.O8_REVIEW_MODEL;
process.env.O8_THINKING_EFFORT = 'medium';
process.env.O8_SUBSCRIPTION_PROFILE = 'both';
process.env.O8_TEST_CODEX_ARGS_RECEIPT = join(root, 'args.txt');
process.env.HOME = home;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodexBin;
process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '1';
process.env.O8_TEST_CODEX_HOME_RECEIPT = generatedHomeReceipt;
// Children inherit only allowlisted names (#4585); pass the fake codex its receipt and inspect knobs.
process.env.O8_WORKER_ENV_ALLOW = ['O8_TEST_CODEX_ARGS_RECEIPT', 'O8_TEST_CODEX_HOME_RECEIPT',
  'O8_TEST_REVIEW_INSPECT', 'O8_TEST_REVIEW_PACKET', 'O8_TEST_REVIEW_HEAD'].join(',');

const { closeDb } = await import('@/lib/db');
const { getLaneEvents, createLane } = await import('@/lib/lane/registry');
const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
const { runReviewerTurnWithQuotaFallback } = await import('@/lib/lane/review-quota-fallback');
const { listRoleRoutingReceipts } = await import('@/lib/operator/role-routing-ledger');

afterEach(() => { delete process.env.O8_REVIEW_MODEL; });

let server: Server;
let apiBase = '';
const token = 'review-runtime-receipt-fixture-token';
writeFileSync(join(dataDir, 'ws-token'), token);
beforeAll(async () => {
  const { panelGateMiddleware } = await import('@/middleware');
  const mcp = await import('@/app/api/mcp/route');
  const events = await import('@/app/api/lanes/[id]/events/route');
  const review = await import('@/app/api/review/auto-review/route');
  server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const url = new URL(req.url!, apiBase);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const request = new NextRequest(url, {method: req.method, headers,
        ...(chunks.length ? {body: Buffer.concat(chunks).toString()} : {})});
      const auth = panelGateMiddleware(request);
      const match = url.pathname.match(/^\/api\/lanes\/([^/]+)\/events$/);
      const response = auth.status !== 200 ? auth : url.pathname === '/api/mcp' ? await mcp.POST(request)
        : url.pathname === '/api/review/auto-review' ? await review.POST(request)
        : match ? await events.GET(request, {params: Promise.resolve({id: decodeURIComponent(match[1])})})
        : new Response('missing', {status: 404});
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch { res.writeHead(500); res.end('fixture request failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as {port: number};
  apiBase = `http://127.0.0.1:${address.port}`; process.env.O8_API_PORT = String(address.port);
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('Codex automatic-review config isolation', () => {
  it('launches through the reviewer entry point with only app-emitted MCP servers', async () => {
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/review-config-isolation',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-review-config-isolation',
    });
    const codex = getOrchestratorBackend('codex');

    const result = await runReviewerTurnWithQuotaFallback({
      laneId: lane.id,
      repoPath,
      threadId: `auto-review-${lane.id}-config-isolation`,
      surface: 'auto-review',
      prompt: 'Review the complete packet.',
      initialBackend: codex,
      backendResolver: () => codex,
    });

    expect(result).toMatchObject({
      ok: true,
      backend: 'codex',
      text: 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}',
      errors: [],
    });

    const generatedHome = readFileSync(generatedHomeReceipt, 'utf8');
    const generated = parse(readFileSync(join(generatedHome, 'config.toml'), 'utf8')) as {
      features?: Record<string, unknown>;
      model_providers?: Record<string, unknown>;
      projects?: Record<string, unknown>;
      mcp_servers?: Record<string, unknown>;
    };
    expect(generated.features).toEqual({ web_search: false });
    expect(generated.model_providers).toHaveProperty('fixture-provider');
    expect(generated.projects).toHaveProperty('/tmp/review-fixture');
    expect(generated.mcp_servers).not.toHaveProperty('poison-reviewer');
    expect(generated.mcp_servers).toEqual(expect.objectContaining({
      operator: expect.any(Object),
      cortex: expect.any(Object),
    }));

    expect(getLaneEvents(lane.id).findLast((event) => event.verb === 'review_turn_finished')).toMatchObject({
      payload: { outcome: 'completed' },
    });
    expect(listRoleRoutingReceipts({ role: 'review', repoPath })[0]).toMatchObject({
      contextType: 'auto-review',
      contextId: lane.id,
      status: 'selected',
    });
  });
});

function reviewInput(initialBackend = getOrchestratorBackend('codex')) {
  const lane = createLane({ repoPath, branch: 'inline/review-model', runtime: 'codex' });
  return { laneId: lane.id, repoPath, threadId: `review-model-${lane.id}`, surface: 'auto-review' as const,
    prompt: 'Review the complete packet.', initialBackend };
}
function backend(id: 'codex' | 'claude', quota = false): OrchestratorBackend {
  return { id, label: id, peekSession: () => null,
    ensureSession: vi.fn(() => ({ sessionName: 'fixture', status: 'ready' as const })),
    sendTurn: vi.fn(async (_repo, _prompt, emit, options) => {
      emit({type: 'turn_receipt', leadModel: options?.model ?? (id === 'codex' ? MODEL_IDS.codexDefault : MODEL_IDS.raw.anthropicClaudeSonnet5), effort: options?.thinkingEffort ?? 'medium'});
      if (quota) emit({ type: 'error', error: 'You have hit your usage limit.', code: 'usage_limit_reached' });
      else emit({ type: 'text', text: 'complete review' });
    }) };
}
function receipt(contextId: string) {
  closeDb(); // Reopen persisted routing, rather than asserting an in-memory spy.
  return listRoleRoutingReceipts({ role: 'review', repoPath }).find((row) => row.contextId === contextId);
}

describe('process-scoped dedicated Codex review model', () => {
  it.each([undefined, MODEL_IDS.raw.openAiGpt61Sol])('sends %s through the real Codex CLI and persisted route', async (choice) => {
    if (choice) process.env.O8_REVIEW_MODEL = choice;
    const input = reviewInput();
    const spy = vi.spyOn(input.initialBackend, 'sendTurn');
    try {
      expect((await runReviewerTurnWithQuotaFallback(input)).ok).toBe(true);
      const model = choice ?? MODEL_IDS.codexDefault;
      expect(spy.mock.calls.at(-1)?.[3]).toMatchObject({ model, thinkingEffort: 'medium' });
      const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
      expect(args).toContain(`model=${model}`);
      expect(args).toContain('model_reasoning_effort=medium');
      expect(receipt(input.laneId)).toMatchObject({ requested: { model, effort: 'medium' },
        effective: { model, effort: 'medium' }, sources: { model: choice ? 'env' : 'derived', effort: 'env' } });
    } finally { spy.mockRestore(); }
  });

  it.each(['', 'unknown-model', MODEL_IDS.raw.anthropicClaudeSonnet5, 'ollama:fixture', 'gpt-6.1-sol\nextra'])('refuses invalid explicit %s before any session or inference', async (model) => {
    process.env.O8_REVIEW_MODEL = model;
    const input = reviewInput(backend('codex'));
    const result = await runReviewerTurnWithQuotaFallback(input);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('O8_REVIEW_MODEL');
    expect(input.initialBackend.ensureSession).not.toHaveBeenCalled();
    expect(input.initialBackend.sendTurn).not.toHaveBeenCalled();
    expect(receipt(input.laneId)).toMatchObject({ status: 'refused', effective: null });
  });

  it('refuses a Codex choice on a different initial reviewer backend', async () => {
    process.env.O8_REVIEW_MODEL = MODEL_IDS.raw.openAiGpt61Sol;
    const input = reviewInput(backend('claude'));
    expect((await runReviewerTurnWithQuotaFallback(input)).ok).toBe(false);
    expect(input.initialBackend.ensureSession).not.toHaveBeenCalled();
    expect(receipt(input.laneId)).toMatchObject({ status: 'refused', effective: null });
  });

  it('keeps cross-house target and persisted source models truthful', async () => {
    process.env.O8_REVIEW_MODEL = MODEL_IDS.raw.openAiGpt61Sol;
    const input = reviewInput(backend('codex', true));
    const target = backend('claude');
    const result = await runReviewerTurnWithQuotaFallback({ ...input, backendResolver: () => target });
    expect(result.ok).toBe(true);
    expect(result.fallback?.fromModel).toBe(MODEL_IDS.raw.openAiGpt61Sol);
    const routes = getLaneEvents(input.laneId).filter(e=>e.payload.event==='review_turn_runtime_receipt');
    expect(routes).toHaveLength(2);
    expect(routes[0].payload).toMatchObject({backend:'codex',runtimeRoute:{model:MODEL_IDS.raw.openAiGpt61Sol}});
    expect(routes[1].payload).toMatchObject({backend:'claude',runtimeRoute:{model:result.fallback?.toModel},reviewTurnId:result.reviewTurnId});
    expect(routes[0].payload.reviewTurnId).not.toBe(routes[1].payload.reviewTurnId);
    expect(target.sendTurn).toHaveBeenCalledWith(repoPath, input.prompt, expect.any(Function),
      expect.objectContaining({ model: result.fallback?.toModel }));
    expect(receipt(input.laneId)).toMatchObject({ requested: { model: MODEL_IDS.raw.openAiGpt61Sol },
      effective: { backend: 'claude', model: result.fallback?.toModel }, sources: { model: 'derived' }, status: 'fallback' });
  });

  it('records a runtime-reported model and effort substitution honestly', async () => {
    process.env.O8_REVIEW_MODEL = MODEL_IDS.raw.openAiGpt61Sol;
    const target = backend('codex');
    vi.mocked(target.sendTurn).mockImplementation(async (_repo, _prompt, emit) => {
      emit({ type: 'turn_receipt', leadModel: MODEL_IDS.raw.openAiGpt56Sol, effort: 'low' });
      emit({ type: 'text', text: 'complete review' });
    });
    const input = reviewInput(target);
    expect((await runReviewerTurnWithQuotaFallback(input)).ok).toBe(true);
    expect(receipt(input.laneId)).toMatchObject({ requested: { model: MODEL_IDS.raw.openAiGpt61Sol, effort: 'medium' },
      effective: { model: MODEL_IDS.raw.openAiGpt56Sol, effort: 'low' }, sources: { model: 'derived', effort: 'derived' } });
  });

  it('preserves the baseline cross-house tier and passes medium to the actual Codex fallback CLI', async () => {
    const input = reviewInput(backend('claude', true));
    const result = await runReviewerTurnWithQuotaFallback({ ...input, backendResolver: getOrchestratorBackend });
    expect(result.ok).toBe(true);
    expect(result.fallback).toMatchObject({ toBackend: 'codex', modelTier: 'reviewMechanical',
      toModel: MODEL_IDS.raw.openAiGpt56Terra });
    const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
    expect(args).toContain(`model=${result.fallback?.toModel}`);
    expect(args).toContain('model_reasoning_effort=medium');
    expect(receipt(input.laneId)).toMatchObject({ effective: { backend: 'codex', model: result.fallback?.toModel, effort: 'medium' },
      sources: { model: 'derived' }, status: 'fallback' });
  });

  it('refuses a resolver that supplies a mismatched fallback backend', async () => {
    const input = reviewInput(backend('codex', true));
    const wrongTarget = backend('codex');
    expect((await runReviewerTurnWithQuotaFallback({ ...input, backendResolver: () => wrongTarget })).ok).toBe(false);
    expect(wrongTarget.ensureSession).not.toHaveBeenCalled();
    expect(wrongTarget.sendTurn).not.toHaveBeenCalled();
    expect(receipt(input.laneId)).toMatchObject({ status: 'refused', effective: null });
  });
});


it('binds canonical reviewer execution before authenticated mission_tail and the independent verdict', async () => {
  process.env.O8_REVIEW_MODEL = MODEL_IDS.raw.openAiGpt61Sol;
  process.env.O8_REVIEWER_BACKEND = 'codex';
  const branch = 'inline/runtime-receipt';
  execFileSync('git', ['checkout', '-qb', branch], {cwd: repoPath});
  writeFileSync(join(repoPath, 'FIRST_RUN.txt'), 'first-run proof done\n');
  execFileSync('git', ['add', 'FIRST_RUN.txt'], {cwd: repoPath});
  execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-qm', 'test: reviewed file'], {cwd: repoPath});
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repoPath, encoding: 'utf8'}).trim();
  const packetId = 'pkt-runtime-receipt';
  const lane = createLane({repoPath, worktreePath: repoPath, branch, baseBranch: 'main', runtime: 'codex', packetId});
  const script = join(root, 'inspect-runtime.mjs');
  const inspected = join(root, 'runtime-inspection.json');
  writeFileSync(script, `
    import {readFileSync,writeFileSync} from 'node:fs';
    import {execFileSync} from 'node:child_process';
    const reply = await fetch('http://127.0.0.1:'+process.env.O8_API_PORT+'/api/mcp', {
      method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+readFileSync(process.env.O8_DATA_DIR+'/ws-token','utf8')},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'mission_tail',arguments:{packetId:process.env.O8_TEST_REVIEW_PACKET,since:0}}}),
    });
    const result = await reply.json();
    const data = JSON.parse(result.result.content[0].text).data;
    writeFileSync(${JSON.stringify(inspected)}, JSON.stringify({http:reply.status,result:data,argv:process.argv.slice(2)}));
    const route = data.events.findLast(e => e.payload?.event === 'review_turn_runtime_receipt')?.payload;
    const files = execFileSync('git',['diff','--name-only','main...HEAD'],{encoding:'utf8'}).trim();
    const artifact = readFileSync('FIRST_RUN.txt','utf8');
    const approved = route?.status==='observed' && route.expectedHeadSha===process.env.O8_TEST_REVIEW_HEAD
      && route.runtimeRoute?.model==='gpt-6.1-sol' && route.runtimeRoute?.effort==='medium'
      && files==='FIRST_RUN.txt' && artifact===${JSON.stringify('first-run proof done\n')};
    console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-runtime-review'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'CODEX_AUTO_REVIEW: '+JSON.stringify({approved,findings:approved?[]:[{severity:'P2',file:'FIRST_RUN.txt',line:1,title:'Execution receipt unavailable',description:'Runtime route is not proven.'}]})}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  `);
  process.env.O8_TEST_REVIEW_INSPECT = script;
  process.env.O8_TEST_REVIEW_PACKET = packetId;
  process.env.O8_TEST_REVIEW_HEAD = head;
  try {
    const { setLaneStatus } = await import('@/lib/lane/registry');
    const { drainReviewQueue } = await import('@/lib/lane/auto-review');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const denied = await fetch(`${apiBase}/api/mcp`, {method: 'POST', headers: {'content-type':'application/json'}, body:'{}'});
    expect(denied.status).toBe(401);
    const response = await fetch(`${apiBase}/api/review/auto-review`, {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({action:'enqueue',laneId:lane.id})});
    expect(response.status).toBe(200);
    await drainReviewQueue();
    const proof = JSON.parse(readFileSync(inspected,'utf8'));
    if (process.env.O8_TEST_REVIEW_RUNTIME_PROOF) writeFileSync(process.env.O8_TEST_REVIEW_RUNTIME_PROOF, JSON.stringify(proof));
    expect(proof.http).toBe(200);
    const route = proof.result.events.findLast((e: {payload: Record<string, unknown>}) => e.payload?.event === 'review_turn_runtime_receipt')?.payload;
    expect(route).toMatchObject({status:'observed',source:'backend-turn-receipt',expectedHeadSha:head,
      backend:'codex',surface:'auto-review',sessionThreadId:'thoughts-auto-review-primary-0',
      runtimeRoute:{model:MODEL_IDS.raw.openAiGpt61Sol,effort:'medium'}});
    expect(route.threadId).toContain(`auto-review-${lane.id}-`);
    expect(proof.argv).toContain('model=gpt-6.1-sol');
    expect(proof.argv).toContain('model_reasoning_effort=medium');
    const { listApprovalsForContext } = await import('@/lib/approvals/store');
    const approvals = listApprovalsForContext({packetId,laneId:lane.id}).filter(a=>a.toolName==='orchestrator_review');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({status:'approved',args:{reviewedHeadSha:head,reviewTurnId:route.reviewTurnId}});
    const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
    const mergeGate = await assessDurableApprovedReview(lane);
    expect(mergeGate).toMatchObject({approved:true});
    if (process.env.O8_TEST_REVIEW_RUNTIME_PROOF) writeFileSync(`${process.env.O8_TEST_REVIEW_RUNTIME_PROOF}.verdict`, JSON.stringify({approvals,mergeGate,events:getLaneEvents(lane.id)}));
    closeDb();
    expect(getLaneEvents(lane.id).some(e=>e.payload.event==='review_turn_runtime_receipt')).toBe(true);
  } finally {
    delete process.env.O8_TEST_REVIEW_INSPECT;
    delete process.env.O8_TEST_REVIEW_PACKET;
    delete process.env.O8_TEST_REVIEW_HEAD;
  }
}, 60_000);


it('keeps missing and conflicting backend routes unknown, and repeated identical receipts idempotent', async () => {
  process.env.O8_REVIEW_MODEL = MODEL_IDS.raw.openAiGpt61Sol;
  for (const kind of ['missing', 'identical', 'conflicting'] as const) {
    const target = backend('codex');
    vi.mocked(target.sendTurn).mockImplementation(async (_repo, _prompt, emit) => {
      if (kind !== 'missing') {
        emit({type:'turn_receipt',leadModel:MODEL_IDS.raw.openAiGpt61Sol,effort:'medium'});
        emit({type:'turn_receipt',leadModel:kind === 'conflicting' ? MODEL_IDS.raw.openAiGpt56Sol : MODEL_IDS.raw.openAiGpt61Sol,effort:'medium'});
        emit({type:'turn_receipt',leadModel:MODEL_IDS.raw.openAiGpt61Sol,effort:'medium'});
      }
      emit({type:'text',text:'Artifact reviewed.'});
    });
    const input = reviewInput(target);
    const result = await runReviewerTurnWithQuotaFallback({...input,expectedHeadSha:'a'.repeat(40)});
    expect(result.ok).toBe(kind !== 'conflicting');
    const events = getLaneEvents(input.laneId).filter(e=>e.payload.event==='review_turn_runtime_receipt');
    expect(events).toHaveLength(kind==='missing' ? 0 : kind==='identical' ? 1 : 2);
    expect(receipt(input.laneId)?.effective).toEqual(kind==='identical' ? expect.objectContaining({model:MODEL_IDS.raw.openAiGpt61Sol,effort:'medium'}) : null);
    if (kind==='conflicting') expect(events.at(-1)?.payload).toMatchObject({status:'conflicting',runtimeRoute:null});
  }
});

it('refuses foreign, stale and changed attempt bindings without writing execution evidence', async () => {
  const {startReviewTurn,finishReviewTurn,recordReviewTurnRuntimeReceipt} = await import('@/lib/lane/review-turn-state');
  const lane = createLane({repoPath,branch:'inline/receipt-binding',runtime:'codex'});
  const input = {laneId:lane.id,threadId:'attempt-receipt-binding',sessionThreadId:'thoughts-auto-review-primary-0',backend:'codex',surface:'auto-review',expectedHeadSha:'b'.repeat(40)};
  const reviewTurnId = startReviewTurn(input);
  const bound = {...input,reviewTurnId,model:MODEL_IDS.raw.openAiGpt61Sol,effort:'medium' as const};
  for (const changed of [{laneId:'foreign-lane'}, {reviewTurnId:'foreign-turn'}, {threadId:'foreign-attempt'},
    {sessionThreadId:'foreign-pool'}, {backend:'claude'}, {surface:'buyin-doc'}, {expectedHeadSha:'c'.repeat(40)}]) {
    expect(recordReviewTurnRuntimeReceipt({...bound,...changed})).toBe('refused');
  }
  expect(getLaneEvents(lane.id).filter(e=>e.payload.event==='review_turn_runtime_receipt')).toHaveLength(0);
  expect(recordReviewTurnRuntimeReceipt(bound)).toBe('observed');
  finishReviewTurn({laneId:lane.id,reviewTurnId,outcome:'completed'});
  expect(recordReviewTurnRuntimeReceipt(bound)).toBe('refused');
  expect(getLaneEvents(lane.id).filter(e=>e.payload.event==='review_turn_runtime_receipt')).toHaveLength(1);
});


it('does not carry the first attempt execution proof into a fallback with no receipt', async () => {
  process.env.O8_REVIEW_MODEL = MODEL_IDS.raw.openAiGpt61Sol;
  const input = reviewInput(backend('codex',true));
  const target = backend('claude');
  vi.mocked(target.sendTurn).mockImplementation(async (_repo,_prompt,emit) => {
    emit({type:'text',text:'Artifact reviewed without an execution receipt.'});
  });
  const result = await runReviewerTurnWithQuotaFallback({...input,backendResolver:()=>target});
  expect(result).toMatchObject({ok:true,backend:'claude'});
  expect(receipt(input.laneId)).toMatchObject({status:'fallback',effective:null});
  const routes = getLaneEvents(input.laneId).filter(e=>e.payload.event==='review_turn_runtime_receipt');
  expect(routes).toHaveLength(1);
  expect(routes[0].payload).toMatchObject({backend:'codex',runtimeRoute:{model:MODEL_IDS.raw.openAiGpt61Sol}});
  expect(routes[0].payload.reviewTurnId).not.toBe(result.reviewTurnId);
});
