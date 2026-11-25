import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-operator-defaults-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  getOperatorDefaults,
  getOperatorDefaultsTomlPath,
  OPERATOR_DEFAULTS_FALLBACK,
  updateOperatorDefaults,
} = await import('./defaults');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');
const { assertRoutingTomlCompatibility } = await import('./routing-compatibility');

/**
 * Evaporation guard: updateOperatorDefaults copies each field from the update
 * into the stored file with a per-field block — a field that is validated by
 * the API route but missing its copy block here silently round-trips to the
 * old value (bit reviewerBackend on 2026-07-07: the settings UI accepted the
 * click, the POST returned 200, and nothing persisted). Every UI-settable
 * knob gets a non-default value below; add new knobs here when adding
 * them to the writer.
 */
const NON_DEFAULT_UPDATE = {
  parallelCap: 3,
  overlapGate: 'advisory',
  healBotEnabled: false,
  supervisorAutoEscalate: true,
  broadcastCommentary: 'interval',
  broadcastCommentaryIntervalMinutes: 7,
  broadcastCommentaryMinNewEvents: 5,
  broadcastCommentaryMaxPerHour: 9,
  broadcastVoice: 'on',
  broadcastVoiceCalendar: false,
  broadcastVoiceCalendarLeadMinutes: 20,
  broadcastVoiceTimeCheckins: false,
  presentationQuietMode: true,
  notificationsReviewReady: 'off',
  thinkingEffort: 'low',
  promptCachingEnabled: false,
  orchestratorModel: 'claude-opus-4-8',
  defaultDispatchRuntime: 'claude-code',
  workerRuntimes: ['claude-code', 'codex'] as Array<'claude-code' | 'codex'>,
  codexWorkerEffort: 'xhigh',
  claudeWorkerEffort: 'max',
  brainCodexModel: 'gpt-5.6-sol',
  brainCodexEffort: 'high',
  brainRoutingMode: 'subscription',
  defaultDispatchModel: 'some-model',
  experimentalOpencode: true,
  experimentalGemini: true,
  experimentalChat: true,
  experimentalCanvas: true,
  nativeBrowserView: false,
  inAppOrchestratorEnabled: false,
  symonVoiceSubscriptionOnly: true,
  brainUseClaudeCli: false,
  brainWarmupEnabled: false,
  workersUseBrain: 'off',
  judgmentProvider: 'typesafe',
  judgmentManagedOptionVisible: true,
  uiLoopMaxIterations: 6,
  uiLoopMaxMinutes: 24,
  uiLoopMaxDiffBytes: 48_000,
  uiLoopMaxDiffFiles: 9,
  uiLoopPreviewTimeoutMs: 18_000,
  workspaceManifestPolicy: 'auto',
  crossHouseWorkerFallback: true,
  orchestratorBackend: 'collide',
  reviewerBackend: 'codex',
  buyinDocEnabled: true,
  updateAutoApply: 'idle',
  collideAggregator: 'claude',
  productTelemetryEnabled: true,
  telemetryOptIn: true,
  telemetryIngestUrl: 'https://telemetry.example/ingest',
  crashReportsEnabled: false,
  branchPrefix: 'wip',
  commitAttributionEnabled: true,
  prLinkDestination: 'browser',
  worktreeMaxCount: 12,
  worktreeMaxTotalGb: 8,
  storageReserveRatio: 0.15,
  storageReserveFloorGb: 12,
  workspaceParkingMode: 'pressure',
  judgmentManagedDailyAllowance: 25,
  judgmentBetaEndDate: '2026-11-30',
} as const;

