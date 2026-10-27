/**
 * Circuit-breaker tests for the OpenRouter adapter (2026-06-11 brain perf
 * pass). The breaker exists because deterministic hard failures (401/402)
 * were being re-paid on every single ask — a drained credit balance burned a
 * doomed HTTP round-trip per question and silently demoted the pipeline to
 * the slow CLI tiers.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The adapter's daily-cap check + spend ledger open the app SQLite DB on
// first use — point it at a throwaway dir so tests never touch ~/.o8.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-qa-test-'));

vi.mock('@/lib/cortex/qa/llm/brain-spend', () => ({
  assertUnderBrainDailyCap: vi.fn(),
  recordBrainOpenRouterSpend: vi.fn(),
}));

import {
  callOpenRouter,
  isOpenRouterCircuitOpen,
  resetOpenRouterCircuit,
} from '@/lib/cortex/qa/llm/openrouter-adapter';
import { resetLocalInferenceProbeCacheForTests } from '@/lib/cortex/qa/llm/inference-route';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const okBody = { choices: [{ message: { content: 'OK' } }], model: 'test-model' };
const insufficientCredits = { error: { message: 'Insufficient credits', code: 402 } };

describe('openrouter-adapter circuit breaker', { timeout: 10_000 }, () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetOpenRouterCircuit();
    resetLocalInferenceProbeCacheForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    delete process.env.O8_LOCAL_INFERENCE_BASE_URL;
    delete process.env.O8_LOCAL_CHAT_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetOpenRouterCircuit();
    resetLocalInferenceProbeCacheForTests();
  });

  it('starts closed', () => {
    expect(isOpenRouterCircuitOpen()).toBe(false);
  });

  it('opens after two consecutive 402s and skips fetch while open', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(402, insufficientCredits)));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 402');
    expect(isOpenRouterCircuitOpen()).toBe(false);

    await expect(callOpenRouter('q2')).rejects.toThrow('HTTP 402');
    expect(isOpenRouterCircuitOpen()).toBe(true);

    // Third call must fail fast WITHOUT another network round-trip.
    await expect(callOpenRouter('q3')).rejects.toThrow('circuit open');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a success between hard failures resets the consecutive count', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(402, insufficientCredits))
      .mockResolvedValueOnce(jsonResponse(200, okBody))
      .mockResolvedValueOnce(jsonResponse(402, insufficientCredits));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 402');
    await expect(callOpenRouter('q2')).resolves.toBe('OK');
    await expect(callOpenRouter('q3')).rejects.toThrow('HTTP 402');

    // Only one consecutive failure since the success — still closed.
    expect(isOpenRouterCircuitOpen()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not trip on transient 5xx failures', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(
      jsonResponse(503, { error: { message: 'upstream busy' } }),
    ));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 503');
    await expect(callOpenRouter('q2')).rejects.toThrow('HTTP 503');
    await expect(callOpenRouter('q3')).rejects.toThrow('HTTP 503');

    expect(isOpenRouterCircuitOpen()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('trips on 401 (bad key) the same as 402', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(
      jsonResponse(401, { error: { message: 'bad key' } }),
    ));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 401');
    await expect(callOpenRouter('q2')).rejects.toThrow('HTTP 401');

    expect(isOpenRouterCircuitOpen()).toBe(true);
  });

  it('warms OpenRouter only when the first direct request is made', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, okBody))
      .mockResolvedValueOnce(jsonResponse(200, okBody));

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(callOpenRouter('q1')).resolves.toBe('OK');
    await expect(callOpenRouter('q2')).resolves.toBe('OK');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/models');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('bounds a longer text response without adding tool access', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, okBody)));
    await callOpenRouter('A supplied reference only.', { maxTokens: 2048 });
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes('/chat/completions'))?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(2048);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('openrouter-adapter managed text model', { timeout: 10_000 }, () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetOpenRouterCircuit();
    resetLocalInferenceProbeCacheForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    delete process.env.O8_LOCAL_INFERENCE_BASE_URL;
    delete process.env.O8_LOCAL_CHAT_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetOpenRouterCircuit();
  });

  it('asks for the managed text model with reasoning off, Flash Lite first in the fallback chain', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, okBody));
    await callOpenRouter('Say OK');
    const chat = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
    const body = JSON.parse(String((chat![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.reasoning_effort).toBe('none');
    expect((body.models as string[])[0]).toBe('google/gemini-2.5-flash-lite');
  });

  it('leads with O8_OPENROUTER_TEXT_MODEL on a direct key, without the Luna-only reasoning field', async () => {
    vi.stubEnv('O8_OPENROUTER_TEXT_MODEL', 'deepseek/deepseek-v4-flash');
    try {
      fetchMock.mockImplementation(async () => jsonResponse(200, okBody));
      await callOpenRouter('Say OK');
      const chat = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
      expect(String(chat![0])).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String((chat![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.model).toBe('deepseek/deepseek-v4-flash');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect((body.models as string[])[0]).toBe('google/gemini-2.5-flash-lite');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
