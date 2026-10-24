import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
import { getPalette, resolveTheme } from '../src/lib/theme/registry';
import { navigationTouchInput, panNavigation, swipeNavigation } from './fixtures/navigation-touch';

const proofDir = process.env.O8_NAVIGATION_PROOF_DIR;
const proofState = process.env.O8_NAVIGATION_PROOF_STATE ?? 'after';
const sourceRoot = path.resolve(process.env.O8_NAVIGATION_SOURCE_ROOT ?? '.');
const executablePath = resolveBrowserPath();
const useWebKit = process.env.O8_NAVIGATION_BROWSER === 'webkit';
// macOS WebKit uses Option-Tab to include buttons without changing OS settings.
const tab = useWebKit && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
const backTab = useWebKit && process.platform === 'darwin' ? 'Alt+Shift+Tab' : 'Shift+Tab';
const sizes = [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }];
const rows = '[data-o8-agent-panel] [role="button"][aria-label]';
const scroll = '[data-o8-agent-panel] .hide-scrollbar';
// Only host/data boundaries are replaced. AgentPanel, ChatsTab, history rows,
// column, rail, theme tokens and global CSS all come from the production tree.
const stubs: Record<string, string> = {
  'components/auth/O8AuthProvider.tsx': 'export const useO8Auth = () => ({ signedIn: false });',
  'components/desktop/agent-panel/index.ts': `
    export const useAgentPanelState = () => ({ agents: [], inventoryLoading: false,
      gatewayReachable: true, gatewayWarming: false, fleetMeta: null,
      titlebarSpacerHeight: 0, repoRegistryState: {}, workspacesSummary: [] });
    export const THEME_ACCENT = 'var(--t-accent)';
    export const SidebarSection = () => null;
    export const AgentPanelEmptyState = () => null;
  `,
  'components/desktop/repo-registry/useProjects.ts': `
    export const useProjects = () => ({ loading: false, error: null,
      activeProject: null, ledger: { projects: [] } });
    export const refreshProjectsFromExternalMutation = () => {};
    export const broadcastProjectsUpdated = () => {};
  `,
  'components/desktop/repo-focus/useLeftPanelProjectFocus.ts': 'export const useLeftPanelProjectFocus = () => ({ active: false });',
  'components/desktop/AgentPanelExtraAgents.tsx': `export const AgentPanelExtraAgents = ({ renderContent }) => renderContent([], []);`,
  ...Object.fromEntries(['ConnectionPill', 'FixedReportCard', 'UpdateCard'].map(name => [
    `components/desktop/${name}.tsx`, `export const ${name} = () => null;`,
  ])),
};

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
}

