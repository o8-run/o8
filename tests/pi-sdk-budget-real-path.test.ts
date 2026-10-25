import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Model } from '@earendil-works/pi-ai';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import { initializePiTestBudget, reservePiTestRequest, readPiTestBudget, type ManagedPiBillingContract } from '@/lib/pi/sdk/test-budget';
import { createBudgetedPiTestTransport } from '@/lib/pi/sdk/test-transport';
import { O8_MANAGED_FLASH_LITE_MODEL } from '@/lib/pi/sdk/live-contract';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions',
  provider: 'o8-managed', baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // Any model on the managed endpoint must send only the fields it accepts.
  compat: O8_MANAGED_FLASH_LITE_MODEL.compat };
function contract(): ManagedPiBillingContract {
  return { id: 'synthetic-v1', modelId: 'fixture', endpoint: 'https://managed.example/v1/inference',
    evidence: 'Offline synthetic contract, never a live pricing source', expiresAt: Date.now() + 60_000,
    coverage: 'all-including-failed-requests', contextWindow: 16000,
    maxRequestBytes: 16000, maxBillableInputTokens: 16000, maxBillableOutputTokens: 128,
    inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000,
    fixedMicroUsdPerRequest: 0, maxCalls: 3 };
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'o8-pi-budget-')); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  return { root, workspace, ledgerPath: join(root, 'budget.sqlite') }; }
const route = async () => ({ via: 'proxy' as const, url: 'https://managed.example/v1/inference', headers: { Authorization: 'Bearer synthetic-secret' } });
function answer() { return new Response('data: {"choices":[{"delta":{"content":"Synthetic answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
async function collect(transport: ReturnType<typeof createBudgetedPiTestTransport>) { const events = [];
  for await (const event of transport({ messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] }, new AbortController().signal)) events.push(event);
  return events; }

describe('managed Pi live-test budget boundary', () => {
  it('refuses the retired live default before any route or request', async () => {
    const f = await fixture(); const c = contract(); let calls = 0;
    initializePiTestBudget(f.ledgerPath, 1_000_000, c);
    const transport = createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace,
      resolveRoute: async () => { calls++; return route(); }, fetch: async () => { calls++; return answer(); } });
    await expect(collect(transport)).rejects.toThrow('A trusted hosted billing contract is required');
    expect(calls).toBe(0);
  });
  it('refuses a model mismatch against a synthetic contract before any route or request', async () => {
    const f = await fixture(); const c = contract(); let calls = 0;
    initializePiTestBudget(f.ledgerPath, 1_000_000, c);
    const transport = createBudgetedPiTestTransport({ model: { ...model, id: 'other-fixture' },
      ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c,
      resolveRoute: async () => { calls++; return route(); }, fetch: async () => { calls++; return answer(); } });
    await expect(collect(transport)).rejects.toThrow('does not match the trusted billing contract');
    expect(calls).toBe(0);
  });
  it('reserves conservative complete-request cost before real SDK worker fetch and persists across sessions', async () => {
    const f = await fixture(); const c = contract(); initializePiTestBudget(f.ledgerPath, 40_000, c);
    const workspace = f.workspace; let calls = 0;
    const transport = () => createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c, resolveRoute: route,
      fetch: async (_url, init) => { calls++; const ledger = readPiTestBudget(f.ledgerPath);
        expect(ledger.reservedMicroUsd).toBe(16_256 * calls); expect(ledger.pending).toBe(1);
        const body = JSON.parse(String(init?.body)); expect(body.max_tokens ?? body.max_completion_tokens).toBe(128); return answer(); } });
    for (let run = 0; run < 2; run++) {
      const session = await createPiSdkSession({ workspace, stateDir: join(f.root, `state-${run}`), model, transport: transport() });
      try { expect((await session.prompt('Synthetic test')).text).toBe('Synthetic answer'); } finally { await session.close(); }
    }
    expect(readPiTestBudget(f.ledgerPath)).toMatchObject({ limitMicroUsd: 40_000, reservedMicroUsd: 32_512, calls: 2, pending: 0 });
    expect((await collect(transport())).at(-1)?.type).toBe('error'); expect(calls).toBe(2);
  }, 15000);
  it('retains ambiguous request reservations after a network failure and blocks further fetches', async () => {
    const f = await fixture(); const c = contract(); initializePiTestBudget(f.ledgerPath, 1_000_000, c); let calls = 0;
    const t = () => createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c, resolveRoute: route,
      fetch: async () => { calls++; throw new Error('synthetic-private-error'); } });
    expect((await collect(t())).at(-1)?.type).toBe('error'); expect(calls).toBe(1);
    expect(readPiTestBudget(f.ledgerPath)).toMatchObject({ reservedMicroUsd: 16_256, unknown: 1 });
    expect((await collect(t())).at(-1)?.type).toBe('error'); expect(calls).toBe(1);
    expect((await readFile(f.ledgerPath)).includes(Buffer.from('synthetic-private-error'))).toBe(false);
  });
  it('rejects expired, changed, over-limit, and incomplete contracts without network', async () => {
    const f = await fixture(); const c = contract(); initializePiTestBudget(f.ledgerPath, 1_000_000, c);
    expect(() => initializePiTestBudget(f.ledgerPath, 1_000_000, c)).toThrow();
    expect(() => initializePiTestBudget(join(f.root, 'over.sqlite'), 1_000_001, c)).toThrow();
    let calls = 0;
    for (const changed of [{ ...c, expiresAt: 0 }, { ...c, id: 'different' }, { ...c, inputMicroUsdPerMillion: -1 }]) {
      const t = createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => changed, resolveRoute: route,
        fetch: async () => { calls++; return answer(); } });
      await collect(t).catch(() => {});
    }
    expect(calls).toBe(0); expect(readPiTestBudget(f.ledgerPath).calls).toBe(0);
  });
  it('counts the fully serialized body and denies oversize input before reserving or fetching', async () => {
    const f = await fixture(); const c = { ...contract(), maxRequestBytes: 8 }; initializePiTestBudget(f.ledgerPath, 1_000_000, c); let calls = 0;
    const t = createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c, resolveRoute: route,
      fetch: async () => { calls++; return answer(); } });
    expect((await collect(t)).at(-1)?.type).toBe('error'); expect(calls).toBe(0); expect(readPiTestBudget(f.ledgerPath).calls).toBe(0);
  });
  it('allows only one reservation across simultaneous processes and refuses crash leftovers', async () => {
    const f = await fixture(); const c = contract(); initializePiTestBudget(f.ledgerPath, 1_000_000, c);
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/pi-budget-reserve.ts', f.ledgerPath, JSON.stringify(c)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.on('error', reject); child.on('exit', () => resolve(output.trim()));
    });
    const results = await Promise.all([run(), run()]); expect(results.sort()).toEqual(['denied', 'reserved']);
    expect(readPiTestBudget(f.ledgerPath)).toMatchObject({ calls: 1, pending: 1, reservedMicroUsd: 16_256 });
    expect(() => reservePiTestRequest(f.ledgerPath, c)).toThrow();
  }, 15000);
  it('blocks incomplete usage and cancellation without returning the reservation', async () => {
    const f = await fixture(); const c = contract(); initializePiTestBudget(f.ledgerPath, 1_000_000, c);
    const t = createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c, resolveRoute: route,
      fetch: async () => new Response('data: {"choices":[{"delta":{"content":"no usage"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    await expect(collect(t)).rejects.toThrow('Usage');
    expect(readPiTestBudget(f.ledgerPath)).toMatchObject({ unknown: 1, reservedMicroUsd: 16_256 });
    const another = await fixture(); initializePiTestBudget(another.ledgerPath, 1_000_000, c);
    const abort = new AbortController(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const cancelled = createBudgetedPiTestTransport({ model, ledgerPath: another.ledgerPath, workspace: another.workspace, resolveContract: async () => c, resolveRoute: route,
      fetch: async (_url, init) => { entered(); await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); return answer(); } });
    const consume = (async () => { for await (const _event of cancelled({ messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] }, abort.signal)) { /* drain */ } })();
    await started; abort.abort(); await consume;
    expect(readPiTestBudget(another.ledgerPath)).toMatchObject({ unknown: 1, reservedMicroUsd: 16_256 });
  });

  it('rounds fractional micro-dollar cost upward and never resets a missing ledger', async () => {
    const f = await fixture(); const c = { ...contract(), inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1, fixedMicroUsdPerRequest: 3 };
    initializePiTestBudget(f.ledgerPath, 5, c); reservePiTestRequest(f.ledgerPath, c);
    expect(readPiTestBudget(f.ledgerPath).reservedMicroUsd).toBe(5);
    const missing = join(f.root, 'missing.sqlite'); expect(() => reservePiTestRequest(missing, c)).toThrow();
    await expect(readFile(missing)).rejects.toThrow();
  });
  it('rejects a model or endpoint different from the trusted contract before fetch', async () => {
    const f = await fixture(); const c = contract(); initializePiTestBudget(f.ledgerPath, 1_000_000, c); let calls = 0;
    const wrongModel = createBudgetedPiTestTransport({ model: { ...model, id: 'other' }, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c,
      resolveRoute: route, fetch: async () => { calls++; return answer(); } });
    await expect(collect(wrongModel)).rejects.toThrow('model');
    const wrongEndpoint = createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c,
      resolveRoute: async () => ({ ...(await route()), url: 'https://different.example/v1/inference' }), fetch: async () => { calls++; return answer(); } });
    expect((await collect(wrongEndpoint)).at(-1)?.type).toBe('error'); expect(calls).toBe(0);
    expect(readPiTestBudget(f.ledgerPath).reservedMicroUsd).toBe(0);
  });

  it.each([{ prompt_tokens: -9, completion_tokens: 2, total_tokens: -7 }, { prompt_tokens: 5 }, { completion_tokens: 2 }, { prompt_tokens: '5', completion_tokens: 2, total_tokens: 7 },
    { prompt_tokens: 5, completion_tokens: 2, total_tokens: 2 }])('blocks partial or malformed raw usage %j', async usage => {
    const f = await fixture(); const c = contract(); initializePiTestBudget(f.ledgerPath, 1_000_000, c);
    const chunk = { choices: [{ delta: { content: 'synthetic' }, finish_reason: 'stop' }], usage };
    const t = createBudgetedPiTestTransport({ model, ledgerPath: f.ledgerPath, workspace: f.workspace, resolveContract: async () => c, resolveRoute: route,
      fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) });
    await expect(collect(t)).rejects.toThrow('Usage');
    expect(readPiTestBudget(f.ledgerPath)).toMatchObject({ unknown: 1, reservedMicroUsd: 16_256 });
  });

  it('rechecks expiry after another process held the admission lock', async () => {
    const f = await fixture(); const c = { ...contract(), expiresAt: Date.now() + 900 }; initializePiTestBudget(f.ledgerPath, 1_000_000, c);
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/pi-budget-lock.ts', f.ledgerPath, '1200'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
    expect(() => reservePiTestRequest(f.ledgerPath, c)).toThrow('expired'); await exit;
    expect(readPiTestBudget(f.ledgerPath)).toMatchObject({ reservedMicroUsd: 0, calls: 0 });
  });

  it.each(['budget.sqlite', '..budget.sqlite'])('refuses in-workspace ledger %s', async filename => {
    const f = await fixture(); const c = contract(); const ledgerPath = join(f.workspace, filename);
    initializePiTestBudget(ledgerPath, 1_000_000, c); let calls = 0;
    const t = createBudgetedPiTestTransport({ model, ledgerPath, workspace: f.workspace, resolveContract: async () => c, resolveRoute: route,
      fetch: async () => { calls++; return answer(); } });
    await expect(collect(t)).rejects.toThrow('outside'); expect(calls).toBe(0);
  });

  it('refuses SDK state hidden under a dot-prefixed in-workspace directory', async () => {
    const f = await fixture();
    await expect(createPiSdkSession({ workspace: f.workspace, stateDir: join(f.workspace, '..owned'), model })).rejects.toThrow('outside');
  });

});
