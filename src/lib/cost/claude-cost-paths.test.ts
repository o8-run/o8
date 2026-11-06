import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelRateTable } from './rate-table';

// One Claude Opus 5.5 request, priced by every path that reads Claude usage:
// analytics, the session cost parser, usage history and the LLM proxy.
// Opus 5.5 list rates (USD per million): $4 input, $20 output, $0.20 cache
// read, $5 5-minute write, $8 1-hour write; fast mode is $8 / $40, 2x each.
const tokens = { input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 4_000 };
const standardUsd = (1_000 * 4 + 2_000 * 20 + 10_000 * 0.2 + 4_000 * 5) / 1_000_000;

const scenarios = [
  { name: 'standard', usage: { ...tokens, service_tier: 'standard', speed: 'standard' }, usd: standardUsd, proxy: true },
  // Priority Tier is a capacity commitment, not fast mode: standard rates.
  { name: 'Priority Tier', usage: { ...tokens, service_tier: 'priority', speed: 'standard' }, usd: standardUsd, proxy: true },
  { name: 'fast mode', usage: { ...tokens, service_tier: 'standard', speed: 'fast' }, usd: standardUsd * 2, proxy: false },
  {
    name: '1-hour cache writes',
    usage: { ...tokens, cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 3_000 } },
    usd: (1_000 * 4 + 2_000 * 20 + 10_000 * 0.2 + 1_000 * 5 + 3_000 * 8) / 1_000_000,
    proxy: false,
  },
] as const;

const scoped = ['HOME', 'CORTEX_IDE_DATA_DIR', 'O8_MASTER_KEY', 'ANTHROPIC_API_KEY'] as const;
const saved = new Map<string, string | undefined>();
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'o8-claude-cost-paths-'));
  for (const key of scoped) saved.set(key, process.env[key]);
  process.env.HOME = path.join(root, 'home');
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  process.env.O8_MASTER_KEY = Buffer.alloc(32, 7).toString('base64url');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-cost-paths';
  await mkdir(process.env.CORTEX_IDE_DATA_DIR, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function writeTranscript(usage: object): Promise<{ dir: string; file: string }> {
  const dir = path.join(root, 'home', '.claude', 'projects', 'project');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, `${JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'session', requestId: 'request',
    message: { id: 'message', model: 'claude-opus-5-5', usage },
  })}\n`);
  return { dir, file };
}

async function analyticsCost(): Promise<number> {
  const { GET } = await import('@/app/api/panel/analytics/route');
  const response = await GET(new NextRequest('http://localhost/api/panel/analytics?hours=24'));
  const body = await response.json() as { bySurface: Record<string, { cost: number }> };
  return body.bySurface['Claude Code'].cost;
}

async function parserCost(file: string): Promise<number> {
  const { parseSessionCost } = await import('@/lib/runtimes/cost-parser');
  return (await parseSessionCost(file))!.totalCostUsd;
}

async function historyCost(dir: string, cache: string): Promise<number> {
  const { createHistoryReader } = await import('@/lib/usage/history-service');
  const { createBundledRateTable } = await import('@/lib/usage/bundled-rates');
  const at = Date.now();
  const read = createHistoryReader({
    roots: async () => [{ provider: 'claude', path: dir, format: 'jsonl' }],
    cacheDirectory: path.join(root, 'history-cache', cache),
    now: () => at,
    // The bundled table is built from rate-table.ts; LiteLLM is the online source.
    pricing: async () => ({ table: createBundledRateTable(modelRateTable.rates), at,
      meta: { source: 'Bundled model rates', observedAt: modelRateTable.observedOn, status: 'bundled' as const } }),
  });
  const history = await read({ days: 1, timeZone: 'UTC' });
  return history.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);
}

async function proxyCost(usage: Record<string, unknown>): Promise<number> {
  const { output_tokens: outputTokens, ...start } = usage;
  const events = [
    { type: 'message_start', message: { usage: { ...start, output_tokens: 1 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', usage: { output_tokens: outputTokens } },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )));
  const { POST } = await import('@/app/api/v2/proxy/llm/route');
  const response = await POST(new NextRequest('http://localhost/api/v2/proxy/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', provider: 'anthropic', messages: [{ role: 'user', content: 'Hi' }], disableTools: true }),
  }));
  expect(response.status).toBe(200);
  const usageEvent = (await response.text()).split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; costUsd?: number })
    .find((event) => event.type === 'usage');
  return usageEvent!.costUsd!;
}

describe('one Claude Opus 5.5 request costs the same on every path', () => {
  it.each(scenarios)('$name', async ({ name, usage, usd, proxy }) => {
    const { dir, file } = await writeTranscript(usage);
    const costs = {
      analytics: await analyticsCost(),
      parser: await parserCost(file),
      history: await historyCost(dir, name),
      ...(proxy ? { proxy: await proxyCost(usage) } : {}),
    };
    // Rounded to a billionth of a dollar, so one diff shows every path.
    const round = (value: number) => Math.round(value * 1e9) / 1e9;
    expect(Object.fromEntries(Object.entries(costs).map(([pathName, cost]) => [pathName, round(cost)])))
      .toEqual(Object.fromEntries(Object.keys(costs).map((pathName) => [pathName, round(usd)])));
  }, 60_000);
});
