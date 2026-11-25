import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('O8_NO_PHONE_HOME', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-no-phone-home-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    for (const name of ['O8_NO_PHONE_HOME', 'O8_UPDATE_AUTO_APPLY', 'O8_AUTO_APPLY_UPDATES']) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('turns off automatic updates over saved settings', async () => {
    const { getOperatorDefaults, updateOperatorDefaults } = await import('./defaults');
    await updateOperatorDefaults({ updateAutoApply: 'idle' });
    const saved = await getOperatorDefaults();
    expect(saved.values).toMatchObject({ updateAutoApply: 'idle' });

    vi.stubEnv('O8_NO_PHONE_HOME', '1');
    // The switch wins over the separate variable too.
    vi.stubEnv('O8_UPDATE_AUTO_APPLY', 'idle');
    const quiet = await getOperatorDefaults();
    expect(quiet.values).toMatchObject({ updateAutoApply: 'off' });
    expect(quiet.sources).toMatchObject({ updateAutoApply: 'env' });
  });

  it('changes nothing unless set to 1', async () => {
    const { getOperatorDefaults, updateOperatorDefaults } = await import('./defaults');
    await updateOperatorDefaults({ updateAutoApply: 'idle' });
    vi.stubEnv('O8_NO_PHONE_HOME', '0');
    expect((await getOperatorDefaults()).values).toMatchObject({ updateAutoApply: 'idle' });
  });
});
