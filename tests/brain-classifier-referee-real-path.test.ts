/**
 * #2436 — the Brain classifier's referee tier through the ask pipeline.
 *
 * Real-path doctrine: the provider setting goes through the real
 * operator-defaults store, the key is read from the data-dir key file, the
 * referee call goes over HTTP to a local systemone fixture, and receipts are
 * read back from the persisted table. The model adapters (CLI processes and
 * paid HTTP) and the composers are stubbed: they are not the seam under test,
 * and the stubbed OpenRouter tier stands in for "today's first tier" so the
 * fall-through answer is observable.
 */
import { chmodSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({
  order: [] as string[],
  openRouterClass: 'B' as 'A' | 'B',
  composed: [] as Array<'A' | 'B'>,
  embedding: null as number[] | null,
  retrieval: null as RetrieverResult[] | null,
}));

vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({
  OPENROUTER_PRIMARY_MODEL: 'fixture/openrouter',
  callOpenRouter: vi.fn(async () => {
    h.order.push('openrouter:classify');
    return JSON.stringify({ class: h.openRouterClass, bm25_variants: ['fallback variant'] });
  }),
}));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({
  callHaiku: vi.fn(async () => { throw new Error('haiku stubbed'); }),
  prewarmHaiku: vi.fn(async () => undefined),
}));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({
  callSonnet: vi.fn(async () => { throw new Error('sonnet stubbed'); }),
  prewarmSonnetCli: vi.fn(async () => undefined),
}));
vi.mock('@/lib/cortex/qa/llm/codex-adapter', () => ({
  callCodex: vi.fn(async () => { throw new Error('codex stubbed'); }),
}));
vi.mock('@/lib/cortex/qa/llm/gemini-embed', () => ({
  embedQuestion: vi.fn(async () => h.embedding),
  dot: (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0),
}));
vi.mock('@/lib/cortex/qa/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cortex/qa/composer')>();
  return {
    ...actual,
    composeClassA: vi.fn(async (_q: string, _r: string | undefined, rows: unknown, emit: (name: string, payload: unknown) => void) => {
      h.composed.push('A');
      emit('token', { text: 'class A answer' });
      const row = Array.isArray(rows) ? rows[0] as TypedRow | undefined : undefined;
      if (row) emit('citation', row.citation);
      emit('done', {});
    }),
    composeClassB: vi.fn(async (_q: string, _r: string | undefined, _rows: unknown, emit: (name: string, payload: unknown) => void) => {
      h.composed.push('B');
      emit('token', { text: 'class B answer' });
      emit('done', {});
    }),
  };
});
vi.mock('@/lib/cortex/qa/retrieve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cortex/qa/retrieve')>();
  return {
    ...actual,
    retrieveAll: vi.fn((input: Parameters<typeof actual.retrieveAll>[0]) => {
      h.order.push('retrieve:start');
      if (h.retrieval) return Promise.resolve(h.retrieval);
      return actual.retrieveAll(input);
    }),
  };
});

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { BRAIN_CLASS_QUESTIONS } = await import('@/lib/judgment/questions');
const { listJudgmentReceipts } = await import('@/lib/judgment/receipts');
const { askCortex, invalidateAnswerCache, runAskPipeline } = await import('@/lib/cortex/qa/ask');
const { resetClassifierCache } = await import('@/lib/cortex/qa/classifier');
const { BRAIN_CLASS_CONFIDENCE_MIN, setBrainRefereeTransportForTests } = await import('@/lib/cortex/qa/referee');

const KEY = 'ts-fixture-key-brain-2436';
let fixture: JudgmentEndpointFixture;

function refereeReply(choice: 'classA' | 'classB', confidence: number, delayMs?: number) {
  const other = choice === 'classA' ? 'classB' : 'classA';
  return {
    status: 200,
    delayMs,
    body: {
      model: 'jev-1.13.0',
      answers: {
        questionClass: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence, [other]: 1 - confidence } },
      },
      usage: { input_tokens: 354, output_tokens: 12 },
    },
  };
}

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  setBrainRefereeTransportForTests({ endpoint: fixture.endpoint, retryBaseMs: 1 });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(async () => {
  setBrainRefereeTransportForTests({});
  vi.restoreAllMocks();
  await fixture.close();
});