async function measure(page: Page) {
  return page.evaluate(({ rows, scroll }) => {
    const scroller = document.querySelector<HTMLElement>(scroll)!;
    const viewport = scroller.getBoundingClientRect();
    const entries = [...document.querySelectorAll<HTMLElement>(rows)];
    const visible = entries.filter(row => {
      const rect = row.getBoundingClientRect();
      // Exclude the panel's 4px/32px scroll fades as well as partial rows.
      return rect.height > 0 && rect.top >= viewport.top + 4 && rect.bottom <= viewport.bottom - 32;
    });
    const nav = document.querySelector('[aria-label="Workspace navigation"]')!;
    const button = nav.querySelector('[aria-label="Run orchestrator"]')!;
    return {
      visibleChats: visible.length, renderedChats: entries.length,
      rowHeight: entries[0].getBoundingClientRect().height,
      titleSize: getComputedStyle(entries[0].querySelector('span span span')!).fontSize,
      railTarget: button.getBoundingClientRect().height,
      railIcon: button.querySelector('svg')!.getBoundingClientRect().height,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth
        || [...document.querySelectorAll<HTMLElement>('[data-o8-chat-list], [data-o8-chat-list] *, [aria-label="Workspace navigation"], [aria-label="Workspace navigation"] *')]
          .some(node => /auto|scroll/.test(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth),
      scrollbars: [...document.querySelectorAll<HTMLElement>('[data-o8-chat-list], [data-o8-chat-list] *, [aria-label="Workspace navigation"], [aria-label="Workspace navigation"] *')]
        .filter(node => /auto|scroll/.test(getComputedStyle(node).overflowY)).map(node => ({
          width: getComputedStyle(node).scrollbarWidth,
          gutter: getComputedStyle(node).scrollbarGutter,
          reserved: node.offsetWidth - node.clientWidth,
          webkitDisplay: getComputedStyle(node, '::-webkit-scrollbar').display,
        })),
    };
  }, { rows, scroll });
}

describe.skipIf(!useWebKit && !executablePath)('navigation density through the rendered shell', () => {
  let browser: Browser;
  let bundle: string;
  let controlScrollTop: number;
  beforeAll(async () => {
    const result = await build({
      entryPoints: ['tests/fixtures/navigation-density.tsx'], bundle: true, write: false,
      format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' }, alias: { '@': path.join(sourceRoot, 'src') },
      plugins: [{ name: 'fixture-services', setup(plugin) {
        plugin.onLoad({ filter: /\.[jt]sx?$/ }, args => {
          const source = stubs[path.relative(path.join(sourceRoot, 'src'), args.path)];
          return source === undefined ? undefined : { contents: source, loader: 'jsx' };
        });
      } }], legalComments: 'none', logLevel: 'silent',
    });
    bundle = result.outputFiles[0].text;
    browser = useWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: executablePath!, headless: true,
      ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar'] });
    // Keep a CSS-free control: desktop touch-event emulation can deliver
    // trusted TouchEvents without providing the platform's pan recognizer.
    const control = await browser.newPage({ viewport: sizes[0], hasTouch: true });
    try {
      await control.setContent('<div id="control" style="height:680px;width:320px;overflow:auto"><div style="height:5000px">Touch pan control</div></div>');
      const input = await navigationTouchInput(control, useWebKit);
      const box = (await control.locator('#control').boundingBox())!;
      await swipeNavigation(control, input, box, true, useWebKit);
      await settle(control);
      controlScrollTop = await control.locator('#control').evaluate(node => node.scrollTop);
      console.info('[navigation-touch-control]', JSON.stringify({ browser: useWebKit ? 'webkit' : 'chromium', top: controlScrollTop }));
      // Calibrate the declared engine, never infer a fallback from a failed
      // panel assertion. macOS WebKit's raw touch protocol has no pan recognizer.
      if (useWebKit) expect(controlScrollTop).toBe(0);
      else expect(controlScrollTop).toBeGreaterThan(0);
      await control.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await control.mouse.wheel(0, -20_000);
      await control.waitForFunction(() => document.querySelector('#control')!.scrollTop === 0);
      for (const down of [true, false]) {
        for (let stroke = 0; stroke < 12; stroke++) {
          await panNavigation(control, box, down);
          if (await control.locator('#control').evaluate((node, direction) => direction
            ? node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : node.scrollTop === 0, down)) break;
        }
        const result = await control.locator('#control').evaluate(node => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
        console.info('[navigation-trackpad-control]', JSON.stringify({ down, ...result }));
        expect(result.top).toBe(down ? result.max : 0);
      }
      await input.detach?.();
    } finally { await control.close(); }
    if (proofDir) fs.mkdirSync(proofDir, { recursive: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  for (const size of sizes) for (const theme of ['light', 'dark'] as const) {
    it(`keeps scrolling, focus and fit at ${size.width}x${size.height} in ${theme}`, async () => {
      const page = await browser.newPage({ viewport: size, hasTouch: true });
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on('pageerror', error => { errors.push(error.message); console.error('[navigation-fixture]', error.message); });
      const stamp = new Date(); stamp.setHours(12, 0, 0, 0);
      const conversations = Array.from({ length: 72 }, (_, index) => ({
        tabId: `fixture-chat-${index}`, title: `Chat ${String(index + 1).padStart(2, '0')} · Review navigation`,
        modifiedAt: new Date(stamp.getTime() - index * 60_000).toISOString(), savedAt: stamp.toISOString(),
        pinned: false, starred: false, empty: false, messageCount: 3,
        preview: 'Check saved workspace context and keyboard navigation.',
      }));
      try {
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.hostname === 'navigation.fixture' && url.pathname === '/') return route.fulfill({
            contentType: 'text/html', body: `<!doctype html><html><head><style>${fs.readFileSync(path.join(sourceRoot, 'src/app/globals.css'), 'utf8')}</style></head><body><div id="root"></div></body></html>`,
          });
          if (url.pathname === '/api/v2/chat-history/list') return route.fulfill({ json: { conversations } });
          if (url.pathname === '/api/lanes') return route.fulfill({ json: { lanes: [] } });
          if (url.pathname === '/api/runtime/capacity') return route.fulfill({ json: { capacities: [], identities: [] } });
          if (url.pathname === '/api/setup/cli-updates') return route.fulfill({ json: { tools: [] } });
          if (url.pathname === '/api/panel/o8-update-summary') return route.fulfill({ json: { entries: [], summary: 'Fixture notes', source: 'release' } });
          if (url.pathname.startsWith('/logos/')) return route.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join('public', url.pathname)) });
          return route.fulfill({ json: {} });
        });
        await page.addInitScript(() => localStorage.setItem('o8:chat-group-by', 'flat'));
        await page.goto('http://navigation.fixture/');
        await page.evaluate(vars => {
          for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
        }, resolveTheme(getPalette(theme), 'solid').cssVars);
        await page.addScriptTag({ content: bundle });
        await page.locator(rows).first().waitFor();
        await page.getByRole('button', { name: 'Show 60 more', exact: true }).click();
        await expect.poll(() => page.locator(rows).count()).toBe(72);
        // Force classic always-present scrollbars on every real scroller.
        await page.locator(scroll).evaluate(node => { (node as HTMLElement).style.overflowY = 'scroll'; node.scrollTop = 0; });
        await page.mouse.move(size.width - 24, 24);
        await expect.poll(() => page.locator('[data-orchestrator-hover]').count()).toBe(0);
        await settle(page);
        const expanded = await measure(page);
        if (proofDir && theme === 'light') await page.screenshot({ path: path.join(proofDir, `${size.width}x${size.height}-expanded-${proofState}.png`) });
        await page.evaluate(() => (window as unknown as { setChatsVisible(value: boolean): void }).setChatsVisible(false));
        await expect.poll(() => page.locator('#o8-chat-list').isVisible()).toBe(false);
        const collapsed = await measure(page);
        if (proofDir && theme === 'light') await page.screenshot({ path: path.join(proofDir, `${size.width}x${size.height}-collapsed-${proofState}.png`) });
        console.info('[navigation-density]', JSON.stringify({ size, theme, expanded, collapsed }));
        // Collapsed main currently hides all chats; retain this honest measurement.
        expect(collapsed.visibleChats).toBe(0);
        expect(collapsed.horizontalOverflow).toBe(false);
        await page.keyboard.press(tab);
        await page.getByRole('button', { name: 'Home', exact: true }).focus();
        const railButtons = page.locator('[data-rail-action]');
        for (let index = 1; index < await railButtons.count(); index++) await page.keyboard.press(tab);
        expect(await railButtons.last().evaluate(node => node === document.activeElement)).toBe(true);
        await page.evaluate(() => (window as unknown as { setChatsVisible(value: boolean): void }).setChatsVisible(true));
        await page.locator('#o8-chat-list').waitFor();
        const first = page.locator(rows).first(); const last = page.locator(rows).last();
        await first.focus();
        await first.press('Enter');
        expect(await page.evaluate(() => (window as unknown as { selectedChat: string }).selectedChat)).toBe('fixture-chat-0');
        for (let index = 1; index < 72; index++) await page.keyboard.press(tab);
        expect(await last.evaluate(node => node === document.activeElement)).toBe(true);
        await last.press('Enter');
        expect(await page.evaluate(() => (window as unknown as { selectedChat: string }).selectedChat)).toBe('fixture-chat-71');
        const focused = await last.evaluate(node => {
          const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
          return { outline: style.outlineStyle, width: style.outlineWidth, top: rect.top, bottom: rect.bottom };
        });
        expect(focused.outline).toBe('solid'); expect(focused.width).toBe('2px');
        expect(focused.top).toBeGreaterThanOrEqual(0); expect(focused.bottom).toBeLessThanOrEqual(size.height);
        for (let index = 1; index < 72; index++) await page.keyboard.press(backTab);
        expect(await first.evaluate(node => node === document.activeElement)).toBe(true);
        const box = (await page.locator(scroll).boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 20_000);
        await expect.poll(() => page.locator(scroll).evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 1)).toBe(true);
        await page.mouse.wheel(0, -20_000);
        await expect.poll(() => page.locator(scroll).evaluate(node => node.scrollTop)).toBe(0);
        await page.evaluate(() => {
          const state = { dragStarts: 0, preventedMoves: 0 };
          Object.assign(window, { touchNavigationState: state });
          window.addEventListener('o8:thread-drag:start', () => state.dragStarts++);
          window.addEventListener('pointermove', event => {
            if (event.pointerType === 'touch' && event.defaultPrevented) state.preventedMoves++;
          });
          const trace = { starts: 0, moves: 0, prevented: 0, target: [] as object[], owners: [] as string[] };
          Object.assign(window, { touchNavigationTrace: trace });
          document.addEventListener('touchstart', event => {
            if (event.isTrusted) trace.starts++;
            if (trace.target.length) return;
            trace.target = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement)
              .map(node => ({ tag: node.tagName, scroller: node.classList.contains('hide-scrollbar'),
                overflow: getComputedStyle(node).overflow, touch: getComputedStyle(node).touchAction,
                overscroll: getComputedStyle(node).overscrollBehavior,
                height: node.clientHeight, content: node.scrollHeight }));
          }, { passive: true });
          window.addEventListener('touchmove', event => {
            if (event.isTrusted) trace.moves++;
            if (event.defaultPrevented) trace.prevented++;
          }, { passive: true });
          document.addEventListener('scroll', event => {
            const node = event.target;
            if (!(node instanceof HTMLElement)) return;
            const owner = node.classList.contains('hide-scrollbar') ? 'agent-panel' : node.tagName;
            if (!trace.owners.includes(owner)) trace.owners.push(owner);
          }, { capture: true, passive: true });
        });
        const input = await navigationTouchInput(page, useWebKit);
        for (const yDistance of [-20_000, 20_000]) {
          // WebKit still checks trusted touch delivery and drag interference.
          // Touchscreen pan endpoints remain covered by Chromium; WebKit's
          // desktop scroll endpoints use the trackpad stream below.
          for (let swipe = 0; swipe < (useWebKit ? 1 : 20); swipe++) {
            await swipeNavigation(page, input, box, yDistance < 0, useWebKit);
            await settle(page);
            if (await page.locator(scroll).evaluate((node, down) => down
              ? node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : node.scrollTop === 0, yDistance < 0)) break;
          }
          console.info('[navigation-touch]', yDistance, await page.locator(scroll).evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight })));
          const touchState = await page.evaluate(() => (window as unknown as {
            touchNavigationState: { dragStarts: number; preventedMoves: number };
          }).touchNavigationState);
          console.info('[navigation-touch-ownership]', touchState);
          const trace = await page.evaluate(() => (window as unknown as {
            touchNavigationTrace: { starts: number; moves: number; prevented: number; target: object[]; owners: string[] };
          }).touchNavigationTrace);
          console.info('[navigation-touch-trace]', JSON.stringify({ browser: useWebKit ? 'webkit' : 'chromium', ...trace }));
          expect(trace.starts, 'gesture must deliver trusted touch input').toBeGreaterThan(0);
          expect(trace.moves).toBeGreaterThan(0);
          expect(trace.prevented).toBe(0);
          expect(trace.target).toEqual(expect.arrayContaining([expect.objectContaining({ scroller: true })]));
          expect(touchState, 'touch panning must not activate pane dragging or cancel pointer moves')
            .toEqual({ dragStarts: 0, preventedMoves: 0 });
          if (!useWebKit) {
            await expect.poll(() => page.locator(scroll).evaluate((node, down) => down
              ? node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : node.scrollTop === 0, yDistance < 0)).toBe(true);
            expect(trace.owners, `native pan control scrollTop=${controlScrollTop}; touched panel must own scrolling`)
              .toEqual(['agent-panel']);
          }
        }
        await input.detach?.();
        await page.evaluate(() => {
          const state = { events: 0, prevented: 0, nonPixel: 0 };
          const target = window as unknown as { touchNavigationTrace: { owners: string[] } };
          target.touchNavigationTrace.owners = [];
          Object.assign(window, { trackpadNavigationState: state });
          window.addEventListener('wheel', event => {
            if (!event.isTrusted) return;
            state.events++;
            if (event.defaultPrevented) state.prevented++;
            if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) state.nonPixel++;
          }, { passive: true });
        });
        for (const down of [true, false]) {
          for (let stroke = 0; stroke < 16; stroke++) {
            await panNavigation(page, box, down);
            if (await page.locator(scroll).evaluate((node, direction) => direction
              ? node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : node.scrollTop === 0, down)) break;
          }
          await expect.poll(() => page.locator(scroll).evaluate((node, direction) => direction
            ? node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : node.scrollTop === 0, down)).toBe(true);
          const result = await page.locator(scroll).evaluate(node => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
          const state = await page.evaluate(() => {
            const target = window as unknown as {
              trackpadNavigationState: { events: number; prevented: number; nonPixel: number };
              touchNavigationTrace: { owners: string[] };
            };
            return { input: target.trackpadNavigationState, owners: target.touchNavigationTrace.owners };
          });
          console.info('[navigation-trackpad]', JSON.stringify({ size, theme, down, ...result,
            ...state }));
          expect(state.input.events).toBeGreaterThan(0);
          expect(state.input.prevented).toBe(0);
          expect(state.input.nonPixel).toBe(0);
          expect(state.owners).toEqual(['agent-panel']);
        }
        // A cancelled mouse drag must not leave click suppression armed for
        // the next touch tap on the same row on a hybrid laptop.
        await last.press('Enter');
        await first.focus();
        const firstBox = (await first.boundingBox())!;
        await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width + 80, box.y + 160, { steps: 4 });
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await first.tap();
        expect(await page.evaluate(() => (window as unknown as { selectedChat: string }).selectedChat)).toBe('fixture-chat-0');
        // Portal content is outside the rail's DOM subtree. Force its real
        // bounded scroll surface to overflow to exercise always-on OS bars.
        await page.getByRole('button', { name: 'More navigation', exact: true }).click();
        const menuScroll = page.locator('[aria-label="More destinations"] [style*="overflow-y"]');
        await menuScroll.evaluate(node => { (node as HTMLElement).style.maxHeight = '80px'; (node as HTMLElement).style.overflowY = 'scroll'; });
        const menuBars = await menuScroll.evaluate(node => ({ width: getComputedStyle(node).scrollbarWidth,
          reserved: (node as HTMLElement).offsetWidth - node.clientWidth,
          webkitDisplay: getComputedStyle(node, '::-webkit-scrollbar').display }));
        console.info('[navigation-menu-scrollbar]', JSON.stringify(menuBars));
        if (proofDir && theme === 'light' && size.width === 1280) await page.screenshot({ path: path.join(proofDir, `navigation-menu-${proofState}.png`) });
        expect.soft(menuBars.width).toBe('none'); expect.soft(menuBars.reserved).toBe(0);
        expect.soft(menuBars.webkitDisplay).toBe('none');
        await page.keyboard.press('Escape');
        expect(errors).toEqual([]);
        expect(expanded.horizontalOverflow).toBe(false);
        for (const metrics of expanded.scrollbars) {
          expect(metrics.width).toBe('none'); expect(metrics.gutter).toBe('auto');
          expect(metrics.reserved).toBe(0); expect(metrics.webkitDisplay).toBe('none');
        }
        expect(expanded.titleSize).toBe('13.5px');
        const targets = await page.locator('#o8-chat-list :is(button, [role="button"]), [data-rail-action]')
          .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()).filter(rect => rect.height > 0)
            .map(rect => Math.min(rect.width, rect.height)));
        expect(Math.min(...targets)).toBeGreaterThanOrEqual(28);
        expect.soft(expanded.railTarget).toBe(size.height <= 800 ? 32 : 44);
        expect.soft(expanded.railIcon).toBe(size.height <= 800 ? 16 : 19);
        expect.soft(expanded.rowHeight).toBe(size.height <= 800 ? 64 : 78);
        expect.soft(expanded.visibleChats).toBeGreaterThanOrEqual(size.height <= 800 ? 9 : 11);
      } finally { await page.close(); }
    }, 120_000);
  }
});
