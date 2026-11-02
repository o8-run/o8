import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, PATCH, POST } from '@/app/api/v2/chat-history/route';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { updateOperatorDefaults } from '@/lib/operator/defaults';

let tabId: string;
const fetchMock = vi.fn<typeof fetch>();
const pendingResponses: Array<() => void> = [];
const messages = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: index % 2 === 0 ? 'Explain sorting an array' : 'Use a stable comparison',
  timestamp: index + 1,
}));
const filePath = () => join(getDataDir(), 'chat-history', `${tabId}.json`);
const stored = (): Record<string, unknown> => JSON.parse(readFileSync(filePath(), 'utf8'));
const receipts = () => getSqlite().prepare(`
  SELECT model, provider, run_id AS runId, input_tokens AS inputTokens, output_tokens AS outputTokens,
    cost_usd AS costUsd, attempt, metadata_json AS metadataJson
  FROM usage_logs WHERE session_key = ? ORDER BY attempt
`).all(`chat-title:${tabId}`) as Array<{
  model: string; provider: string; runId: string; inputTokens: number; outputTokens: number;
  costUsd: number; attempt: number; metadataJson: string;
}>;
const response = (title: string) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: title } }] }),
}) as Response;
// Drain the promise chain after resolving our in-memory transport; no timed sleep.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function save(body: Record<string, unknown>) {
  const result = await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST',
    body: JSON.stringify({ tabId, ...body }),
  }));
  expect(result.status).toBe(200);
}

async function rename(title: string) {
  const result = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'PATCH',
    body: JSON.stringify({ tabId, title }),
  }));
  expect(result.status).toBe(200);
}