beforeEach(async () => {
  fixture.reset();
  resetClassifierCache();
  h.order.length = 0;
  h.composed.length = 0;
  h.openRouterClass = 'B';
  h.embedding = null;
  h.retrieval = null;
  invalidateAnswerCache();
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

const receiptById = (id: string | null | undefined) => listJudgmentReceipts({ limit: 500 }).find((receipt) => receipt.id === id);

const cacheProvenanceRow: TypedRow = {
  citation: {
    kind: 'directive',
    rowId: 'cache-provenance-rule',
    table: 'directives',
    title: 'Cache provenance rule',
    excerpt: 'Replay the original retrieval provenance with cached answers.',
  },
  fields: {
    title: 'Cache provenance rule',
    body: 'Replay the original retrieval provenance with cached answers.',
  },
  score: 1,
};

const cacheProvenanceRetrieval: RetrieverResult[] = [
  { retriever: 'sql', rows: [cacheProvenanceRow], durationMs: 1 },
  { retriever: 'fts', rows: [], durationMs: 0 },
  { retriever: 'facts', rows: [], durationMs: 0 },
  { retriever: 'corrections', rows: [], durationMs: 0 },
];

describe('Brain classifier referee tier through the ask pipeline', () => {
  it('classifies a Class A question by the referee and records a receipt naming the surface', async () => {
    fixture.replies.push(refereeReply('classA', 0.93));
    const result = await askCortex('Who merged the port allocation change?', undefined, { bypassCache: true });

    expect(result.class).toBe('A');
    expect(result.classifier).toBe('referee');
    expect(h.order).not.toContain('openrouter:classify');
    expect(h.composed).toEqual(['A']);

    expect(fixture.seen).toHaveLength(1);
    expect(fixture.seen[0].authorization).toBe(`Bearer ${KEY}`);
    expect(fixture.seen[0].body).toEqual({
      model: 'jev-latest',
      state: { question: 'Who merged the port allocation change?' },
      questions: BRAIN_CLASS_QUESTIONS,
    });

    const receipt = receiptById(result.classificationReceiptId);
    expect(receipt).toMatchObject({ ok: true, surface: 'brain-classifier', model: 'jev-1.13.0' });
    expect(receipt!.questions).toEqual(BRAIN_CLASS_QUESTIONS);
    expect(receipt!.answers).toMatchObject({ questionClass: { choice: 'classA', confidence: 0.93 } });
  });

  it('classifies a Class B question by the referee and reports it on the sources line, with retrieval started before the referee answered', async () => {
    fixture.replies.push(refereeReply('classB', 0.88, 150));
    fixture.onReply = () => { h.order.push('referee:reply'); };
    const frames: Array<{ name: string; payload: Record<string, unknown> }> = [];

    await runAskPipeline('Explain the reasoning behind the merge escalation ladder', undefined, (name, payload) => {
      frames.push({ name, payload: payload as Record<string, unknown> });
    }, true);

    expect(h.order.indexOf('retrieve:start')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('retrieve:start')).toBeLessThan(h.order.indexOf('referee:reply'));
    expect(h.order).not.toContain('openrouter:classify');
    expect(h.composed).toEqual(['B']);

    const sources = frames.find((frame) => frame.name === 'sources')!.payload;
    expect(sources.classifier).toBe('referee');
    const receipt = receiptById(sources.classificationReceiptId as string);
    expect(receipt).toMatchObject({ ok: true, surface: 'brain-classifier' });
    expect(receipt!.answers).toMatchObject({ questionClass: { choice: 'classB' } });
  });

  it('replays the original sources provenance before tokens on an exact cache hit', async () => {
    const question = 'Which evidence established the cache provenance rule?';
    const first: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const second: Array<{ name: string; payload: Record<string, unknown> }> = [];
    h.retrieval = cacheProvenanceRetrieval;
    fixture.replies.push(refereeReply('classA', 0.93));

    await runAskPipeline(question, undefined, (name, payload) => {
      first.push({ name, payload: payload as Record<string, unknown> });
    });
    await runAskPipeline(question, undefined, (name, payload) => {
      second.push({ name, payload: payload as Record<string, unknown> });
    });

    const firstSources = first.find((frame) => frame.name === 'sources')!;
    const secondSources = second.find((frame) => frame.name === 'sources')!;
    expect(secondSources.payload).toEqual(firstSources.payload);
    expect(firstSources.payload.count).toBe(1);
    expect(secondSources.payload.count).toBe(1);
    expect(second.map((frame) => frame.name)).toEqual(['sources', 'token', 'citation', 'done']);
    expect(secondSources.payload.classifier).toBe('referee');
    expect(secondSources.payload.classificationReceiptId).toBe(firstSources.payload.classificationReceiptId);
    expect(second.find((frame) => frame.name === 'citation')!.payload).toEqual(cacheProvenanceRow.citation);
    expect(fixture.seen).toHaveLength(1);
    expect(h.composed).toEqual(['A']);
  });

  it('replays the original sources provenance before tokens on a semantic cache hit', async () => {
    const first: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const second: Array<{ name: string; payload: Record<string, unknown> }> = [];
    h.embedding = [1, 0];
    h.retrieval = cacheProvenanceRetrieval;
    fixture.replies.push(refereeReply('classA', 0.93));

    await runAskPipeline('What establishes the provenance rule?', undefined, (name, payload) => {
      first.push({ name, payload: payload as Record<string, unknown> });
    });
    await new Promise((resolve) => setImmediate(resolve));
    await runAskPipeline('How is provenance established?', undefined, (name, payload) => {
      second.push({ name, payload: payload as Record<string, unknown> });
    });

    const firstSources = first.find((frame) => frame.name === 'sources')!;
    const secondSources = second.find((frame) => frame.name === 'sources')!;
    expect(secondSources.payload).toEqual(firstSources.payload);
    expect(firstSources.payload.count).toBe(1);
    expect(secondSources.payload.count).toBe(1);
    expect(second.map((frame) => frame.name)).toEqual(['sources', 'token', 'citation', 'done']);
    expect(secondSources.payload.classifier).toBe('referee');
    expect(secondSources.payload.classificationReceiptId).toBe(firstSources.payload.classificationReceiptId);
    expect(second.find((frame) => frame.name === 'citation')!.payload).toEqual(cacheProvenanceRow.citation);
    expect(fixture.seen).toHaveLength(1);
    expect(h.composed).toEqual(['A']);
  });

  it('runs the referee under the managed provider value (#2484)', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'managed' });
    fixture.replies.push(refereeReply('classA', 0.93));
    const result = await askCortex('Who merged the managed route change?', undefined, { bypassCache: true });

    expect(fixture.seen).toHaveLength(1);
    expect(result.classifier).toBe('referee');
    expect(h.order).not.toContain('openrouter:classify');
    expect(receiptById(result.classificationReceiptId)).toMatchObject({ ok: true, provider: 'managed', surface: 'brain-classifier' });
  });

  it('falls through to the existing tier when the referee is under the confidence threshold', async () => {
    const lowConfidence = BRAIN_CLASS_CONFIDENCE_MIN - 0.1;
    expect(lowConfidence).toBeGreaterThanOrEqual(0.4); // not an abstain: the threshold itself decides
    fixture.replies.push(refereeReply('classA', lowConfidence));
    h.openRouterClass = 'B';

    const result = await askCortex('What decided the default retry budget?', undefined, { bypassCache: true });

    expect(fixture.seen).toHaveLength(1);
    expect(h.order).toContain('openrouter:classify');
    expect(result.class).toBe('B');
    expect(h.composed).toEqual(['B']);
    expect(result).not.toHaveProperty('classifier');
    expect(result).not.toHaveProperty('classificationReceiptId');
    const refereeReceipts = listJudgmentReceipts({ limit: 500 }).filter((receipt) => receipt.surface === 'brain-classifier'
      && (receipt.answers as { questionClass?: { confidence?: number } } | null)?.questionClass?.confidence === lowConfidence);
    expect(refereeReceipts).toHaveLength(1);
  });

  it('ignores a cached referee classification once the setting is switched off within the TTL', async () => {
    const question = 'Explain how the lane retry counter resets';
    const frames: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const collect = (name: string, payload: unknown) => { frames.push({ name, payload: payload as Record<string, unknown> }); };

    fixture.replies.push(refereeReply('classB', 0.9));
    await runAskPipeline(question, undefined, collect, true);
    expect(fixture.seen).toHaveLength(1);
    expect(frames.find((frame) => frame.name === 'sources')!.payload.classifier).toBe('referee');
    expect(h.order).not.toContain('openrouter:classify');

    await updateOperatorDefaults({ judgmentProvider: 'off' });
    fixture.reset();
    frames.length = 0;
    h.order.length = 0;
    h.composed.length = 0;
    h.openRouterClass = 'A';

    await runAskPipeline(question, undefined, collect, true);

    expect(fixture.seen).toHaveLength(0);
    expect(h.order).toContain('openrouter:classify');
    expect(h.composed).toEqual(['A']);
    const sources = frames.find((frame) => frame.name === 'sources')!.payload;
    expect(sources).not.toHaveProperty('classifier');
    expect(sources).not.toHaveProperty('classificationReceiptId');
  });

  it('leaves tier order and outputs unchanged with the setting off', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    fixture.replies.push(refereeReply('classB', 0.99));
    h.openRouterClass = 'A';
    const receiptsBefore = listJudgmentReceipts({ limit: 500 }).length;
    const frames: Array<{ name: string; payload: Record<string, unknown> }> = [];

    const result = await askCortex('Who owns the release checklist?', undefined, { bypassCache: true });
    await runAskPipeline('Who owns the release checklist?', undefined, (name, payload) => {
      frames.push({ name, payload: payload as Record<string, unknown> });
    }, true);

    expect(fixture.seen).toHaveLength(0);
    expect(result.class).toBe('A');
    expect(result).not.toHaveProperty('classifier');
    expect(result).not.toHaveProperty('classificationReceiptId');
    expect(h.order.filter((entry) => entry === 'openrouter:classify')).toHaveLength(1);
    const sources = frames.find((frame) => frame.name === 'sources')!.payload;
    expect(Object.keys(sources).sort()).toEqual(['count', 'retrievalMs', 'top']);
    expect(listJudgmentReceipts({ limit: 500 })).toHaveLength(receiptsBefore);
  });
});
