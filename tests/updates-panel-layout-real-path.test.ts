// Measure the production Updates panel as deferred discovery publishes rows.
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
import { getPalette, resolveTheme } from '../src/lib/theme/registry';

const executablePath = resolveBrowserPath();
const hubFixture = `
import { useSyncExternalStore } from 'react';
let state = { app: { currentVersion: '0.1.0' }, tools: [], checking: false,
  checkingAll: false, cliBusy: null, cliProgress: {}, syncing: false,
  cliError: null, cliMessage: null, checkMessage: null, cliDiscovery: null, cliDiscoveryChecked: [], checkedAt: 0 };
const listeners = new Set();
window.publishTools = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
export const useUpdateHub = () => useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
export const refreshCliUpdateView = async () => window.publishTools({ checking: true,
  cliError: null, cliMessage: null, cliDiscovery: null, cliDiscoveryChecked: [], checkedAt: 0 });
export const checkAppUpdates = async () => ({ hasUpdates: false });
export const synchronizeConnectedClis = async () => {};
export const loadCachedReleaseNotes = async () => ({ source: 'changelog', summary: 'Published changes',
  overview: window.fullNotes ? 'The latest published release includes these changes.' : '',
  entries: window.fullNotes ? Array.from({length: 8}, (_, i) => ({text: 'Published change ' + i + ': improvements to workspace navigation, saved state and update feedback.'})) : [],
});
`;
const fixture = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RailUpdateControl } from '@/components/desktop/shell/RailUpdateControl';
createRoot(document.querySelector('main')).render(createElement(RailUpdateControl, {
  buttonStyle: { position: 'fixed', left: 12, bottom: 16, width: 32, height: 32 }
}));
`;

describe.skipIf(!executablePath)('Updates panel discovery layout in a real browser', () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;
  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'jsx' },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: { '@': path.resolve('src') },
      plugins: [{ name: 'deferred-update-state', setup(build) {
        build.onResolve({ filter: /update-hub-client$/ }, () => ({ path: 'hub', namespace: 'fixture' }));
        build.onResolve({ filter: /ConfirmToastHost$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
        build.onResolve({ filter: /theme\/context$/ }, () => ({ path: 'theme', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
          contents: name === 'hub' ? hubFixture : name === 'theme'
            ? 'export const useTheme = () => ({ workspaceGlass: false, surface: "solid", paletteId: "dark" });'
            : 'export const toast = () => {};',
          resolveDir: process.cwd(),
        }));
      } }],
      logLevel: 'silent',
    });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    page = await browser.newPage({ reducedMotion: 'reduce' });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[900, 700], [1440, 900], [1680, 1050]]) {
      for (const firstStatus of ['current', 'update-available'] as const) {
        it(`keeps the same first row fixed when ${firstStatus} arrives first at ${width}x${height} in ${theme}`, async () => {
          await page.setViewportSize({ width, height });
          await page.setContent(`<style>${fs.readFileSync('src/app/globals.css', 'utf8')}</style><main></main>`);
          await page.evaluate(tokens => {
            for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value);
            Object.assign(window, { fullNotes: true });
          }, resolveTheme(getPalette(theme), 'solid').cssVars);
          await page.addScriptTag({ content: bundle });
          await page.getByRole('button', { name: 'Updates', exact: true }).press('ArrowUp');
          const panel = page.getByRole('dialog', { name: 'Updates and release notes' });
          await panel.getByText('Latest published changes', { exact: true }).waitFor();
          const tools = page.getByRole('button', { name: 'Tools updates', exact: true });
          await tools.click();
          await page.getByRole('progressbar', { name: 'Tool discovery' }).waitFor();
          const publish = async (count: number, checking: boolean) => page.evaluate(({ count, checking, firstStatus }) => {
            const tools = Array.from({ length: count }, (_, i) => ({ runtimeId: 'tool-' + i,
              label: 'Installed tool ' + i, installedVersion: '1.0.0', latestVersion: '1.1.0',
              status: i === 0 ? firstStatus : i % 2 ? 'unknown' : firstStatus === 'current' ? 'update-available' : 'current' }));
            (window as unknown as { publishTools: (patch: unknown) => void }).publishTools({ tools, checking,
              cliDiscoveryChecked: checking ? tools.map(tool => tool.runtimeId) : [], checkedAt: checking ? 0 : Date.now() });
          }, { count, checking, firstStatus });
          await publish(1, true);
          const first = panel.locator('[data-cli-update-row="tool-0"]');
          await first.waitFor();
          const initial = await first.boundingBox();
          let previousPositions = [{ id: 'tool-0', y: initial!.y }];
          for (const [count, checking] of [[3, true], [10, true], [10, false]] as const) {
            await publish(count, checking);
            await panel.locator('[data-cli-update-row]').nth(count - 1).waitFor();
            if (!checking) await page.getByRole('progressbar', { name: 'Tool discovery' }).waitFor({ state: 'detached' });
            expect((await first.boundingBox())?.y, 'the original row moves as mixed results arrive').toBe(initial?.y);
            const positions = await panel.locator('[data-cli-update-row]').evaluateAll(rows => rows.map(row => ({
              id: row.getAttribute('data-cli-update-row')!, y: row.getBoundingClientRect().y,
            })));
            for (const previous of previousPositions) {
              expect(positions.find(row => row.id === previous.id)?.y, `${previous.id} moves as mixed results arrive`).toBe(previous.y);
            }
            previousPositions = positions;
            expect(await panel.locator('[data-cli-update-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-cli-update-row'))))
              .toEqual(Array.from({ length: count }, (_, i) => 'tool-' + i));
          }
          const geometry = () => panel.locator('[data-cli-update-row]').evaluateAll(rows => rows.map(row => {
            const { y, height } = row.getBoundingClientRect();
            return { id: row.getAttribute('data-cli-update-row')!, y, height };
          }));
          const loadedRows = await geometry();
          await tools.click();
          await tools.click();
          const progress = page.getByRole('progressbar', { name: 'Tool discovery' });
          await progress.waitFor();
          expect(await panel.locator('[data-cli-update-row][aria-busy="true"]').count()).toBe(10);
          expect(await geometry(), 'every retained row keeps its y and height on reopen').toEqual(loadedRows);
          // Each streamed result clears checking for that row while the other rows remain pending.
          for (let completed = 1; completed <= loadedRows.length; completed++) {
            await page.evaluate(completed => {
              (window as unknown as { publishTools: (patch: unknown) => void }).publishTools({
                cliDiscoveryChecked: Array.from({ length: completed }, (_, i) => 'tool-' + i),
                cliDiscovery: { completed, total: 10 },
              });
            }, completed);
            await page.waitForFunction(completed => document.querySelectorAll('[data-cli-update-row][aria-busy="true"]').length === 10 - completed, completed);
            expect(await geometry(), `every retained row keeps its geometry after result ${completed}`).toEqual(loadedRows);
          }
          await publish(10, false);
          await progress.waitFor({ state: 'detached' });
          expect(await geometry(), 'every retained row keeps its geometry after recheck completion').toEqual(loadedRows);
        });
      }
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[900, 700], [1440, 900], [1680, 1050]]) {
      for (const fullNotes of [false, true]) {
        it(`keeps visible content fixed with ${fullNotes ? 'full' : 'short'} notes at ${width}x${height} in ${theme}`, async () => {
          await page.setViewportSize({ width, height });
          await page.setContent(`<style>${fs.readFileSync('src/app/globals.css', 'utf8')}</style><main></main>`);
          await page.evaluate(({ tokens, fullNotes }) => {
            for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value);
            Object.assign(window, { fullNotes });
          }, { tokens: resolveTheme(getPalette(theme), 'solid').cssVars, fullNotes });
          await page.addScriptTag({ content: bundle });
          const updates = page.getByRole('button', { name: 'Updates', exact: true });
          await updates.focus();
          await updates.press('ArrowUp');
          const panel = page.getByRole('dialog', { name: 'Updates and release notes' });
          await panel.getByText('Latest published changes', { exact: true }).waitFor();
          const tools = page.getByRole('button', { name: 'Tools updates', exact: true });
          const notes = panel.locator('section').nth(1);
          const before = await tools.boundingBox();
          const notesBefore = await notes.boundingBox();
          await tools.click();
          const progress = page.getByRole('progressbar', { name: 'Tool discovery' });
          await progress.waitFor();
          const checking = await tools.boundingBox();
          const notesChecking = await notes.boundingBox();
          const progressVisible = await progress.evaluate(node => {
            const box = node.getBoundingClientRect();
            const panel = node.closest('[role="dialog"]')!.getBoundingClientRect();
            return box.top >= panel.top && box.bottom <= panel.bottom;
          });
          // Publish partial rows before completion, as the real stream does.
          const publish = async (count: number, checking: boolean) => page.evaluate(({ count, checking }) => {
            (window as unknown as { publishTools: (patch: unknown) => void }).publishTools({ checking,
              checkedAt: checking ? 0 : Date.now(),
              cliDiscoveryChecked: checking ? Array.from({ length: count }, (_, i) => 'tool-' + i) : [],
              tools: Array.from({ length: count }, (_, i) => ({ runtimeId: 'tool-' + i,
                label: 'Installed tool ' + i, status: 'unknown', installedVersion: '1.0.0' })),
            });
          }, { count, checking });
          await publish(3, true);
          await panel.locator('[data-cli-update-row]').nth(2).waitFor();
          const partial = await tools.boundingBox();
          const notesPartial = await notes.boundingBox();
          const firstRow = panel.locator('[data-cli-update-row]').first();
          const firstPartial = await firstRow.boundingBox();
          await publish(10, false);
          await panel.locator('[data-cli-update-row]').nth(9).waitFor();
          const loaded = await tools.boundingBox();
          const notesLoaded = await notes.boundingBox();
          const firstLoaded = await firstRow.boundingBox();
          const firstRowsVisible = await panel.locator('[data-cli-update-row]').evaluateAll(rows => rows.slice(0, 2).every(node => {
            const box = node.getBoundingClientRect();
            const panel = node.closest('[role="dialog"]')!.getBoundingClientRect();
            const tools = node.closest('section')!.getBoundingClientRect();
            return box.top >= panel.top && box.bottom <= Math.min(panel.bottom, tools.bottom);
          }));
          console.info('[updates-panel-layout]', JSON.stringify({ theme, width, height, fullNotes,
            y: [before?.y, checking?.y, partial?.y, loaded?.y], progressVisible, firstRowsVisible }));
          expect(notesLoaded?.y, 'notes move when discovery rows arrive').toBe(notesChecking?.y);
          expect(notesChecking?.y, 'notes move when Tools opens').toBe(notesBefore?.y);
          expect(notesPartial?.y, 'notes move when partial rows arrive').toBe(notesBefore?.y);
          expect(notesLoaded?.y, 'notes move when discovery completes').toBe(notesBefore?.y);
          expect(firstLoaded?.y, 'first row moves as more rows arrive').toBe(firstPartial?.y);
          expect(loaded?.y, 'Tools header moves when discovery rows arrive').toBe(checking?.y);
          expect(checking).toEqual(before);
          expect(partial).toEqual(before);
          expect(loaded).toEqual(before);
          expect(progressVisible, 'checking must be visible without scrolling').toBe(true);
          expect(firstRowsVisible, 'first rows must be visible without scrolling').toBe(true);
          await tools.click();
          expect((await notes.boundingBox())?.y, 'notes move when Tools closes').toBe(notesBefore?.y);
          await tools.click();
          await progress.waitFor();
          expect((await notes.boundingBox())?.y, 'notes move on recheck').toBe(notesBefore?.y);
          expect((await firstRow.boundingBox())?.y, 'first row moves on recheck').toBe(firstLoaded?.y);
          await publish(10, false);
          await progress.waitFor({ state: 'detached' });
          expect((await notes.boundingBox())?.y, 'notes move after recheck').toBe(notesBefore?.y);
          // The last result and release history must remain reachable by keyboard.
          await panel.locator('[data-cli-update-row]').last().getByRole('button').focus();
          await page.getByRole('button', { name: 'View release on GitHub' }).focus();
          expect(await page.getByRole('button', { name: 'View release on GitHub' }).evaluate(node => {
            const box = node.getBoundingClientRect();
            const panel = node.closest('[role="dialog"]')!.getBoundingClientRect();
            return box.top >= panel.top && box.bottom <= panel.bottom;
          })).toBe(true);
        });
      }
    }
  }
});
