import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagedBrainUnavailableError, MANAGED_BRAIN_UNAVAILABLE_MESSAGE } from '@/lib/cortex/qa/compose-class-a';

const fixture = vi.hoisted(() => ({ compose: vi.fn(), retrieve: vi.fn(), classification: 'A' }));
vi.mock('@/lib/cortex/qa/classifier', () => ({ classifyQuestion: async () => ({ class: fixture.classification, bm25Variants: ['rules'] }) }));
vi.mock('@/lib/cortex/qa/retrieve', () => ({ retrieveAll: fixture.retrieve, unionMerge: (results: { rows: unknown[] }[]) => results.flatMap(r => r.rows) }));
vi.mock('@/lib/cortex/qa/composer', async original => ({ ...await original<typeof import('@/lib/cortex/qa/composer')>(), composeClassA: fixture.compose, composeClassB: fixture.compose }));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/gemini-embed', () => ({ embedQuestion: async () => null }));
const { POST } = await import('@/app/api/cortex/ask/answer/route');
const { POST: stream } = await import('@/app/api/cortex/ask/route');
const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
const { handleAsk } = await import('@/lib/mcp/operator-handlers/cortex');
const citation = { kind: 'directive', rowId: 'rule-1', table: 'directives', sourcePath: 'AGENTS.md', excerpt: 'Use focused tests.' };
function request() { return new NextRequest('http://fixture.invalid/api/cortex/ask/answer', { method: 'POST', body: JSON.stringify({ question: 'rules', projectId: 'fixture-project' }) }); }
beforeEach(() => {
  invalidateAnswerCache();
  vi.stubEnv('O8_HYBRID_RETRIEVAL', '0');
  fixture.compose.mockReset().mockImplementation(async () => { throw new ManagedBrainUnavailableError(); });
  fixture.retrieve.mockReset().mockResolvedValue([{ rows: [{ citation, fields: { title: 'Testing rules' } }] }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['A', 'B'])('returns uncached 503 with retrieved citations for class %s', async classification => {
  fixture.classification = classification;
  for (let i = 0; i < 2; i++) {
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ ok: false, code: 'managed_brain_unavailable', message: MANAGED_BRAIN_UNAVAILABLE_MESSAGE, error: MANAGED_BRAIN_UNAVAILABLE_MESSAGE, citations: [{ ...citation, title: 'Testing rules' }], sourcesConsidered: 1 });
  }
  expect(fixture.compose).toHaveBeenCalledTimes(2);
});
it('preserves the actionable streaming error', async () => {
  const response = await stream(request());
  const text = await response.text();
  expect(text).toContain('event: sources');
  expect(text).toContain(MANAGED_BRAIN_UNAVAILABLE_MESSAGE);
  expect(text).toContain('"code":"managed_brain_unavailable"');
});
it('returns structured outage data through the operator MCP HTTP transport', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => POST(new NextRequest('http://fixture.invalid/api/cortex/ask/answer', init))));
  const result = await handleAsk({ question: 'rules', projectId: 'fixture-project' });
  expect(result.isError).toBe(false);
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ ok: false, code: 'managed_brain_unavailable', message: MANAGED_BRAIN_UNAVAILABLE_MESSAGE, citations: [{ ...citation, title: 'Testing rules' }], sourcesConsidered: 1 });
});
