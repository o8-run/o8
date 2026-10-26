import { PHASE_PRODUCTION_BUILD } from 'next/constants';

const runtime = globalThis as typeof globalThis & { __o8NextOptionalStartup?: Promise<void> };

function warn(stage: 'telemetry' | 'transcript-repair'): void {
  try {
    console.warn('[startup] Optional initialization failed; continuing startup.', { stage });
  } catch {
    // A diagnostic must not interrupt the remaining optional startup stages.
  }
}

async function initialize(): Promise<void> {
  if (process.env.O8_PACKAGED_APP === '1' && process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) {
    try {
      const { ensureReviewQueueDrainStarted } = await import('@/lib/lane/review-drain-bootstrap');
      ensureReviewQueueDrainStarted();
    } catch {
      console.warn('[auto-review] Queue startup failed.');
    }
    void import('@/lib/next/app-window').then(({ restoreNextWindow }) => restoreNextWindow()).catch(() => {});
  }
  try {
    const { startTelemetryUploadLoop } = await import('@/lib/telemetry/uploader');
    startTelemetryUploadLoop();
    const { initSentryNode } = await import('@/lib/telemetry/sentry-node');
    await initSentryNode('server');
  } catch {
    warn('telemetry');
  }
  try {
    const { repairFlippedOrchestratorTranscripts, repairComposerPreamblePollution } = await import('@/lib/mobile/orchestrator-thread-history');
    repairFlippedOrchestratorTranscripts();
    repairComposerPreamblePollution();
  } catch {
    warn('transcript-repair');
  }
  if (process.platform === 'darwin' && process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) {
    void import('@/lib/symon/messages-receiver/loop')
      .then(({ startMessagesReceiver }) => startMessagesReceiver())
      .catch(() => console.warn('[symon] Messages receiver failed to start'));
  }
  try {
    const { startStatusBootHooks } = await import('@/lib/panel/status-boot');
    startStatusBootHooks();
  } catch {
    console.warn('[startup] Status background initialization failed.');
  }
  // Preserve resumable, bounded search ingestion after startup, outside health.
  setTimeout(() => {
    void import('@/lib/search/backfill').then(({ runUnifiedSearchBackfills }) => runUnifiedSearchBackfills())
      .catch(() => console.warn('[search] backfill bootstrap failed.'));
  }, 1_500).unref?.();
}

/** Shared by route bundles and concurrent startup requests; never start duplicate loops. */
export function ensureNextServerInitialized(): Promise<void> {
  return runtime.__o8NextOptionalStartup ??= initialize();
}
