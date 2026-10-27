import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each(['absolute-link', 'truncated', 'missing', 'same-size', 'hidden-escape', 'healthy', 'contained-link', 'hidden-absolute-link', 'hidden-escaping-link', 'hidden-missing', 'hidden-same-size'])(
  'keeps two live workers private after a %s dependency defect', async defect => {
    const receipt = path.join(process.env.CORTEX_IDE_DATA_DIR!, `payload-${defect}.json`);
    try {
      await promisify(execFile)(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/packet-launch-budget-real-path.test.ts'], {
        timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, O8_SPEED_SHRINKWRAP: '1', O8_SPEED_WARM: '0', O8_SPEED_CONCURRENT: '1',
          O8_SPEED_DEPENDENCY_DEFECT: defect, O8_SPEED_RECEIPT: receipt },
      });
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string };
      throw new Error(`Persisted worker launch failed.\n${result.stdout ?? ''}\n${result.stderr ?? ''}`, { cause: error });
    }
    const observed = JSON.parse(await readFile(receipt, 'utf8'));
    process.stdout.write(`[dependency-payload-workers] ${JSON.stringify({ defect, liveWorkers: observed.liveWorkers,
      isolated: observed.isolated, sharedFiles: observed.sharedFiles, unsafeLinks: observed.unsafeLinks,
      selections: observed.selections.map((event: { path: string; reason: string }) => ({ path: event.path, reason: event.reason })) })}\n`);
    expect(observed).toMatchObject({ defect, liveWorkers: 2, isolated: true, sharedFiles: 0, unsafeLinks: [] });
  }, 270_000,
);
