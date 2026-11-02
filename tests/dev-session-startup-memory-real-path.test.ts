import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { measureDevSessionStartup } from './fixtures/dev-session-startup-memory.mjs';

// The process-tree RSS sampler uses POSIX ps; Windows has no equivalent here.
it.skipIf(process.platform === 'win32')('starts the real dashboard and reads three 1100-message sessions within the dev server memory budget', async ({ onTestFinished }) => {
  const evidence = process.env.O8_DEV_SESSION_MEMORY_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'o8-dev-session-memory-'));
  try {
    const receipt = await measureDevSessionStartup(resolve('.'), evidence, onTestFinished);
    console.log(JSON.stringify(receipt));
    expect.soft(receipt.peakMiB, 'development compiler and server tree RSS budget').toBeLessThan(3500);
    expect(receipt.error).toBeNull();
    expect(receipt.dashboard).toBe(true);
    expect(receipt.dashboardRevisit).toBe(true);
    expect(receipt.serverProcessCount).toBe(1);
    expect(receipt.renderedIcons).toBe(true);
    expect(receipt.threadCount).toBe(8);
    expect(receipt.histories).toEqual([0, 1, 2].map(session => ({ session, rows: 1100, finalRowPresent: true })));
    expect(receipt.persistedRows).toEqual([1100, 1100, 1100]);
  } finally {
    if (!process.env.O8_DEV_SESSION_MEMORY_EVIDENCE) rmSync(evidence, { recursive: true, force: true });
  }
}, 900_000);
