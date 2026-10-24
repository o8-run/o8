import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
import { getPalette, resolveTheme } from '../src/lib/theme/registry';

const proofDir = process.env.O8_NAVIGATION_PROOF_DIR;
const proofState = process.env.O8_NAVIGATION_PROOF_STATE ?? 'after';
const sourceRoot = path.resolve(process.env.O8_NAVIGATION_SOURCE_ROOT ?? '.');
const executablePath = resolveBrowserPath();
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

describe.skipIf(!executablePath)('navigation density through the rendered shell', () => {
  let browser: Browser;
  let bundle: string;
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
    browser = await chromium.launch({ executablePath: executablePath!, headless: true,
      ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar'] });
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
        await page.keyboard.press('Tab');
        await page.getByRole('button', { name: 'Home', exact: true }).focus();
        const railButtons = page.locator('[data-rail-action]');
        for (let index = 1; index < await railButtons.count(); index++) await page.keyboard.press('Tab');
        expect(await railButtons.last().evaluate(node => node === document.activeElement)).toBe(true);
        await page.evaluate(() => (window as unknown as { setChatsVisible(value: boolean): void }).setChatsVisible(true));
        await page.locator('#o8-chat-list').waitFor();
        const first = page.locator(rows).first(); const last = page.locator(rows).last();
        await first.focus();
        await first.press('Enter');
        expect(await page.evaluate(() => (window as unknown as { selectedChat: string }).selectedChat)).toBe('fixture-chat-0');
        for (let index = 1; index < 72; index++) await page.keyboard.press('Tab');
        expect(await last.evaluate(node => node === document.activeElement)).toBe(true);
        await last.press('Enter');
        expect(await page.evaluate(() => (window as unknown as { selectedChat: string }).selectedChat)).toBe('fixture-chat-71');
        const focused = await last.evaluate(node => {
          const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
          return { outline: style.outlineStyle, width: style.outlineWidth, top: rect.top, bottom: rect.bottom };
        });
        expect(focused.outline).toBe('solid'); expect(focused.width).toBe('2px');
        expect(focused.top).toBeGreaterThanOrEqual(0); expect(focused.bottom).toBeLessThanOrEqual(size.height);
        for (let index = 1; index < 72; index++) await page.keyboard.press('Shift+Tab');
        expect(await first.evaluate(node => node === document.activeElement)).toBe(true);
        const box = (await page.locator(scroll).boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 20_000);
        await expect.poll(() => page.locator(scroll).evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 1)).toBe(true);
        await page.mouse.wheel(0, -20_000);
        await expect.poll(() => page.locator(scroll).evaluate(node => node.scrollTop)).toBe(0);
        const cdp = await page.context().newCDPSession(page);
        for (const yDistance of [-20_000, 20_000]) {
          for (let swipe = 0; swipe < 20; swipe++) {
            const start = yDistance < 0 ? box.y + box.height - 80 : box.y + 80;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: start }] });
            for (let step = 1; step <= 8; step++) {
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width / 2,
                y: start + (yDistance < 0 ? -1 : 1) * step * (box.height - 160) / 8 }] });
              await settle(page);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            if (await page.locator(scroll).evaluate((node, down) => down
              ? node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : node.scrollTop === 0, yDistance < 0)) break;
          }
          console.info('[navigation-touch]', yDistance, await page.locator(scroll).evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight })));
          await expect.poll(() => page.locator(scroll).evaluate((node, down) => down
            ? node.scrollTop + node.clientHeight >= node.scrollHeight - 1 : node.scrollTop === 0, yDistance < 0)).toBe(true);
        }
        await cdp.detach();
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
