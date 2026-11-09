import { afterEach, expect, it, vi } from 'vitest';

// Next's packaged startup opens the o8 next window unless the shell names the WS process the
// owner (#5709). The WS side of the same rule is covered by o8d-window-owner-real-path.
const restoreNextWindow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/next/app-window', () => ({ restoreNextWindow }));
vi.mock('@/lib/orchestrator/shared-worker-recovery', () => ({ settleSharedCheckoutTeams: async () => {} }));
vi.mock('@/lib/lane/review-drain-bootstrap', () => ({ ensureReviewQueueDrainStarted: () => {} }));
vi.mock('@/lib/telemetry/uploader', () => ({ startTelemetryUploadLoop: () => {} }));
vi.mock('@/lib/telemetry/sentry-node', () => ({ initSentryNode: async () => {} }));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  repairFlippedOrchestratorTranscripts: () => {}, repairComposerPreamblePollution: () => {} }));
vi.mock('@/lib/symon/messages-receiver/loop', () => ({ startMessagesReceiver: () => {} }));
vi.mock('@/lib/panel/status-boot', () => ({ startStatusBootHooks: () => {} }));
vi.mock('@/lib/search/backfill', () => ({ runUnifiedSearchBackfills: async () => {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __o8NextOptionalStartup?: Promise<void> }).__o8NextOptionalStartup;
  restoreNextWindow.mockClear();
});

it.each([
  ['unset', undefined, 1],
  ['next', 'next', 1],
  ['ws', 'ws', 0],
])('opens the window from Next startup only when the WS process is not the owner (%s)', async (_, owner, calls) => {
  vi.resetModules();
  vi.stubEnv('O8_PACKAGED_APP', '1');
  vi.stubEnv('NEXT_PHASE', 'phase-production-server');
  vi.stubEnv('O8_NEXT_WINDOW_OWNER', owner);
  const { ensureNextServerInitialized } = await import('@/lib/startup/next');
  await ensureNextServerInitialized();
  await vi.dynamicImportSettled();
  expect(restoreNextWindow).toHaveBeenCalledTimes(calls);
});
