import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

it('charges a watcher, interval or long timer a run created to its own entry, never to the loop', async () => {
  vi.stubEnv('O8_BACKGROUND_LEDGER', '1');
  const dir = mkdtempSync(join(tmpdir(), 'o8-ledger-'));
  const file = join(dir, 'watched.txt');
  writeFileSync(file, 'a');
  let watcher: ReturnType<typeof watch> | undefined;
  let interval: NodeJS.Timeout | undefined;
  let fired: () => void = () => {};
  const watched = new Promise<void>((resolve) => { fired = resolve; });
  let ticks = 0;
  try {
    await trackRun('fixture-creator', async () => {
      busy(10);
      watcher = watch(dir, () => {
        busy(40);
        // Work a watcher callback starts after an await is still the watcher's.
        void Promise.resolve().then(() => { busy(20); fired(); });
      });
      interval = setInterval(() => {
        ticks += 1;
        if (ticks === 1) busy(30);
        // A loop run that the interval starts is charged to that loop.
        if (ticks === 1) trackRun('fixture-started', () => busy(25));
      }, 20);
      setTimeout(() => busy(35), 1_000);
    });
    const loop = () => ledgerSnapshot().find((item) => item.name === 'fixture-creator')!;
    const settled = loop().mainMs;
    expect(settled).toBeLessThan(40);

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(file, 'b');
    await watched;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    clearInterval(interval);

    // The creating loop accrued nothing after its run settled.
    expect(loop().mainMs).toBeLessThan(settled + 10);
    const entries = Object.fromEntries(ledgerSnapshot().map((item) => [item.name, item]));
    expect(entries['fixture-creator › fs watcher']?.mainMs).toBeGreaterThanOrEqual(55);
    expect(entries['fixture-creator › interval']?.mainMs).toBeGreaterThanOrEqual(30);
    expect(entries['fixture-creator › timer']?.mainMs).toBeGreaterThanOrEqual(30);
    expect(entries['fixture-started']?.mainMs).toBeGreaterThanOrEqual(20);
    expect(entries['fixture-started']?.runs).toBe(1);
  } finally {
    watcher?.close();
    clearInterval(interval);
    rmSync(dir, { recursive: true, force: true });
  }
});

