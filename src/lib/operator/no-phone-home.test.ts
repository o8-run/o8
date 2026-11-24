import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('O8_NO_PHONE_HOME', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-no-phone-home-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    for (const name of ['O8_NO_PHONE_HOME', 'O8_UPDATE_AUTO_APPLY', 'O8_AUTO_APPLY_UPDATES', 'O8_TELEMETRY_OPT_IN', 'O8_CRASH_REPORTS']) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('turns off updates, crash-log upload and crash reports over saved settings', async () => {
    const { getOperatorDefaults, updateOperatorDefaults } = await import('./defaults');
    await updateOperatorDefaults({ updateAutoApply: 'idle', telemetryOptIn: true, crashReportsEnabled: true });
    const saved = await getOperatorDefaults();
    expect(saved.values).toMatchObject({ updateAutoApply: 'idle', telemetryOptIn: true, crashReportsEnabled: true });

    vi.stubEnv('O8_NO_PHONE_HOME', '1');
    // The switch wins over the separate per-setting variables too.
    vi.stubEnv('O8_UPDATE_AUTO_APPLY', 'idle');
    vi.stubEnv('O8_TELEMETRY_OPT_IN', '1');
    vi.stubEnv('O8_CRASH_REPORTS', '1');
    const quiet = await getOperatorDefaults();
    expect(quiet.values).toMatchObject({ updateAutoApply: 'off', telemetryOptIn: false, crashReportsEnabled: false });
    expect(quiet.sources).toMatchObject({ updateAutoApply: 'env', telemetryOptIn: 'env', crashReportsEnabled: 'env' });
  });

  it('stops usage analytics after consent was given', async () => {
    const { updateOperatorDefaults } = await import('./defaults');
    const { isProductTelemetryEnabled } = await import('@/lib/analytics/server');
    await updateOperatorDefaults({ productTelemetryEnabled: true, telemetryConsentAnswered: true });
    expect(isProductTelemetryEnabled()).toBe(true);
    vi.stubEnv('O8_NO_PHONE_HOME', '1');
    expect(isProductTelemetryEnabled()).toBe(false);
  });

  it('changes nothing unless set to 1', async () => {
    const { getOperatorDefaults, updateOperatorDefaults } = await import('./defaults');
    await updateOperatorDefaults({ updateAutoApply: 'idle', telemetryOptIn: true, crashReportsEnabled: true });
    vi.stubEnv('O8_NO_PHONE_HOME', '0');
    expect((await getOperatorDefaults()).values).toMatchObject({ updateAutoApply: 'idle', telemetryOptIn: true, crashReportsEnabled: true });
  });
});
