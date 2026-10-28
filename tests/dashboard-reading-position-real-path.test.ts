// @o8-test-browser
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Opt in: starts an isolated Next dev server and records the real dashboard.
it.runIf(process.env.O8_READING_POSITION_CHECK === '1')('restores each conversation reading position and follows live output only at the bottom', async () => {
  const result = await promisify(execFile)(process.execPath, ['scripts/bench/transcript-reading-position.mjs'], { timeout: 300000 });
  expect(result.stdout).toContain('reload keeps the same compacted-history message and offset PASS');
  expect(result.stdout).toContain('live turn follows the bottom PASS');
}, 320000);
