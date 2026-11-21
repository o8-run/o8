import { recurring } from '@/lib/background-work/ledger';
import 'server-only';

// TYPE-ONLY import: erased at compile time, so it pulls nothing into the bundle.
//
// The runtime `chromium` value is loaded lazily in `browser()` below. It used to
// be a static import, which dragged all of playwright-core onto the SERVER'S BOOT
// PATH — a browser-automation library, fully required before the app would answer
// its first HTTP request. It cost 126ms of self time in a CPU profile of the
// boot, plus its share of the 491ms the CJS loader spent reading and compiling
// modules off disk.
//
// Nothing here needs a browser until someone actually drives one.
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { SELECTOR_FOR_SOURCE } from '@/lib/browser/selector';
import { GRAB_PAYLOAD_SOURCE, type GrabbedElement } from '@/lib/browser/grab';
import { ENGINE_VIEWPORT } from '@/lib/browser/engine-viewport';
import { assertPublicHttpUrl } from '@/lib/network/safe-url';
import { BROWSER_NETWORK_CONTEXT_OPTIONS, installBrowserNetworkPolicy, installCaptureNetworkPolicy } from '@/lib/browser-engine/network-policy';
import { startBrowserEgressProxy, type BrowserEgressProxy } from '@/lib/browser-engine/egress-proxy';

/**
 * Browser engine (#1232 phase 3) — a REAL browser for agents, driving the
 * user's installed Chrome via playwright-core (`channel: 'chrome'`, headless;
 * no bundled Chromium download). This is the tier above the in-page agent:
 * external URLs the embedded iframes can't show (X-Frame-Options, CSP,
 * cross-origin) land here.
 *
 * One engine per server process (globalThis singleton survives dev HMR);
 * one isolated context+page per scope (packetId or 'operator'), reaped after
 * 10 minutes idle. Verb envelopes mirror the in-page agent so `o8 browser`
 * output reads the same regardless of tier. The canvas browser card renders
 * a live view by polling /api/browser/engine/view.
 */

export interface EngineEnvelope {
  ok: boolean;
  [key: string]: unknown;
}

interface EngineSession {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

const IDLE_REAP_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;
const VIEWPORT = { width: ENGINE_VIEWPORT.width, height: ENGINE_VIEWPORT.height };

interface PageState {
  title: string;
  text: string;
  interactive: Array<{ selector: string; tag: string; label: string }>;
}

/** Page-state collector as an injectable IIFE — evaluated inside the engine's
 *  headless Chrome. Embeds the shared selector source (SELECTOR_FOR_SOURCE) so
 *  the selector vocabulary matches the in-page agent exactly. The cap is baked
 *  into the script because `page.evaluate(string)` ignores the arg form. */
function collectPageStateScript(maxChars: number): string {
  return `(() => {
    ${SELECTOR_FOR_SOURCE}
    const labelFor = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const value = el.placeholder || '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      return (text || value || el.getAttribute('title') || '').slice(0, 80);
    };
    const maxChars = ${maxChars};
    const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n');
    const interactive = [];
    const nodes = document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [onclick]');
    for (const el of nodes) {
      if (interactive.length >= 60) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      interactive.push({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), label: labelFor(el) });
    }
    return {
      title: document.title,
      text: text.length > maxChars ? (text.slice(0, maxChars) + '… [truncated ' + (text.length - maxChars) + ' chars]') : text,
      interactive,
    };
  })()`;
}

/** Design-Mode grab as an injectable IIFE — embeds the shared selector + grab
 *  payload sources so an engine-tier (external-URL) grab matches the in-page
 *  agent's grab exactly. */
function grabScript(selector: string): string {
  return `(() => {
    ${SELECTOR_FOR_SOURCE}
    ${GRAB_PAYLOAD_SOURCE}
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'no element matches ' + ${JSON.stringify(selector)} };
    return { ok: true, element: buildGrabbedElement(el, selectorFor(el)) };
  })()`;
}

class BrowserEngine {
  private browserPromise: Promise<Browser> | null = null;
  private egressProxyPromise: Promise<BrowserEgressProxy> | null = null;
  private sessions = new Map<string, EngineSession>();
  private reaper: ReturnType<typeof setInterval> | null = null;
  /** In-flight one-shot captures — holds the shared browser open so a reap
   *  triggered by one capture can't close it under the next (#1648). */
  private activeCaptures = 0;

  private egressProxy(): Promise<BrowserEgressProxy> {
    if (!this.egressProxyPromise) this.egressProxyPromise = startBrowserEgressProxy();
    return this.egressProxyPromise;
  }

  private async closeEgressProxy(): Promise<void> {
    const promise = this.egressProxyPromise;
    this.egressProxyPromise = null;
    const proxy = await promise?.catch(() => null);
    await proxy?.close().catch(() => undefined);
  }