beforeEach(async () => {
  await updateOperatorDefaults({ autoTitleInferenceEnabled: true });
  tabId = `title2530-${randomUUID()}`;
  fetchMock.mockReset().mockImplementation(async () => response('Initial sorting topic'));
  vi.stubEnv('OPENROUTER_API_KEY', 'test-only');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  for (const finish of pendingResponses.splice(0)) finish();
  await settle();
  await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('chat-history auto-title state through real routes (#2530)', () => {
  it('persists provider usage and the save trigger in one receipt for a successful request', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Sorting array topic' } }],
        usage: { prompt_tokens: 32, completion_tokens: 5, cost: 0 },
      }),
    } as Response);
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().title).toBe('Sorting array topic'));
    expect(receipts()).toMatchObject([{
      provider: 'openrouter', inputTokens: 32, outputTokens: 5, costUsd: 0, attempt: 1,
    }]);
    expect(JSON.parse(receipts()[0]!.metadataJson)).toMatchObject({
      trigger: 'chat-history-save', outcome: 'success',
      inputTokenUsage: 'provider-reported', outputTokenUsage: 'provider-reported', costUsage: 'provider-reported',
    });
  });

  it('records each failed provider attempt and preserves unavailable usage through code fallback', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false } as Response)
      .mockRejectedValueOnce(new Error('transport failed'));
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().titleSource).toBe('code'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(receipts()).toHaveLength(2);
    expect(receipts()[0]!.runId).toBe(receipts()[1]!.runId);
    expect(receipts().map((row) => JSON.parse(row.metadataJson))).toMatchObject([
      { outcome: 'http-error', inputTokenUsage: 'unavailable', outputTokenUsage: 'unavailable', costUsage: 'unavailable' },
      { outcome: 'transport-error', inputTokenUsage: 'unavailable', outputTokenUsage: 'unavailable', costUsage: 'unavailable' },
    ]);
  });

  it('keeps partial provider usage without inventing missing output tokens or cost', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Partial usage topic' } }],
        usage: { prompt_tokens: 14 },
      }),
    } as Response);
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().title).toBe('Partial usage topic'));
    expect(receipts()[0]).toMatchObject({ inputTokens: 14, outputTokens: 0, costUsd: 0 });
    expect(JSON.parse(receipts()[0]!.metadataJson)).toMatchObject({
      inputTokenUsage: 'provider-reported', outputTokenUsage: 'unavailable', costUsage: 'unavailable',
      reportedInputTokens: 14, reportedOutputTokens: null, reportedCostUsd: null,
    });
  });

  it('uses code fallback without a provider call when the key is missing or the persisted control is disabled', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().titleSource).toBe('code'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(0);

    await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
    tabId = `title2531-${randomUUID()}`;
    vi.stubEnv('OPENROUTER_API_KEY', 'test-only');
    await updateOperatorDefaults({ autoTitleInferenceEnabled: false });
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().titleSource).toBe('code'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(0);
  });

  it('keeps the title and reports the failure when a requested regenerate gets no model title', async () => {
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().title).toBe('Initial sorting topic'));
    fetchMock.mockReset().mockResolvedValue({ ok: false } as Response);

    const result = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'PATCH',
      body: JSON.stringify({ tabId, regenerateTitle: true }),
    }));

    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ ok: false });
    expect(stored()).toMatchObject({ title: 'Initial sorting topic', titleSource: 'llm' });
  });

  it('coalesces concurrent saves into one provider attempt and one receipt', async () => {
    let finish!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finish = () => resolve(response('Concurrent sorting title'));
      pendingResponses.push(finish);
    }));
    await Promise.all([save({ messages: messages(2) }), save({ messages: messages(2) })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(stored().title).toBe('Concurrent sorting title'));
    expect(receipts()).toHaveLength(1);
  });
  it('generates at two messages, refreshes once at eight, and ignores repeat saves', async () => {
    fetchMock
      .mockResolvedValueOnce(response('Initial sorting topic'))
      .mockResolvedValueOnce(response('Refined sorting topic'));
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored()).toMatchObject({
      title: 'Initial sorting topic', titleSource: 'llm', autoTitledAtCount: 2,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await save({ messages: messages(8) });
    await vi.waitFor(() => expect(stored()).toMatchObject({
      title: 'Refined sorting topic', titleSource: 'llm', autoTitledAtCount: 8,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await save({ messages: messages(8) });
    await save({ messages: messages(8) });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(receipts()).toHaveLength(2);
    expect(stored()).toMatchObject({
      title: 'Refined sorting topic', titleSource: 'llm', autoTitledAtCount: 8,
    });
  });

  it('preserves operator metadata and ignores client-spoofed provenance and counters', async () => {
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().autoTitledAtCount).toBe(2));
    await rename('Operator sorting title');
    await save({ messages: messages(8), titleSource: 'llm', autoTitledAtCount: 0 });
    await settle();
    expect(stored()).toMatchObject({
      title: 'Operator sorting title', titleSource: 'operator', autoTitledAtCount: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an operator rename when a pending title response completes after another POST', async () => {
    const jsonRead = vi.fn(async () => ({ choices: [{ message: { content: 'Late generated title' } }] }));
    let finish!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finish = () => resolve({ ok: true, json: jsonRead } as unknown as Response);
      pendingResponses.push(finish);
    }));
    await save({ messages: messages(2) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await rename('Operator protected title');
    await save({ messages: messages(3) });
    finish();
    await settle();
    expect(jsonRead).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ title: 'Operator protected title', titleSource: 'operator' });
    expect(stored().autoTitledAtCount).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores client metadata on a new record with a pre-existing short title', async () => {
    await save({
      messages: messages(2), title: 'Short sorting title',
      titleSource: 'operator', autoTitledAtCount: 999,
    });
    await settle();
    expect(stored()).toMatchObject({ title: 'Short sorting title' });
    expect(stored().titleSource).toBeUndefined();
    expect(stored().autoTitledAtCount).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['code', 0], ['llm', 2], ['operator', 8],
  ])('preserves valid stored metadata %s/%s', async (titleSource, autoTitledAtCount) => {
    await save({ messages: messages(1), title: 'Short sorting title' });
    writeFileSync(filePath(), JSON.stringify({ ...stored(), titleSource, autoTitledAtCount }));
    await save({ messages: messages(1), titleSource: 'spoofed', autoTitledAtCount: 999 });
    expect(stored()).toMatchObject({ titleSource, autoTitledAtCount });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 2, undefined, 2],
    [null, 2, undefined, 2],
    ['llm', -1, 'llm', undefined],
    ['code', 1.5, 'code', undefined],
    ['operator', '2', 'operator', undefined],
    ['llm', null, 'llm', undefined],
  ])('normalizes stored metadata %s/%s', async (source, count, expectedSource, expectedCount) => {
    await save({ messages: messages(1), title: 'Short sorting title' });
    writeFileSync(filePath(), JSON.stringify({ ...stored(), titleSource: source, autoTitledAtCount: count }));
    await save({ messages: messages(1) });
    expect(stored().titleSource).toBe(expectedSource);
    expect(stored().autoTitledAtCount).toBe(expectedCount);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
