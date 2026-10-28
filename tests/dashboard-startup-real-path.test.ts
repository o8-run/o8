// @o8-test-browser
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Opt-in because this exercises an existing full production build in Chromium.
// npm run build, then O8_DASHBOARD_STARTUP_CHECK=1 npx vitest run <this file>.
it.skipIf(process.env.O8_DASHBOARD_STARTUP_CHECK !== '1')(
  'serves and hydrates the standalone dashboard within budget while restoring its saved tabs',
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'o8-dashboard-budget-'));
    try {
      const modulePath = resolve('scripts/bench/dashboard-startup.mjs');
      const { measureDashboardStartup, compareDashboardStartup } = await import(/* @vite-ignore */ modulePath);
      const options = {
        evidenceDir: process.env.O8_DASHBOARD_STARTUP_RECEIPT ? dirname(process.env.O8_DASHBOARD_STARTUP_RECEIPT) : temporary,
        samples: 3,
      };
      const comparison = process.env.O8_DASHBOARD_STARTUP_BASELINE
        ? await compareDashboardStartup({ ...options, baselineBuildDir: process.env.O8_DASHBOARD_STARTUP_BASELINE })
        : null;
      const receipt = comparison?.after ?? await measureDashboardStartup(options);
      if (process.env.O8_DASHBOARD_STARTUP_RECEIPT) {
        writeFileSync(process.env.O8_DASHBOARD_STARTUP_RECEIPT, JSON.stringify(comparison ?? receipt, null, 2) + '\n');
      }
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const documents = receipt.samples.map((sample: { documentMs: number }) => sample.documentMs);
      const hydration = receipt.samples.map((sample: { hydrationMs: number }) => sample.hydrationMs);
      console.log(JSON.stringify({ documentMs: documents, hydrationMs: hydration,
        documentMedianMs: median(documents), hydrationMedianMs: median(hydration) }));
      // Match the median phase convention in native-composer-startup.md;
      // retain every sample and report worst values in the numeric receipt.
      expect.soft(median(documents), 'document median < 300 ms').toBeLessThan(300);
      expect.soft(median(hydration), 'hydration median < 500 ms').toBeLessThan(500);
      for (const sample of receipt.samples) {
        expect(sample.restoredTabs).toBe(4);
        expect(sample.tabSwitches).toBe(2);
        expect(sample.projectsRoundTrip).toBe(true);
        expect(sample.frameGeometryPreserved).toBe(true);
        expect(sample.draftCleared).toBe(true);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  300_000,
);
