import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warning = '[startup] Optional initialization failed; continuing startup.';
const calls: string[] = [];
const importedModules: string[] = [];
let failedImport: string | null = null;
let healthReady = true;
let bootstrapFailures = 0;
const mocks = {
  installProcessCrashCapture: vi.fn(),
  startTelemetryUploadLoop: vi.fn(),
  initSentryNode: vi.fn(),
  repairFlippedOrchestratorTranscripts: vi.fn(),
  repairComposerPreamblePollution: vi.fn(),
  runUnifiedSearchBackfills: vi.fn(),
  ensureReviewQueueDrainStarted: vi.fn(),
};
const warn = vi.fn();

function failImportIfSelected(module: string): void {
  if (failedImport === module) throw new Error('synthetic import failure');
}

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as { __o8NextStartupScheduled?: boolean }).__o8NextStartupScheduled;
  delete (globalThis as { __o8NextOptionalStartup?: Promise<void> }).__o8NextOptionalStartup;
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('O8_PACKAGED_APP', undefined);
  vi.stubEnv('NEXT_PHASE', undefined);
  vi.spyOn(console, 'warn').mockImplementation(warn);
  calls.length = 0;
  importedModules.length = 0;
  failedImport = null;
  healthReady = true;
  bootstrapFailures = 0;
  for (const [name, mock] of Object.entries(mocks)) {
    mock.mockImplementation(() => { calls.push(name); });
  }

  vi.doMock('@/lib/panel/status-boot', () => ({ startStatusBootHooks: vi.fn() }));
  // Voice preparation is tested with an injected runner; diagnostics stay hermetic.
  vi.doMock('@/lib/tts/ensure-edge-tts', () => ({ ensureEdgeTtsInstalled: vi.fn(async () => {}) }));
  vi.doMock('@/lib/lane/registry', () => ({ getLane: vi.fn() }));
  vi.doMock('@/lib/lane/auto-review', () => ({ triggerAutoReview: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/panel/status')) return Response.json({ product: 'o8' }, { status: healthReady ? 200 : 503 });
    if (bootstrapFailures-- > 0) return Response.json({}, { status: 503 });
    const { POST } = await import('@/app/api/review/auto-review/route');
    return POST(new NextRequest(url, { ...init, signal: init?.signal ?? undefined }));
  }));
  vi.doMock('@/lib/telemetry/crash-capture', () => {
    failImportIfSelected('@/lib/telemetry/crash-capture');
    importedModules.push('crash-capture');
    return { installProcessCrashCapture: mocks.installProcessCrashCapture };
  });
  vi.doMock('@/lib/telemetry/uploader', () => {
    failImportIfSelected('@/lib/telemetry/uploader');
    importedModules.push('uploader');
    return { startTelemetryUploadLoop: mocks.startTelemetryUploadLoop };
  });
  vi.doMock('@/lib/telemetry/sentry-node', () => {
    failImportIfSelected('@/lib/telemetry/sentry-node');
    importedModules.push('sentry-node');
    return { initSentryNode: mocks.initSentryNode };
  });
  vi.doMock('@/lib/mobile/orchestrator-thread-history', () => {
    failImportIfSelected('@/lib/mobile/orchestrator-thread-history');
    importedModules.push('transcript-repair');
    return {
      repairFlippedOrchestratorTranscripts: mocks.repairFlippedOrchestratorTranscripts,
      repairComposerPreamblePollution: mocks.repairComposerPreamblePollution,
    };
  });
  vi.doMock('@/lib/search/backfill', () => {
    importedModules.push('backfill');
    return { runUnifiedSearchBackfills: mocks.runUnifiedSearchBackfills };
  });
  vi.doMock('@/lib/lane/review-drain-bootstrap', () => {
    importedModules.push('review-drain');
    return { ensureReviewQueueDrainStarted: mocks.ensureReviewQueueDrainStarted };
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function registerAndSettle(deferred = true): Promise<void> {
  const { register } = await import('@/instrumentation');
  await expect(register()).resolves.toBeUndefined();
  await vi.dynamicImportSettled();
  if (deferred) {
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.dynamicImportSettled();
  }
}

async function expectDeferredBackfill(): Promise<void> {
  expect(mocks.runUnifiedSearchBackfills).not.toHaveBeenCalled();
  expect(importedModules).not.toContain('backfill');
  await vi.advanceTimersByTimeAsync(1_499);
  expect(mocks.runUnifiedSearchBackfills).not.toHaveBeenCalled();
  expect(importedModules).not.toContain('backfill');
  await vi.advanceTimersByTimeAsync(1);
  await vi.dynamicImportSettled();
  expect(mocks.runUnifiedSearchBackfills).toHaveBeenCalledTimes(1);
}

function expectStageWarning(stage: 'telemetry' | 'transcript-repair'): void {
  expect(warn.mock.calls).toEqual([[warning, { stage }]]);
}

const telemetryImports = [
  '@/lib/telemetry/crash-capture',
  '@/lib/telemetry/uploader',
  '@/lib/telemetry/sentry-node',
] as const;
const telemetryInitializers = [
  'installProcessCrashCapture',
  'startTelemetryUploadLoop',
  'initSentryNode',
] as const;
const repairInitializers = [
  'repairFlippedOrchestratorTranscripts',
  'repairComposerPreamblePollution',
] as const;

describe('startup stage diagnostics through register', () => {
  it('reserves the first two seconds for the dashboard before optional bootstrap requests', async () => {
    await registerAndSettle(false);
    await vi.advanceTimersByTimeAsync(1_999);
    await vi.dynamicImportSettled();
    expect(fetch, 'optional bootstrap must leave the document and hydration a startup grace period').not.toHaveBeenCalled();
    expect(calls).toEqual(['installProcessCrashCapture']);
    await vi.advanceTimersByTimeAsync(1);
    await vi.dynamicImportSettled();
    expect(calls).toEqual([...telemetryInitializers, ...repairInitializers]);
  });

  it('retries only after health and starts each subsystem once across duplicate registration and POSTs', async () => {
    healthReady = false;
    bootstrapFailures = 1;
    await registerAndSettle();
    expect(calls).toEqual(['installProcessCrashCapture']);
    expect(fetch).toHaveBeenCalledTimes(1);
    healthReady = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(['installProcessCrashCapture']);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.dynamicImportSettled();
    expect(calls).toEqual([...telemetryInitializers, ...repairInitializers]);
    const { register } = await import('@/instrumentation');
    await register();
    const { POST } = await import('@/app/api/review/auto-review/route');
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    await Promise.all([1, 2].map(() => POST(new NextRequest('http://127.0.0.1/api/review/auto-review', {
      method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({ action: 'bootstrap' }),
    }))));
    expect(mocks.startTelemetryUploadLoop).toHaveBeenCalledOnce();
    expect(mocks.repairComposerPreamblePollution).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.dynamicImportSettled();
    expect(mocks.runUnifiedSearchBackfills).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('rejects an unauthenticated bootstrap before importing optional subsystems', async () => {
    const { POST } = await import('@/app/api/review/auto-review/route');
    const response = await POST(new NextRequest('http://fixture.invalid/api/review/auto-review', {
      method: 'POST', headers: { host: 'fixture.invalid', 'x-o8-client-addr': '192.0.2.1' },
      body: JSON.stringify({ action: 'bootstrap' }),
    }));
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
    expect(importedModules).toEqual(['review-drain']);
  });

  it('returns from registration before loading optional subsystems, then initializes them', async () => {
    await registerAndSettle(false);
    expect(calls).toEqual(['installProcessCrashCapture']);
    expect(importedModules).toEqual(['crash-capture']);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.dynamicImportSettled();
    expect(calls).toEqual([...telemetryInitializers, ...repairInitializers]);
    await expectDeferredBackfill();
  });

  it('keeps successful startup quiet and preserves initialization order and delayed backfill', async () => {
    await registerAndSettle();

    expect(calls).toEqual([...telemetryInitializers, ...repairInitializers]);
    expect(mocks.installProcessCrashCapture).toHaveBeenCalledWith('next-server');
    expect(mocks.initSentryNode).toHaveBeenCalledWith('server');
    expect(mocks.ensureReviewQueueDrainStarted).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await expectDeferredBackfill();
    expect(calls).toEqual([...telemetryInitializers, ...repairInitializers, 'runUnifiedSearchBackfills']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does no optional work or logging in Edge even when packaged', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('O8_PACKAGED_APP', '1');

    await registerAndSettle();
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.dynamicImportSettled();

    expect(importedModules).toEqual([]);
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(telemetryImports)('identifies telemetry import failure at %s and continues later work', async (module) => {
    failedImport = module;

    await registerAndSettle();
    expect(mocks.repairFlippedOrchestratorTranscripts).toHaveBeenCalledTimes(1);
    expect(mocks.repairComposerPreamblePollution).toHaveBeenCalledTimes(1);
    await expectDeferredBackfill();
    expectStageWarning('telemetry');
  });

  it.each(telemetryInitializers)('identifies unexpected telemetry initializer failure at %s', async (initializer) => {
    mocks[initializer].mockImplementation(() => { throw new Error('synthetic initializer failure'); });

    await registerAndSettle();
    expect(mocks.repairFlippedOrchestratorTranscripts).toHaveBeenCalledTimes(1);
    expect(mocks.repairComposerPreamblePollution).toHaveBeenCalledTimes(1);
    await expectDeferredBackfill();
    expectStageWarning('telemetry');
  });

  it('identifies transcript-repair import failure and continues delayed backfill', async () => {
    failedImport = '@/lib/mobile/orchestrator-thread-history';

    await registerAndSettle();
    expect(calls).toEqual([...telemetryInitializers]);
    await expectDeferredBackfill();
    expectStageWarning('transcript-repair');
  });

  it.each(repairInitializers)('identifies unexpected transcript-repair failure at %s', async (initializer) => {
    mocks[initializer].mockImplementation(() => { throw new Error('synthetic repair failure'); });

    await registerAndSettle();
    expect(calls.slice(0, 3)).toEqual([...telemetryInitializers]);
    await expectDeferredBackfill();
    expectStageWarning('transcript-repair');
  });

  it.each([
    ['telemetry', 'installProcessCrashCapture'],
    ['transcript-repair', 'repairFlippedOrchestratorTranscripts'],
  ] as const)('never inspects or logs arbitrary exception content for %s', async (stage, initializer) => {
    const inspect = vi.fn(() => { throw new Error('exception properties must stay unread'); });
    const failure = Object.create(null);
    for (const property of ['message', 'stack', 'body', 'path', 'token', 'toString', 'toJSON', Symbol.toPrimitive]) {
      Object.defineProperty(failure, property, { get: inspect });
    }
    mocks[initializer].mockImplementation(() => { throw failure; });

    await registerAndSettle();
    await expectDeferredBackfill();
    expect(inspect).not.toHaveBeenCalled();
    expectStageWarning(stage);
  });

  it.each([
    ['telemetry', 'installProcessCrashCapture'],
    ['transcript-repair', 'repairFlippedOrchestratorTranscripts'],
  ] as const)('continues startup when the warning sink throws for %s', async (stage, initializer) => {
    mocks[initializer].mockImplementation(() => { throw new Error('synthetic startup failure'); });
    warn.mockImplementation(() => { throw new Error('synthetic warning sink failure'); });

    await registerAndSettle();
    await expectDeferredBackfill();
    expectStageWarning(stage);
  });
});
