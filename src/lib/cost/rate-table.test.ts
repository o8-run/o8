import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { estimateCostUsd } from '@/lib/cortex/qa/llm/brain-spend';
import { parseCodexSessionCost } from '@/lib/runtimes/codex-cost-parser';
import { parseSessionCost } from '@/lib/runtimes/cost-parser';
import { parseCursorSessionCost } from '@/lib/runtimes/cursor-cost-parser';
import { parseGeminiSessionCost } from '@/lib/runtimes/gemini-cost-parser';
import { parseOpencodeSessionCost } from '@/lib/runtimes/opencode-cost-parser';
import { modelRateTable, resolveRate } from './rate-table';
import { anthropicPricingForModel } from '@/lib/llm/pricing';
import { computeCost } from '@/app/api/v2/proxy/llm/provider-config';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-rate-table-'));
const TOKENS_PER_MILLION = 1_000_000;

function fixture(name: string, row: Record<string, unknown>): string {
  const filePath = join(fixtureRoot, name);
  writeFileSync(filePath, `${JSON.stringify(row)}\n`);
  return filePath;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() ? [path] : [];
  });
}

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('dated model rate table reproducibility', () => {
  it.each([272_000, 272_001])('prices GPT-6.1 Sol through the persisted transcript at %s input tokens', async (input) => {
    expect(resolveRate('codex', 'gpt-6.1-sol')).toMatchObject({
      inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.1,
      outputUsdPerMillion: 10, cacheWriteUsdPerMillion: 2.5,
    });
    const parsed = await parseCodexSessionCost(fixture(`sol-${input}.jsonl`, {
      type: 'turn.completed', model: 'gpt-6.1-sol',
      usage: { input_tokens: input, cached_input_tokens: 20_000, output_tokens: 10_000 },
    }));
    const inputMultiplier = input > 272_000 ? 2 : 1;
    const outputMultiplier = input > 272_000 ? 1.5 : 1;
    expect(parsed.totalCostUsd).toBe(rounded(((input - 20_000) * 2 * inputMultiplier
      + 20_000 * 0.1 * inputMultiplier + 10_000 * 10 * outputMultiplier) / TOKENS_PER_MILLION));
  });

  it.each([
    // Anthropic pricing page, https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-05.
    ['claude-opus-5-5', 4, 20, 0.2, 5, 8],
    ['claude-fable-5-1', 10, 50, 0.25, 12.5, 20],
    ['claude-sonnet-5-5', 2, 10, 0.1, 2.5, 4],
    ['claude-sonnet-5', 2, 10, 0.2, 2.5, 4],
    ['claude-haiku-4-5', 1, 5, 0.1, 1.25, 2],
  ] as const)('prices %s consistently through the session parser and estimator', async (model, input, output, cacheRead, cacheWrite, cacheWrite1h) => {
    expect(resolveRate('claude-code', model)).toMatchObject({
      inputUsdPerMillion: input, outputUsdPerMillion: output,
      cacheReadUsdPerMillion: cacheRead, cacheWriteUsdPerMillion: cacheWrite,
      cacheWrite1hUsdPerMillion: cacheWrite1h,
    });
    expect(anthropicPricingForModel(model)).toEqual({ input, output });
    const parsed = await parseSessionCost(fixture(`${model}.jsonl`, {
      type: 'assistant', requestId: model,
      message: { id: model, model, usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    }));
    expect(parsed.totalCostUsd).toBe(input + output);
  });

  it.each([
    // The estimator takes ids and display names; session logs carry ids.
    ['Claude Sonnet 5.5', 'claude-sonnet-5-5[1m]', 'claude-sonnet-5-5', 2, 10],
    ['Claude Haiku 5.5', 'claude-haiku-5-5', 'claude-haiku-5-5', 0.1, 0.5],
    ['Claude Haiku 4.5', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5', 1, 5],
  ] as const)('reads %s as its own model, not an older one', (name, id, modelKey, input, output) => {
    expect(anthropicPricingForModel(name)).toEqual({ input, output });
    expect(anthropicPricingForModel(id)).toEqual({ input, output });
    expect(resolveRate('claude-code', id)).toMatchObject({ modelKey });
  });

  it.each([
    // Dotted OpenRouter-style ids and display names.
    ['claude-haiku-5.5', 'claude-haiku-5-5'],
    ['Claude Haiku 5.5', 'claude-haiku-5-5'],
    ['claude-sonnet-5.5', 'claude-sonnet-5-5'],
    ['Claude Sonnet 5.5', 'claude-sonnet-5-5'],
    ['anthropic/claude-haiku-4.5', 'claude-haiku-4-5'],
    ['Claude Opus 4.8', 'claude-opus-4-8'],
    ['claude-opus-4-8-fast', 'claude-opus-4-8-fast'],
    ['claude-opus-5-5-fast', 'claude-opus-5-5-fast'],
    ['claude-opus-5', 'claude-opus-5'],
    ['Claude Opus 5', 'claude-opus-5'],
    ['claude-opus-5-fast', 'claude-opus-5-fast'],
  ])('resolves %s to %s', (name, modelKey) => {
    expect(resolveRate('claude-code', name)).toMatchObject({ modelKey });
  });

  it('prices fast mode from the pricing page', () => {
    // Fast mode table, https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-05.
    expect(resolveRate('claude-code', 'claude-opus-4-8-fast')).toMatchObject({
      inputUsdPerMillion: 10, outputUsdPerMillion: 50,
    });
    expect(resolveRate('claude-code', 'claude-opus-5-5-fast')).toMatchObject({
      inputUsdPerMillion: 8, outputUsdPerMillion: 40,
    });
    expect(resolveRate('claude-code', 'claude-opus-5-fast')).toMatchObject({
      inputUsdPerMillion: 10, outputUsdPerMillion: 50,
      cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 12.5, cacheWrite1hUsdPerMillion: 20,
    });
    expect(resolveRate('claude-code', 'claude-opus-5')).toMatchObject({
      inputUsdPerMillion: 5, outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 6.25, cacheWrite1hUsdPerMillion: 10,
    });
    // No fast mode is listed for Opus 4.7 or 4.6, so those runs stay unpriced.
    for (const model of ['claude-opus-4-7-fast', 'claude-opus-4-6-fast']) {
      expect(resolveRate('claude-code', model), model).toBeNull();
      expect(anthropicPricingForModel(model), model).toBeNull();
    }
  });

  it('gives every estimator the rate table\'s Claude prices', () => {
    for (const [model, rate] of Object.entries(modelRateTable.rates)) {
      if (!model.startsWith('claude-')) continue;
      const price = { input: rate.inputUsdPerMillion, output: rate.outputUsdPerMillion };
      expect(anthropicPricingForModel(model), model).toEqual(price);
      expect(computeCost(model, 1_000_000, 1_000_000), model).toBeCloseTo(price.input + price.output, 9);
    }
  });

  it('prices Haiku 5.5 by prompt length, cache reads and writes included', async () => {
    expect(resolveRate('claude-code', 'claude-haiku-5-5')).toMatchObject({
      modelKey: 'claude-haiku-5-5', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5,
      cacheReadUsdPerMillion: 0.01, cacheWriteUsdPerMillion: 0.125, cacheWrite1hUsdPerMillion: 0.2,
    });
    expect(anthropicPricingForModel('claude-haiku-5-5')).toEqual({ input: 0.1, output: 0.5 });
    const request = (id: string, input: number) => ({
      type: 'assistant', requestId: id,
      message: { id, model: 'claude-haiku-5-5', usage: {
        input_tokens: input, output_tokens: 10_000, cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 20_000,
        cache_creation: { ephemeral_5m_input_tokens: 15_000, ephemeral_1h_input_tokens: 5_000 },
      } },
    });
    // 40,000 input + 40,000 cache read + 20,000 cache write: exactly 100,000.
    const short = await parseSessionCost(fixture('haiku-short.jsonl', request('haiku-short', 40_000)));
    expect(short.totalCostUsd).toBe(rounded((40_000 * 0.1 + 10_000 * 0.5 + 40_000 * 0.01
      + 15_000 * 0.125 + 5_000 * 0.2) / TOKENS_PER_MILLION));
    // One more input token passes 100,000: every rate of that request is the long-prompt rate.
    const long = await parseSessionCost(fixture('haiku-long.jsonl', request('haiku-long', 40_001)));
    expect(long.totalCostUsd).toBe(rounded((40_001 * 0.5 + 10_000 * 2.5 + 40_000 * 0.05
      + 15_000 * 0.625 + 5_000 * 1) / TOKENS_PER_MILLION));
    expect(long.model).toBe('claude-haiku-5-5');
  });

  it('reproduces each table-priced parser and the Brain estimator', async () => {
    const claudeRate = resolveRate('claude-code', 'claude-sonnet-5')!;
    const claude = await parseSessionCost(fixture('claude.jsonl', {
      type: 'assistant',
      requestId: 'claude-rate-fixture',
      message: {
        id: 'claude-rate-fixture',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 100_000,
          output_tokens: 20_000,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 6_000,
          cache_creation: {
            ephemeral_5m_input_tokens: 4_000,
            ephemeral_1h_input_tokens: 2_000,
          },
        },
      },
    }));
    expect(claude.totalCostUsd).toBe(rounded((
      100_000 * claudeRate.inputUsdPerMillion
      + 20_000 * claudeRate.outputUsdPerMillion
      + 10_000 * claudeRate.cacheReadUsdPerMillion!
      + 4_000 * claudeRate.cacheWriteUsdPerMillion!
      + 2_000 * claudeRate.cacheWrite1hUsdPerMillion!
    ) / TOKENS_PER_MILLION));

    const codexRate = resolveRate('codex', 'gpt-5.5')!;
    const codex = await parseCodexSessionCost(fixture('codex.jsonl', {
      type: 'turn.completed',
      model: 'gpt-5.5',
      usage: {
        input_tokens: 100_000,
        cached_input_tokens: 20_000,
        output_tokens: 10_000,
        total_tokens: 110_000,
      },
    }), 'gpt-5.5');
    expect(codex.totalCostUsd).toBe(rounded((
      80_000 * codexRate.inputUsdPerMillion
      + 20_000 * codexRate.cacheReadUsdPerMillion!
      + 10_000 * codexRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION));

    const geminiRate = resolveRate('gemini', 'gemini-2.5-flash')!;
    const gemini = await parseGeminiSessionCost(fixture('gemini.jsonl', {
      type: 'result',
      model: 'gemini-2.5-flash',
      stats: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 20_000 },
    }));
    expect(gemini.totalCostUsd).toBe(rounded((
      80_000 * geminiRate.inputUsdPerMillion
      + 20_000 * geminiRate.cacheReadUsdPerMillion!
      + 10_000 * geminiRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION));

    const cursorRate = resolveRate('cursor', 'cursor-fast')!;
    const cursor = await parseCursorSessionCost([fixture('cursor.jsonl', {
      type: 'result',
      model: 'cursor-fast',
      usage: { inputTokens: 100_000, outputTokens: 10_000, cacheWriteTokens: 5_000 },
    })]);
    expect(cursor.totalCostUsd).toBe(rounded((
      100_000 * cursorRate.inputUsdPerMillion
      + 10_000 * cursorRate.outputUsdPerMillion
      + 5_000 * cursorRate.cacheWriteUsdPerMillion!
    ) / TOKENS_PER_MILLION));

    const opencodeRate = resolveRate('opencode', 'opencode/gpt-5-nano')!;
    const opencode = await parseOpencodeSessionCost([fixture('opencode.jsonl', {
      type: 'result',
      model: 'opencode/gpt-5-nano',
      usage: { inputTokens: 100_000, outputTokens: 10_000 },
    })]);
    expect(opencode.totalCostUsd).toBe(rounded((
      100_000 * opencodeRate.inputUsdPerMillion
      + 10_000 * opencodeRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION));

    const brainRate = resolveRate('brain', 'google/gemini-2.5-flash-lite')!;
    expect(estimateCostUsd('google/gemini-2.5-flash-lite', {
      prompt_tokens: 100_000,
      completion_tokens: 10_000,
    })).toBe((
      100_000 * brainRate.inputUsdPerMillion
      + 10_000 * brainRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION);

    expect(modelRateTable).toMatchObject({
      rateTableVersion: '2026-11-06.1',
      observedOn: '2026-11-06',
    });
  });

  it('keeps private price-literal markers out of runtime and Brain sources', () => {
    const roots = [
      join(process.cwd(), 'src/lib/runtimes'),
      join(process.cwd(), 'src/lib/cortex'),
    ];
    const forbidden = /USD_PER_MILLION|per 1M|USD per token/;
    const matches = roots.flatMap(sourceFiles).flatMap((filePath) => {
      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
      return lines.flatMap((line, index) => forbidden.test(line)
        ? [`${filePath.slice(process.cwd().length + 1)}:${index + 1}:${line.trim()}`]
        : []);
    });
    expect(matches).toEqual([]);
  });
});
