import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const executablePath = resolveBrowserPath();
let browser: Browser;
let bundle: string;

function contrast(foreground: string, background: string) {
  if (foreground.startsWith('rgba(') && Number(foreground.match(/[\d.]+/g)![3]) < 1) return 1;
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function measureConsentControls(page: Page) {
  const read = () => page.locator('button[aria-pressed="true"], footer button').evaluateAll((buttons) => {
    const fixture = window as unknown as { consentMeasurementCount: number };
    fixture.consentMeasurementCount = (fixture.consentMeasurementCount ?? 0) + 1;
    return buttons.map((button) => {
      const style = getComputedStyle(button);
      return { label: button.textContent, disabled: (button as HTMLButtonElement).disabled,
        color: style.color, background: style.backgroundColor, declaredColor: (button as HTMLElement).style.color };
    });
  });
  // The opt-out persists immediately and temporarily disables these controls.
  // Measure the same selected choice and footer after that write settles.
  await expect.poll(async () => {
    const metrics = await read();
    return metrics.length === 2 && metrics.every((metric) => !metric.disabled);
  }).toBe(true);
  return read();
}

describe.skipIf(!executablePath)('privacy control contrast in rendered onboarding', () => {
  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: {
        contents: `
          import { createElement } from 'react';
          import { createRoot } from 'react-dom/client';
          import { TelemetryConsentCard } from './src/components/desktop/TelemetryConsentCard';
          import { PALETTES, resolveTheme } from './src/lib/theme/registry';
          window.mount = (palette, embedded, workspaceSurface, holdUsageSave = false) => {
            const theme = resolveTheme(PALETTES.find((item) => item.id === palette), 'glass');
            for (const [key, value] of Object.entries(theme.cssVars)) document.documentElement.style.setProperty(key, value);
            if (workspaceSurface) document.documentElement.style.setProperty('--t-chat-surface-bg', workspaceSurface);
            window.posts = [];
            window.consentMeasurementCount = 0;
            let values = { telemetryConsentAnswered: false, productTelemetryEnabled: null, crashReportsEnabled: false };
            const request = async (init) => {
              if (init.method === 'POST') {
                const change = JSON.parse(init.body);
                window.posts.push(change);
                values = { ...values, ...change };
                if (holdUsageSave && !('telemetryConsentAnswered' in change)) {
                  await new Promise((resolve) => { window.finishUsageSave = resolve; });
                }
              }
              return new Response(JSON.stringify({ values }));
            };
            createRoot(document.getElementById('root')).render(createElement(TelemetryConsentCard, {
              embedded, request, onContinue: () => { throw new Error('Workspace fixture stays here.'); },
            }));
          };
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: 'browser',
      jsx: 'automatic',
      alias: { '@': path.resolve('src') },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
  });

  afterAll(async () => { await browser?.close(); });

  it('waits for the pending opt-out write before measuring enabled light-mode controls', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<style>button { transition: none !important; }</style><div id="root"></div>');
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        (window as unknown as { mount: (...args: unknown[]) => void }).mount('light', false, undefined, true);
      });
      await page.getByRole('button', { name: 'Keep crash reports off', exact: true }).click();
      await page.getByRole('button', { name: 'Turn off', exact: true }).click();
      expect(await page.locator('footer button').isDisabled()).toBe(true);
      const measuring = measureConsentControls(page);
      await page.waitForFunction(() => (window as unknown as { consentMeasurementCount: number }).consentMeasurementCount > 0);
      await page.evaluate(() => (window as unknown as { finishUsageSave: () => void }).finishUsageSave());
      const metrics = await measuring;
      expect(metrics).toHaveLength(2);
      expect(metrics.every((metric) => !metric.disabled)).toBe(true);
      for (const metric of metrics) {
        expect(metric.declaredColor).toBe('var(--t-chat-surface-bg)');
        expect(contrast(metric.color, metric.background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(await page.getByRole('alert').count()).toBe(0);
    } finally { await page.close(); }
  });

  for (const palette of ['dark', 'light']) {
    it(`${palette} standalone consent retains its surface foreground`, async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<style>button { transition: none !important; }</style><div id="root"></div>');
        await page.addScriptTag({ content: bundle });
        await page.evaluate((palette) => {
          (window as unknown as { mount: (...args: unknown[]) => void }).mount(palette, false);
        }, palette);
        await page.getByRole('button', { name: 'Keep crash reports off', exact: true }).click();
        await page.getByRole('button', { name: 'Turn off', exact: true }).click();
        const metrics = await measureConsentControls(page);
        expect(await page.getByRole('alert').count()).toBe(0);
        for (const metric of metrics) {
          expect(metric.declaredColor).toBe('var(--t-chat-surface-bg)');
          expect(contrast(metric.color, metric.background)).toBeGreaterThanOrEqual(4.5);
        }
      } finally { await page.close(); }
    });
  }

  for (const palette of ['dark', 'light']) {
    for (const workspaceSurface of ['#ffffff', 'transparent']) {
      it(`${palette} embedded labels remain readable with ${workspaceSurface} workspace glass`, async () => {
        const page = await browser.newPage();
        try {
          await page.setContent('<style>button { transition: none !important; }</style><div id="root"></div>');
          await page.addScriptTag({ content: bundle });
          await page.evaluate(({ palette, workspaceSurface }) => {
            (window as unknown as { mount: (...args: unknown[]) => void }).mount(palette, true, workspaceSurface);
          }, { palette, workspaceSurface });
          const save = page.getByRole('button', { name: 'Save privacy choices', exact: true });
          await expect.poll(() => save.isDisabled()).toBe(true);
          await page.getByRole('button', { name: 'Keep crash reports off', exact: true }).click();
          await expect.poll(() => save.isEnabled()).toBe(true);
          await page.getByRole('button', { name: 'Turn off', exact: true }).click();
          await expect.poll(() => save.isEnabled()).toBe(true);
          const measure = () => measureConsentControls(page);
          for (const metric of await measure()) {
            expect(contrast(metric.color, metric.background), JSON.stringify(metric)).toBeGreaterThanOrEqual(4.5);
          }
          await save.click();
          await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
          for (const metric of await measure()) {
            expect(contrast(metric.color, metric.background), JSON.stringify(metric)).toBeGreaterThanOrEqual(4.5);
          }
          expect(await page.evaluate(() => (window as unknown as { posts: unknown[] }).posts)).toEqual([
            { productTelemetryEnabled: false },
            { crashReportsEnabled: false, productTelemetryEnabled: false, telemetryConsentAnswered: true },
          ]);
        } finally { await page.close(); }
      });
    }
  }
});