describe('updateOperatorDefaults round-trip', () => {
  it('migrates the legacy autoApplyUpdates value to updateAutoApply', async () => {
    writeFileSync(join(dataDir, 'operator-defaults.json'), JSON.stringify({
      autoApplyUpdates: 'when-idle',
    }));
    expect((await getOperatorDefaults()).values.updateAutoApply).toBe('idle');
  });

  it('migrates an explicit legacy Brain CLI selection to subscription mode but leaves a bare legacy default on auto', async () => {
    rmSync(getOperatorDefaultsTomlPath(), { force: true });
    writeFileSync(join(dataDir, 'operator-defaults.json'), JSON.stringify({ classAComposer: 'sonnet-cli' }));
    expect((await getOperatorDefaults()).values.brainRoutingMode).toBe('subscription');

    writeFileSync(join(dataDir, 'operator-defaults.json'), JSON.stringify({ brainUseClaudeCli: true }));
    expect((await getOperatorDefaults()).values.brainRoutingMode).toBe('auto');
  });

  it('persists every settable field (no silent evaporation)', async () => {
    await updateOperatorDefaults({ ...NON_DEFAULT_UPDATE });
    const persisted = parseOperatorDefaultsToml(readFileSync(getOperatorDefaultsTomlPath(), 'utf8'));
    for (const [field, expected] of Object.entries(NON_DEFAULT_UPDATE)) {
      expect(persisted[field as keyof typeof persisted], `field ${field} evaporated in updateOperatorDefaults`).toEqual(expected);
    }
  });

  it('reviewerBackend survives a follow-up unrelated write', async () => {
    await updateOperatorDefaults({ reviewerBackend: 'codex' });
    const after = await updateOperatorDefaults({ parallelCap: 5 });
    expect(after.values.reviewerBackend).toBe('codex');
  });

  it('clears the persisted execution carrier back to direct launch', async () => {
    await updateOperatorDefaults({ defaultDispatchRuntime: 'codex', workerExecutionCarrier: 'ori' });
    const cleared = await updateOperatorDefaults({ workerExecutionCarrier: null });
    expect(cleared.values.workerExecutionCarrier).toBeNull();
    expect(parseOperatorDefaultsToml(readFileSync(getOperatorDefaultsTomlPath(), 'utf8')).workerExecutionCarrier).toBeNull();
  });

  it('rejects an execution carrier that is incompatible with the effective default runtime', async () => {
    await updateOperatorDefaults({ defaultDispatchRuntime: 'claude-code' });
    await expect(updateOperatorDefaults({ workerExecutionCarrier: 'ori' })).rejects.toThrow(/incompatible/);
  });

  it('honors environment-selected runtime precedence when validating updates and TOML', async () => {
    const priorRuntime = process.env.O8_DEFAULT_DISPATCH_RUNTIME;
    const priorProfile = process.env.O8_SUBSCRIPTION_PROFILE;
    process.env.O8_DEFAULT_DISPATCH_RUNTIME = 'claude-code';
    process.env.O8_SUBSCRIPTION_PROFILE = 'both';
    try {
      await expect(updateOperatorDefaults({ defaultDispatchRuntime: 'codex', workerExecutionCarrier: 'ori' }))
        .rejects.toThrow(/effective default runtime 'claude-code'/);
      expect(() => assertRoutingTomlCompatibility(
        '[models]\ndefault_dispatch_runtime = "codex"\nworker_execution_carrier = "ori"\n',
        OPERATOR_DEFAULTS_FALLBACK,
      )).toThrow(/effective default runtime 'claude-code'/);
    } finally {
      if (priorRuntime === undefined) delete process.env.O8_DEFAULT_DISPATCH_RUNTIME;
      else process.env.O8_DEFAULT_DISPATCH_RUNTIME = priorRuntime;
      if (priorProfile === undefined) delete process.env.O8_SUBSCRIPTION_PROFILE;
      else process.env.O8_SUBSCRIPTION_PROFILE = priorProfile;
    }
  });

  it('subscriptionProfile persists and flips the effective house defaults', async () => {
    const after = await updateOperatorDefaults({ subscriptionProfile: 'claude-only' });
    expect(after.values.subscriptionProfile).toBe('claude-only');
    expect(after.values.orchestratorBackend).toBe('claude');
    expect(after.values.defaultDispatchRuntime).toBe('claude-code');
    expect(after.values.reviewerBackend).toBe('claude');
  });
});
