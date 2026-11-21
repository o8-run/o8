import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { ledgerSnapshot, resetLedger, trackRun } from './ledger';

afterEach(() => { vi.unstubAllEnvs(); resetLedger(); });

function busy(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* spin */ }
}

it('charges a loop for work after an await and for the processes it spawns', async () => {
  vi.stubEnv('O8_BACKGROUND_LEDGER', '1');
  await trackRun('fixture-loop', async () => {
    busy(20);
    await new Promise((resolve) => setTimeout(resolve, 5));
    busy(30);
    await promisify(execFile)('git', ['--version']);
    return true;
  });
  // Work outside any loop is never charged to one.
  busy(200);
  const entry = ledgerSnapshot().find((item) => item.name === 'fixture-loop')!;
  expect(entry.runs).toBe(1);
  expect(entry.mainMs).toBeGreaterThanOrEqual(45);
  // Well under the 200 ms spent outside the loop, with room for a loaded machine.
  expect(entry.mainMs).toBeLessThan(150);
  expect(entry.children).toBe(1);
  expect(entry.childCommands.git).toBe(1);
  expect(entry.changedRuns).toBe(1);
});

it('is a direct call with the ledger off', () => {
  expect(trackRun('off-loop', () => 7)).toBe(7);
  expect(ledgerSnapshot()).toEqual([]);
});
