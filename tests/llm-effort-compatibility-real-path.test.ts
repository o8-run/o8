import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/providers/key-store', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/providers/key-store')>(),
  resolveProviderKey: () => 'fixture-credential',
}));
const { POST } = await import('@/app/api/v2/proxy/llm/route');
const captured: Record<string, unknown>[] = [];
beforeEach(() => {
  captured.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    captured.push(JSON.parse(init.body));
    return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());
async function post(provider: string, model: string, thinkingEffort?: unknown) {
  const response = await POST(new NextRequest('http://localhost/api/v2/proxy/llm', {
    method: 'POST', body: JSON.stringify({ provider, model, thinkingEffort, disableTools: true,
      messages: [{ role: 'user', content: 'fixture' }] }),
  }));
  return { status: response.status, text: await response.text() };
}

describe('native LLM API effort compatibility through POST and captured payloads', () => {
  it.each(['', 'turbo', false, null, 1, {}, ['high']])('rejects malformed effort %j before transport', async effort => {
    expect((await post('openai', 'o3', effort)).status).toBe(400);
    expect(captured).toEqual([]);
  });
  it.each(['low', 'medium', 'high'])('preserves the OpenAI %s pin', async effort => {
    expect((await post('openai', 'o3', effort)).status).toBe(200);
    expect(captured).toMatchObject([{ model: 'o3', reasoning_effort: effort }]);
  });
  it.each(['o3-2025-04-16', 'o3-mini-2025-01-31', 'o4-mini-2025-04-16'].flatMap(model =>
    ['low', 'medium', 'high'].map(effort => ({ model, effort })),
  ))('preserves the dated OpenAI model $model and its $effort pin', async ({ model, effort }) => {
    expect((await post('openai', model, effort)).status).toBe(200);
    expect(captured).toMatchObject([{ model, reasoning_effort: effort }]);
  });
  it.each(['o3-2025-04-16', 'o3-mini-2025-01-31', 'o4-mini-2025-04-16'].flatMap(model =>
    [undefined, 'adaptive'].map(effort => ({ model, effort })),
  ))('keeps the family default for $model with $effort effort', async ({ model, effort }) => {
    expect((await post('openai', model, effort)).status).toBe(200);
    expect(captured).toMatchObject([{ model, reasoning_effort: 'medium' }]);
  });
  it.each(['low', 'medium', 'high', 'max', 'xhigh'])('preserves the dated Anthropic model and %s budget', async effort => {
    const model = 'claude-sonnet-4-5-20250929';
    expect((await post('anthropic', model, effort)).status).toBe(200);
    expect(captured).toMatchObject([{ model, thinking: { type: 'enabled', budget_tokens: expect.any(Number) } }]);
    const body = captured[0] as { max_tokens: number; thinking: { budget_tokens: number } };
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
    expect(body.max_tokens).toBeLessThanOrEqual(64_000);
  });
  it.each([
    ['openai', 'gpt-4o', 'high'], ['openai', 'o3', 'ultra'],
    ['google', 'gemini-2.5-flash', 'high'], ['anthropic', 'claude-haiku-4-5', 'max'],
    ['anthropic', 'claude-sonnet-4-5', 'ultra'],
    ['openai', 'o3-20250416', 'high'], ['openai', 'o3-preview', 'high'],
    ['openai', 'o3-2025-04-16-preview', 'high'], ['openai', 'o3-mini-other-2025-01-31', 'high'],
    ['anthropic', 'claude-sonnet-4-5-2025-09-29', 'high'], ['anthropic', 'claude-sonnet-4-5-20250929-extra', 'high'],
  ])('rejects unmapped %s/%s/%s before transport', async (provider, model, effort) => {
    expect((await post(provider, model, effort)).status).toBe(400);
    expect(captured).toEqual([]);
  });
  it.each(['low', 'medium', 'high', 'max', 'xhigh'])('sends a valid legacy Anthropic %s budget', async effort => {
    expect((await post('anthropic', 'claude-sonnet-4-5', effort)).status).toBe(200);
    const body = captured[0] as { max_tokens: number; thinking: { type: string; budget_tokens: number } };
    expect(body.thinking.type).toBe('enabled');
    expect(body.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
    expect(body.max_tokens).toBeLessThanOrEqual(64_000);
  });
});