  private async browser(): Promise<Browser> {
    if (!this.browserPromise) {
      // Lazy — this is the ONLY place the playwright runtime is needed, and it
      // only runs when an agent actually asks for a browser. Keeping it out of
      // the module graph keeps it off the server's boot path.
      //
      // The static import used to be resolved at BUILD time; this one resolves at
      // RUNTIME, so a packaging regression (playwright-core missing from
      // Resources/server/node_modules because Next's file tracing stopped
      // following it) would no longer be a build error — it would be a failure the
      // first time an agent asked for a browser, in production. Name the module in
      // the error so that failure is loud and obvious instead of a mystery hang.
      let chromium: typeof import('playwright-core').chromium;
      try {
        ({ chromium } = await import('playwright-core'));
      } catch (cause) {
        throw new Error(
          '[browser-engine] could not load `playwright-core` at runtime. In a packaged '
          + 'build it must exist at Resources/server/node_modules/playwright-core — if it '
          + "is missing, Next's output file tracing has stopped following the dynamic "
          + 'import in browser-engine/engine.ts. The browser engine is unavailable.',
          { cause },
        );
      }
      await this.egressProxy();
      this.browserPromise = chromium.launch({ channel: 'chrome', headless: true }).then((browser) => {
        browser.on('disconnected', () => {
          this.browserPromise = null;
          this.sessions.clear();
          void this.closeEgressProxy();
        });
        return browser;
      }).catch(async (error) => {
        this.browserPromise = null;
        await this.closeEgressProxy();
        throw error;
      });
    }
    return this.browserPromise;
  }

  private async session(scope: string): Promise<EngineSession> {
    const existing = this.sessions.get(scope);
    if (existing && !existing.page.isClosed()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const browser = await this.browser();
    const proxy = (await this.egressProxy()).contextOptions('public');
    // Service workers can bypass Playwright request routing, so engine contexts
    // disable them rather than leaving a second, unguarded fetch path.
    const context = await browser.newContext({ viewport: VIEWPORT, proxy, ...BROWSER_NETWORK_CONTEXT_OPTIONS });
    await installBrowserNetworkPolicy(context);
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    const session: EngineSession = { context, page, lastUsedAt: Date.now() };
    this.sessions.set(scope, session);
    if (!this.reaper) {
      this.reaper = recurring('browser-engine-reaper', () => void this.reapIdle(), 60_000);
      this.reaper.unref?.();
    }
    return session;
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const [scope, session] of this.sessions) {
      if (now - session.lastUsedAt < IDLE_REAP_MS) continue;
      this.sessions.delete(scope);
      await session.context.close().catch(() => undefined);
    }
    if (this.sessions.size === 0 && this.activeCaptures === 0 && this.browserPromise) {
      const promise = this.browserPromise;
      const browser = await promise.catch(() => null);
      // Re-check after the await: a capture can grab this same browser during
      // the suspension, and closing it then kills the capture mid-flight
      // (#1648 smoke caught exactly this interleaving).
      if (this.sessions.size !== 0 || this.activeCaptures !== 0 || this.browserPromise !== promise) return;
      this.browserPromise = null;
      await browser?.close().catch(() => undefined);
      if (!this.browserPromise && this.sessions.size === 0 && this.activeCaptures === 0) {
        await this.closeEgressProxy();
      }
      if (this.reaper) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
    }
  }

  hasSession(scope: string): boolean {
    const session = this.sessions.get(scope);
    return Boolean(session && !session.page.isClosed());
  }

  /** Cheap label data for the live-view tab — no evaluate round-trip. */
  async meta(scope: string): Promise<{ active: boolean; url?: string; title?: string }> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { active: false };
    return { active: true, url: session.page.url(), title: await session.page.title().catch(() => '') };
  }

  async open(scope: string, url: string): Promise<EngineEnvelope> {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const validated = await assertPublicHttpUrl(target);
    const session = await this.session(scope);
    await session.page.goto(validated.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    return { ok: true, url: session.page.url(), title: await session.page.title().catch(() => ''), surface: 'engine' };
  }

  async read(scope: string, maxChars?: number): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    const cap = Math.min(14_000, Math.max(400, maxChars ?? 6000));
    const state = (await session.page.evaluate(collectPageStateScript(cap))) as PageState;
    return { ok: true, url: session.page.url(), surface: 'engine', ...state };
  }

  async click(scope: string, selector: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    await session.page.click(selector, { timeout: ACTION_TIMEOUT_MS });
    return { ok: true, clicked: selector, surface: 'engine', url: session.page.url() };
  }

