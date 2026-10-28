// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock('@/lib/runtimes/shared/auth-detect', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  getDispatchableRuntimeAvailability: fixtures.inventory,
}));
vi.mock('@/lib/operator/defaults', async original => {
  const actual = await original<typeof import('@/lib/operator/defaults')>();
  return { ...actual, getOperatorDefaultsSync: () => {
    const snapshot = actual.getOperatorDefaultsSync();
    return { ...snapshot, sources: { ...snapshot.sources, workerRuntimes: 'file' },
      values: { ...snapshot.values, workerRuntimes: ['claude-code'], defaultDispatchRuntime: 'claude-code' } };
  } };
});

const dataDir = mkdtempSync(join(tmpdir(), 'o8-worker-catalog-failure-'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
vi.stubEnv('O8_DATA_DIR', dataDir);
const { GET } = await import('@/app/api/orchestrator/delegate/route');
const { createCortexDelegationHandlers } = await import('@/lib/mcp/cortex-delegation-handlers');
const { ToolCallChipCluster } = await import('@/components/desktop/thoughts/chat-panel/ToolCallChipCluster');
const delays: number[] = [];
const responses: Response[] = [];
const read = vi.fn(async (input: RequestInfo | URL) => {
  const response = await GET(new NextRequest(String(input), { headers: { host: 'localhost' } }));
  responses.push(response.clone());
  return response;
});
const handlers = createCortexDelegationHandlers({ apiFetch: async () => ({}), apiBase: 'http://localhost',
  repoPath: dataDir, parentThreadId: '', fastCapability: '', wsToken: '' });

beforeEach(() => {
  vi.clearAllMocks(); delays.length = 0; responses.length = 0;
  fixtures.inventory.mockReset();
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 250 || ms === 500) { delays.push(ms); return timer(callback, 0, ...args); }
    return timer(callback, ms, ...args);
  }) as typeof setTimeout);
  vi.stubGlobal('fetch', read);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(dataDir, { recursive: true, force: true }); });

it('names the real failed catalog call and status in the tool and operator error card after bounded retries', async () => {
  fixtures.inventory.mockRejectedValue(new Error('Runtime inventory temporarily unavailable.'));
  const result = await handlers.handleWorkerCatalog({});
  expect(read).toHaveBeenCalledTimes(3);
  expect(delays).toEqual([250, 500]);
  expect(responses.map(response => response.status)).toEqual([503, 503, 503]);
  expect(await responses[0]!.json()).toMatchObject({ ok: false, call: 'GET /api/orchestrator/delegate',
    step: 'getDispatchableRuntimeAvailability', status: 503, retryable: true });
  expect(result.isError).toBe(true);
  const text = result.content[0]!.text;
  expect(text).toContain('GET /api/orchestrator/delegate');
  expect(text).toContain('HTTP 503');
  expect(text).toContain('getDispatchableRuntimeAvailability');
  expect(text).toContain('Runtime inventory temporarily unavailable.');
  expect(text).toContain('3 attempts');
  const html = renderToStaticMarkup(createElement(ToolCallChipCluster, { toolCalls: [
    { id: 'catalog-failure', name: 'cortex_worker_catalog', status: 'error', result: text },
  ] }));
  expect(html).toContain('role="alert"');
  expect(html).toContain('GET /api/orchestrator/delegate');
  expect(html).toContain('HTTP 503');
  expect(html).toContain('Runtime inventory temporarily unavailable.');
});

it('retries a transient catalog failure through the same GET route and returns the recovered pool', async () => {
  fixtures.inventory.mockRejectedValueOnce(new Error('Inventory read failed.'))
    .mockResolvedValue([{ id: 'claude-code', available: true }]);
  const result = await handlers.handleWorkerCatalog({});
  expect(result.isError).not.toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(delays).toEqual([250]);
  expect(read.mock.calls.map(([input]) => new URL(String(input)).pathname))
    .toEqual(['/api/orchestrator/delegate', '/api/orchestrator/delegate']);
  expect(JSON.parse(result.content[0]!.text).workers).toEqual([
    expect.objectContaining({ runtime: 'claude-code', available: true }),
  ]);
});

it('names an invalid catalog request without retrying its client error', async () => {
  const result = await handlers.handleWorkerCatalog({ runtime: 'invalid-worker' });
  expect(result.isError).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(delays).toEqual([]);
  expect(result.content[0]!.text).toContain('GET /api/orchestrator/delegate');
  expect(result.content[0]!.text).toContain('HTTP 400');
  expect(result.content[0]!.text).toContain('Unknown worker runtime.');
  expect(fixtures.inventory).not.toHaveBeenCalled();
});
