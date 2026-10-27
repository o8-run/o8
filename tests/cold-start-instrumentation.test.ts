import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  pythonSpawn: vi.fn(),
  warmupOpenRouter: vi.fn(),
  ensureEdgeTtsInstalled: vi.fn(),
  ensureReviewQueueDrainStarted: vi.fn(),
}));

vi.mock('@/lib/panel/status-boot', () => ({ startStatusBootHooks: vi.fn() }));
vi.mock('@/lib/lane/registry', () => ({ getLane: vi.fn() }));
vi.mock('@/lib/lane/auto-review', () => ({ triggerAutoReview: vi.fn() }));
vi.mock('@/lib/lane/review-drain-bootstrap', () => ({
  ensureReviewQueueDrainStarted: mocks.ensureReviewQueueDrainStarted,
}));
vi.mock('@/lib/search/backfill', () => ({ runUnifiedSearchBackfills: vi.fn() }));

vi.mock('@/lib/telemetry/crash-capture', () => ({
  installProcessCrashCapture: vi.fn(),
}));
vi.mock('@/lib/telemetry/uploader', () => ({
  startTelemetryUploadLoop: vi.fn(),
}));
vi.mock('@/lib/telemetry/sentry-node', () => ({
  initSentryNode: vi.fn(),
}));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  repairComposerPreamblePollution: vi.fn(),
  repairFlippedOrchestratorTranscripts: vi.fn(),
}));
vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({
  warmupOpenRouter: mocks.warmupOpenRouter.mockImplementation(async () => {
    await mocks.fetch('https://openrouter.ai/api/v1/models');
  }),
}));
vi.mock('@/lib/tts/ensure-edge-tts', () => ({
  ensureEdgeTtsInstalled: mocks.ensureEdgeTtsInstalled.mockImplementation(async () => {
    mocks.pythonSpawn('python3', ['-m', 'pip', 'install', 'edge-tts']);
  }),
}));

const priorNextRuntime = process.env.NEXT_RUNTIME;
const priorO8DataDir = process.env.O8_DATA_DIR;
const priorCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
const priorPackagedApp = process.env.O8_PACKAGED_APP;
const priorNextPhase = process.env.NEXT_PHASE;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-cold-start-instrumentation-'));

beforeAll(() => {
  process.env.NEXT_RUNTIME = 'nodejs';
  process.env.O8_DATA_DIR = dataDir;
  delete process.env.CORTEX_IDE_DATA_DIR;
  delete process.env.O8_PACKAGED_APP;
  delete process.env.NEXT_PHASE;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  delete (globalThis as { __o8NextStartupScheduled?: boolean }).__o8NextStartupScheduled;
  delete (globalThis as { __o8NextOptionalStartup?: Promise<void> }).__o8NextOptionalStartup;
  vi.stubGlobal('fetch', mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/panel/status')) return Response.json({ product: 'o8' });
    const { POST } = await import('@/app/api/review/auto-review/route');
    return POST(new NextRequest(url, { ...init, signal: init?.signal ?? undefined }));
  }));
  process.env.NEXT_RUNTIME = 'nodejs';
  delete process.env.O8_PACKAGED_APP;
  delete process.env.NEXT_PHASE;
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

afterAll(() => {
  vi.unstubAllGlobals();
  if (priorNextRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = priorNextRuntime;
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  if (priorCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorCortexDataDir;
  if (priorPackagedApp === undefined) delete process.env.O8_PACKAGED_APP;
  else process.env.O8_PACKAGED_APP = priorPackagedApp;
  if (priorNextPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = priorNextPhase;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cold-start instrumentation', () => {
  it('checks the Edge voice in the background at boot without outbound model warm-up', async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    const { register } = await import('@/instrumentation');

    await register();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.dynamicImportSettled();

    expect(mocks.warmupOpenRouter).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls.every(([url]) => new URL(String(url)).hostname === '127.0.0.1')).toBe(true);
    expect(mocks.ensureEdgeTtsInstalled).toHaveBeenCalledTimes(1);
    expect(mocks.ensureReviewQueueDrainStarted).not.toHaveBeenCalled();
  });

  it('does not await Python preparation before completing registration', async () => {
    mocks.ensureEdgeTtsInstalled.mockImplementationOnce(() => new Promise<void>(() => {}));
    const { register } = await import('@/instrumentation');
    await register();
    await vi.dynamicImportSettled();
    expect(mocks.ensureEdgeTtsInstalled).toHaveBeenCalledTimes(1);
  });

  it('starts packaged server queues without a sibling request', async () => {
    process.env.O8_PACKAGED_APP = '1';
    const { register } = await import('@/instrumentation');
    await register();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.dynamicImportSettled();
    expect(mocks.ensureReviewQueueDrainStarted).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls.every(([url]) => new URL(String(url)).hostname === '127.0.0.1')).toBe(true);
  });

  it('does not start queues during a production build or in the edge runtime', async () => {
    process.env.O8_PACKAGED_APP = '1';
    process.env.NEXT_PHASE = 'phase-production-build';
    const { register } = await import('@/instrumentation');
    await register();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.dynamicImportSettled();
    expect(mocks.ensureReviewQueueDrainStarted).not.toHaveBeenCalled();
    delete process.env.NEXT_PHASE;
    process.env.NEXT_RUNTIME = 'edge';
    await register();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.dynamicImportSettled();
    expect(mocks.ensureReviewQueueDrainStarted).not.toHaveBeenCalled();
    expect(mocks.ensureEdgeTtsInstalled).not.toHaveBeenCalled();
  });
});
