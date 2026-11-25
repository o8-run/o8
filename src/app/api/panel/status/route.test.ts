import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { build } from 'esbuild';

vi.mock('@/lib/lane/registry', () => ({ getLane: vi.fn() }));
vi.mock('@/lib/lane/auto-review', () => ({ triggerAutoReview: vi.fn() }));
vi.mock('@/lib/lane/review-drain-bootstrap', () => ({ ensureReviewQueueDrainStarted: vi.fn() }));
vi.mock('@/lib/telemetry/uploader', () => ({ startTelemetryUploadLoop: vi.fn() }));
vi.mock('@/lib/telemetry/sentry-node', () => ({ initSentryNode: vi.fn() }));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  repairFlippedOrchestratorTranscripts: vi.fn(), repairComposerPreamblePollution: vi.fn(),
}));
vi.mock('@/lib/search/backfill', () => ({ runUnifiedSearchBackfills: vi.fn() }));

vi.mock('@/lib/cortex/decay', () => ({ ensureDecayBootHook: vi.fn() }));
vi.mock('@/lib/cortex/proposer', () => ({ ensureProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/stack-signature', () => ({ ensureStackSignatureBoot: vi.fn() }));
vi.mock('@/lib/cortex/cross-repo-proposer', () => ({ ensureCrossRepoProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/external-merge-watcher', () => ({ ensureExternalMergeBootHook: vi.fn() }));
const { ensureShippedDarkAuditBootHookMock } = vi.hoisted(() => ({
  ensureShippedDarkAuditBootHookMock: vi.fn(),
}));
vi.mock('@/lib/operator/shipped-dark-scheduler', () => ({ ensureShippedDarkAuditBootHook: ensureShippedDarkAuditBootHookMock }));
vi.mock('@/lib/operator/shipped-dark-receipt', () => ({
  currentShippedDarkAuditStatus: () => ({
    schema: 'o8/shipped-dark-audit-status/v2',
    status: 'attention',
    checkedAt: '2026-08-27T12:05:00.000Z',
    currentRelease: '0.1.716',
    thresholdReleases: 3,
    checkedFlagCount: 14,
    attentionFlagCount: 1,
    flags: [{
      tomlKey: 'experimental.chat_enabled',
      codeDefault: false,
      operatorValue: false,
      operatorValueSource: 'default',
      landedRelease: '0.1.681',
      darkForReleases: 35,
      lifecycle: 'promotion-candidate',
      lifecycleRationale: null,
      needsAttention: true,
    }],
  }),
}));
vi.mock('@/lib/terminal/tmux', () => ({ persistentTerminalsEnabled: () => true }));
vi.mock('@/lib/terminal/persistence-health', () => ({
  currentPersistentTerminalHealth: () => ({
    schema: 'o8/persistent-terminal-health/v1',
    status: 'degraded',
    reason: 'tmux_unavailable',
    checkedAt: '2026-08-27T12:00:00.000Z',
  }),
}));

const { GET } = await import('./route');

const local = () => new NextRequest('http://127.0.0.1:3001/api/panel/status', {
  headers: { host: '127.0.0.1:3001', 'x-o8-client-addr': '127.0.0.1' },
});
const lan = (headers: Record<string, string> = {}) => new NextRequest('http://192.168.1.20:3001/api/panel/status', {
  headers: { host: '192.168.1.20:3001', 'x-o8-client-addr': '192.168.1.50', ...headers },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/panel/status', () => {
  it('keeps audit execution and model subsystems out of the health import graph', async () => {
    const compiled = await build({ entryPoints: ['src/app/api/panel/status/route.ts'], bundle: true,
      platform: 'node', format: 'esm', packages: 'external', write: false, metafile: true });
    expect(Object.keys(compiled.metafile!.inputs).filter(file =>
      /shipped-dark-audit\.ts|cortex\/proposer/.test(file))).toEqual([]);
  });

  it('answers health before starting background indexing and learning, then starts each hook', async () => {
    vi.useFakeTimers();
    const hooks = [
      (await import('@/lib/cortex/decay')).ensureDecayBootHook,
      (await import('@/lib/cortex/proposer')).ensureProposerBootTick,
      (await import('@/lib/cortex/stack-signature')).ensureStackSignatureBoot,
      (await import('@/lib/cortex/cross-repo-proposer')).ensureCrossRepoProposerBootTick,
      (await import('@/lib/cortex/external-merge-watcher')).ensureExternalMergeBootHook,
      ensureShippedDarkAuditBootHookMock,
    ];
    try {
      const response = await GET(local());
      expect(response.status).toBe(200);
      for (const hook of hooks) expect(hook).not.toHaveBeenCalled();
      const { getOrCreateWsToken } = await import('@/lib/ws-auth');
      const { POST } = await import('@/app/api/review/auto-review/route');
      const started = await POST(new NextRequest('http://127.0.0.1/api/review/auto-review', {
        method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
        body: JSON.stringify({ action: 'bootstrap' }),
      }));
      expect(started.status).toBe(200);
      for (const hook of hooks) expect(hook).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.clearAllMocks();
    }
  });

  it('identifies the unauthenticated liveness responder as o8', async () => {
    const response = await GET(local());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      product: 'o8',
      mode: 'local-cli',
      terminalPersistence: {
        status: 'degraded',
        reason: 'tmux_unavailable',
      },
      shippedDarkAudit: {
        status: 'attention',
        checkedFlagCount: 14,
        attentionFlagCount: 1,
        flags: [expect.objectContaining({
          tomlKey: 'experimental.chat_enabled',
          darkForReleases: 35,
          lifecycle: 'promotion-candidate',
          needsAttention: true,
        })],
      },
    });
  });

  it('tells an unauthenticated network caller only that this is o8', async () => {
    vi.stubEnv('O8_BUILD_GIT_SHA', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01');
    const response = await GET(lan());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: 'o8' });

    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const authorized = await (await GET(lan({ authorization: `Bearer ${getOrCreateWsToken()}` }))).json();
    expect(authorized).toMatchObject({ product: 'o8', buildGitSha: 'abcdef0123456789abcdef0123456789abcdef01', platform: process.platform });
    expect((await (await GET(lan({ authorization: 'Bearer not-a-token' }))).json())).toEqual({ product: 'o8' });
  });

  it('reports the packaged build identity without reading a source checkout', async () => {
    vi.stubEnv('O8_BUILD_GIT_SHA', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01');
    vi.stubEnv('O8_PACKAGED_APP', '1');

    const response = await GET(local());
    expect(await response.json()).toMatchObject({
      buildGitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      buildMode: 'packaged',
    });
  });
});
