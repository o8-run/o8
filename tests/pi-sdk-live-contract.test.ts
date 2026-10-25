import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGED_INFERENCE_BODY_FIELDS, O8_MANAGED_FLASH_LITE_CONTRACT, O8_MANAGED_FLASH_LITE_MODEL } from '@/lib/pi/sdk/live-contract';
import { initializePiTestBudget, maximumPiRequestCost, readPiTestBudget, validatePiBillingContract } from '@/lib/pi/sdk/test-budget';
import { createBudgetedPiTestTransport, resolveLivePiTestContract } from '@/lib/pi/sdk/test-transport';

// Fields api.o8.run/v1/inference accepts, plus the three it strips first.
const SERVER_FIELDS = new Set(['model', 'messages', 'max_tokens', 'stream', 'temperature', 'top_p',
  'tools', 'tool_choice', 'response_format', 'stop', 'stream_options', 'usage']);
const roots: string[] = [];
// Offline checks run inside the contract window; expiry itself is asserted below.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(O8_MANAGED_FLASH_LITE_CONTRACT.expiresAt - 86_400_000);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runOnce(model = O8_MANAGED_FLASH_LITE_MODEL) {
  const root = await mkdtemp(join(tmpdir(), 'o8-pi-live-contract-')); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const ledgerPath = join(root, 'budget.sqlite');
  initializePiTestBudget(ledgerPath, 1_000_000, O8_MANAGED_FLASH_LITE_CONTRACT);
  let body: Record<string, unknown> | undefined;
  let fetches = 0;
  const transport = createBudgetedPiTestTransport({
    model, ledgerPath, workspace,
    resolveRoute: async () => ({ via: 'proxy' as const, url: O8_MANAGED_FLASH_LITE_CONTRACT.endpoint, headers: { Authorization: 'Bearer synthetic-secret' } }),
    fetch: async (_url, init) => {
      fetches += 1;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const context = {
    systemPrompt: 'Synthetic system prompt.',
    messages: [{ role: 'user' as const, content: 'hello', timestamp: Date.now() }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  };
  let error: string | undefined;
  try {
    for await (const event of transport(context as never, new AbortController().signal)) {
      if (event.type === 'error') error = event.error.errorMessage ?? 'error';
    }
  }
  catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  return { body, fetches, error, ledger: readPiTestBudget(ledgerPath) };
}

describe('verified managed Pi live contract', () => {
  it('is the live default and bounds every request at 17,696 micro-USD', async () => {
    const live = await resolveLivePiTestContract();
    expect(live).toEqual(O8_MANAGED_FLASH_LITE_CONTRACT);
    expect(() => validatePiBillingContract(live!)).not.toThrow();
    expect(maximumPiRequestCost(live!)).toBe(17_696);
    expect(maximumPiRequestCost(live!) * live!.maxCalls).toBeLessThan(1_000_000);
    expect(O8_MANAGED_FLASH_LITE_MODEL.id).toBe(live!.modelId);
    expect(O8_MANAGED_FLASH_LITE_MODEL.contextWindow).toBe(live!.contextWindow);
  });

  it('refuses the contract once it expires', async () => {
    vi.setSystemTime(O8_MANAGED_FLASH_LITE_CONTRACT.expiresAt);
    const live = await resolveLivePiTestContract();
    expect(() => validatePiBillingContract(live!)).toThrow('Billing contract is expired');
  });

  it('sends only server-accepted fields through the guarded transport, offline', async () => {
    const { body, ledger } = await runOnce();
    expect([...MANAGED_INFERENCE_BODY_FIELDS].sort()).toEqual([...SERVER_FIELDS].sort());
    expect(body).toBeDefined();
    expect(Object.keys(body!).filter(key => !SERVER_FIELDS.has(key))).toEqual([]);
    expect(body!.model).toBe('google/gemini-2.5-flash-lite');
    expect(body!.max_tokens).toBe(4_096);
    expect(body!).not.toHaveProperty('store');
    expect(body!).not.toHaveProperty('max_completion_tokens');
    expect((body!.messages as Array<{ role: string }>)[0].role).toBe('system');
    expect(ledger).toMatchObject({ calls: 1, pending: 0, unknown: 0, reservedMicroUsd: 17_696 });
  });

  it('keeps prompt cache fields out even when long cache retention is requested', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'long');
    const { body, error } = await runOnce();
    expect(error).toBeUndefined();
    expect(Object.keys(body!).filter(key => !SERVER_FIELDS.has(key))).toEqual([]);
  });

  it('refuses a field outside the contract before reserving or fetching', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'long');
    const model = { ...O8_MANAGED_FLASH_LITE_MODEL, compat: { ...O8_MANAGED_FLASH_LITE_MODEL.compat, supportsLongCacheRetention: true } };
    const { fetches, error, ledger } = await runOnce(model);
    expect(error).toBe('Managed inference failed');
    expect(fetches).toBe(0);
    expect(ledger).toMatchObject({ calls: 0, reservedMicroUsd: 0, pending: 0, unknown: 0 });
  });
});