  async type(scope: string, selector: string, text: string, submit?: boolean): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    await session.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
    if (submit) await session.page.press(selector, 'Enter', { timeout: ACTION_TIMEOUT_MS });
    return { ok: true, typed: text.length, into: selector, surface: 'engine', url: session.page.url() };
  }

  // ── Coordinate-based interaction (the panel live-view forwards the human's
  //    clicks/keys/scroll here so auth-gated apps the iframe can't embed stay
  //    usable — sign in, navigate — inside the engine's real Chrome). ──

  async clickAt(scope: string, x: number, y: number): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.mouse.click(x, y);
    return { ok: true, clickedAt: { x, y }, surface: 'engine', url: session.page.url() };
  }

  async typeText(scope: string, text: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.keyboard.type(text, { delay: 8 });
    return { ok: true, typed: text.length, surface: 'engine', url: session.page.url() };
  }

  async pressKey(scope: string, key: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.keyboard.press(key);
    return { ok: true, pressed: key, surface: 'engine', url: session.page.url() };
  }

  async scrollBy(scope: string, deltaY: number): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.mouse.wheel(0, deltaY);
    return { ok: true, scrolled: deltaY, surface: 'engine', url: session.page.url() };
  }

  async grab(scope: string, selector: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    const result = (await session.page.evaluate(grabScript(selector))) as { ok: boolean; element?: GrabbedElement; error?: string };
    if (!result.ok) return { ok: false, error: result.error ?? 'grab failed', surface: 'engine', url: session.page.url() };
    if (result.element) {
      const shot = await session.page.locator(selector).first().screenshot({ type: 'png' }).catch(() => null);
      if (shot) result.element.screenshot = `data:image/png;base64,${shot.toString('base64')}`;
    }
    return { ok: true, surface: 'engine', url: session.page.url(), element: result.element };
  }

  async probe(scope: string, selector: string, text?: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    const found = await session.page.evaluate(
      ({ sel, needle }: { sel: string; needle: string | null }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (!needle) return true;
        return ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase().includes(needle.toLowerCase());
      },
      { sel: selector, needle: text ?? null },
    ).catch(() => false);
    return found ? { ok: true, found: selector, surface: 'engine' } : { ok: false, pending: true };
  }

  /**
   * One-shot proof capture for `o8 packet capture` (#1648) — replaces the
   * external dev-browser spawn so a fresh machine needs nothing on PATH
   * beyond Chrome. Runs in its OWN context with the capture egress policy
   * (loopback allowed — the target is the agent's own dev server) and never
   * touches the scoped sessions above. Interaction steps are best-effort by
   * design: a missed hover shouldn't kill the proof shot.
   */
  async capture(opts: {
    url: string;
    waitFor?: string | null;
    hover?: string | null;
    click?: string | null;
    clip?: string | null;
    settleMs?: number;
    fullPage?: boolean;
  }): Promise<{ ok: true; pngBase64: string; width: number | null; height: number | null; url: string } | { ok: false; error: string }> {
    const waitMs = 10_000;
    let context: BrowserContext | null = null;
    this.activeCaptures += 1;
    try {
      const browser = await this.browser();
      const proxy = (await this.egressProxy()).contextOptions('capture');
      context = await browser.newContext({ viewport: VIEWPORT, proxy, ...BROWSER_NETWORK_CONTEXT_OPTIONS });
      await installCaptureNetworkPolicy(context);
      const page = await context.newPage();
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (opts.waitFor) {
        await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: waitMs });
        await page.locator(opts.waitFor).first().scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
      }
      if (opts.hover) await page.hover(opts.hover, { timeout: waitMs }).catch(() => undefined);
      if (opts.click) await page.click(opts.click, { timeout: waitMs }).catch(() => undefined);
      if (opts.settleMs && opts.settleMs > 0) await page.waitForTimeout(Math.min(10_000, opts.settleMs));
      let shot: Buffer;
      if (opts.clip) {
        const target = page.locator(opts.clip).first();
        await target.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
        shot = await target.screenshot({ type: 'png' });
      } else {
        shot = await page.screenshot({ type: 'png', fullPage: Boolean(opts.fullPage) });
      }
      const vp = page.viewportSize();
      return { ok: true, pngBase64: shot.toString('base64'), width: vp?.width ?? null, height: vp?.height ?? null, url: page.url() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'capture failed' };
    } finally {
      await context?.close().catch(() => undefined);
      this.activeCaptures -= 1;
      // A capture may be the only engine use this process ever sees — let the
      // idle reaper logic decide whether the shared browser should live on.
      void this.reapIdle();
    }
  }

  /** Live-view frame for the canvas card — jpeg keeps polling cheap. */
  async screenshot(scope: string): Promise<{ ok: true; jpegBase64: string; url: string; title: string } | { ok: false; error: string }> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    const shot = await session.page.screenshot({ type: 'jpeg', quality: 55 });
    return { ok: true, jpegBase64: shot.toString('base64'), url: session.page.url(), title: await session.page.title().catch(() => '') };
  }

  async close(scope: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session) return { ok: true, closed: false };
    this.sessions.delete(scope);
    await session.context.close().catch(() => undefined);
    void this.reapIdle();
    return { ok: true, closed: true };
  }
}

export function getBrowserEngine(): BrowserEngine {
  const store = globalThis as { __o8BrowserEngine?: BrowserEngine };
  if (!store.__o8BrowserEngine) store.__o8BrowserEngine = new BrowserEngine();
  return store.__o8BrowserEngine;
}
