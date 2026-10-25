import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Launch the scheduler fixture in its own process so source/platform seams and
// persisted lane state cannot leak into another launch or test file.
it.each(['matching', 'lockfile', 'installed'])(
  'launches with shrinkwrap dependency inputs: %s', async (condition) => {
    const receipt = path.join(process.env.CORTEX_IDE_DATA_DIR!, `shrinkwrap-${condition}.json`);
    try {
      await promisify(execFile)(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
        'tests/packet-launch-budget-real-path.test.ts'], {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, O8_SPEED_SHRINKWRAP: '1', O8_SPEED_WARM: '0', O8_SPEED_RECEIPT: receipt,
          O8_SPEED_SHRINKWRAP_STALE: condition === 'matching' ? '' : condition },
      });
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string };
      throw new Error(`Scheduler fixture failed.\n${result.stdout ?? ''}\n${result.stderr ?? ''}`, { cause: error });
    }
    const measured = JSON.parse(await readFile(receipt, 'utf8'));
    expect(measured.sessionMs).toBeGreaterThan(0);
    expect(measured.dispatchToOutputMs).toBeLessThan(60_000);
    expect(measured.stages.dependencyProvisioningMs).toBeGreaterThan(0);
  }, 150_000,
);
