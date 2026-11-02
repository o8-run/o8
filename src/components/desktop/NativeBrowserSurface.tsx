'use client';

/**
 * NativeBrowserSurface — the placeholder + position-sync layer for the native
 * browser-view child window (docs/internals/native-browser-webview-spec.md, Stage 3).
 *
 * When the operator flag is on, O8BrowserPane renders THIS instead of the iframe
 * for a tab with a URL. It paints a transparent placeholder where the page
 * should be and drives the native host-owned `browser-view` window to sit over
 * that rect: open + navigate on url change, reposition on resize, hide when the
 * pane scrolls offscreen / the tab isn't visible / it unmounts.
 *
 * Self-contained visibility: an IntersectionObserver detects whether the
 * placeholder is actually on screen (the Browser tab can be `display:none` while
 * mounted), so this needs no `active` prop threaded through O8Panel's two mount
 * sites. The native window composites ABOVE o8's web content — occlusion of
 * overlays that cross this rect is handled in Stage 5.
 *
 * Everything no-ops outside Tauri/macOS (the iframe path is the default there).
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  isTauri,
  browserViewOpen,
  browserViewViewportSize,
  browserViewSetRect,
  browserViewHide,
  browserViewShow,
  browserViewCapture,
  browserViewClose,
  type BrowserViewRect,
} from '@/lib/tauri/bridge';
import { NATIVE_BROWSER_AGENT_SOURCE } from '@/lib/browser/native-agent-source';
import { readAppliedUiZoom } from '@/lib/appearance/ui-zoom';
import { cropRegionBase64, type CropRect } from '@/lib/browser/region-crop';

interface NativeBrowserSurfaceProps {
  /** The active tab's URL — the page the native window navigates to. */
  url: string;
  /** Agent-driving glow (framed around the surface while a verb lands). */
  agentGlow?: boolean;
  /** PiP uses the same page viewport as its iframe preview. */
  viewportWidth?: number;
}

function rectKey(r: BrowserViewRect): string {
  return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)},${r.pageZoom ?? 1}`;
}

let lastShownNativeBrowserUrl = '';
let activeNativeBrowserSurface: symbol | null = null;
let nativeBrowserWork = Promise.resolve();

// All mounted placeholders share one native window. Serialize the seam and
// discard work from a surface that lost ownership while IPC was in flight.
function enqueueNativeBrowserWork(owner: symbol | null, work: () => Promise<void>) {
  nativeBrowserWork = nativeBrowserWork.then(async () => {
    if (activeNativeBrowserSurface === owner) await work();
  }).catch((error) => { console.warn('[native-browser] sync failed:', error); });
}

export function NativeBrowserSurface({ url, agentGlow, viewportWidth }: NativeBrowserSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRect = useRef<string>('');
  const followPosition = useRef<() => void>(() => {});
  const opening = useRef(false);
  const calibration = useRef(0);
  /** Whether the placeholder is currently on screen (driven by the observer). */
  const visibleRef = useRef<boolean>(false);
  const owner = useRef(Symbol('native-browser-surface'));
  const hideOwned = useCallback(() => {
    if (activeNativeBrowserSurface !== owner.current) return;
    activeNativeBrowserSurface = null;
    enqueueNativeBrowserWork(null, browserViewHide);
  }, []);
  /** Page-zoom factor: visual-viewport px ÷ layout (CSS) px. 1 at 100%. */
  const zoomRef = useRef<number>(1);
  /** Occlusion state (Stage 5): the native window composites ABOVE o8's web
   *  content, so any overlay (⌘K palette, modal, dictation pill) that crosses the
   *  browser rect would render BEHIND it. When detected we hide the native window
   *  and paint a last-frame snapshot, then restore on close. */
  const occludedRef = useRef<boolean>(false);
  /** Sticky occlusion forced by the dashboard (Design Mode grab card open): the
   *  card lands over the BOTTOM of the native rect, which the geometric sampler
   *  misses, so the dashboard tells us to hide explicitly. While true, the
   *  geometric checkOcclusion must not un-hide. */
  const forceOccludeRef = useRef<boolean>(false);
  /** Cached base64 PNG of the page (no data: prefix) painted while occluded. */
  const snapshotRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** DOMRects already include CSS UI zoom. Only WK page zoom needs conversion:
   * native viewport points / CSS viewport px. A 100vh probe inherits html.zoom
   * and undoes the UI zoom, shifting and enlarging the child a second time. */
  const measureZoom = useCallback(async () => {
    const viewport = await browserViewViewportSize();
    return viewport.w / window.innerWidth;
  }, []);

  const computeRect = useCallback((): BrowserViewRect | null => {
    const el = ref.current;
    if (!el) return null;
    const z = zoomRef.current;
    const r = el.getBoundingClientRect();
    // Convert layout (CSS) px → VISUAL px by the zoom factor, then clamp to the
    // visible content area. The native child window is a SEPARATE OS window, NOT
    // clipped by o8's CSS overflow:hidden the way an iframe is — so without the
    // clamp it paints PAST o8's window edges. We also stop the bottom at the
    // FOOTER (DesktopStatusBar) top so the native window never covers the status
    // bar (operator video, 2026-06-25).
    const nativeViewportWidth = window.innerWidth * z;
    const viewportHeight = window.innerHeight * z;
    let footerTop = viewportHeight;
    const footer = document.querySelector('[data-mcp-scope="desktop-status-bar"]');
    if (footer) {
      const ft = footer.getBoundingClientRect().top * z;
      if (ft > 0 && ft <= viewportHeight) footerTop = ft;
    }
    let left = Math.max(0, r.left * z);
    let top = Math.max(0, r.top * z);
    let right = Math.min(nativeViewportWidth, r.right * z);
    let bottom = Math.min(viewportHeight, footerTop, r.bottom * z);
    // A separate OS window cannot inherit CSS clipping or hidden ancestors.
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.02) return null;
      if (node === el) continue;
      const clip = node.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX || style.overflow)) {
        left = Math.max(left, clip.left * z); right = Math.min(right, clip.right * z);
      }
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY || style.overflow)) {
        top = Math.max(top, clip.top * z); bottom = Math.min(bottom, clip.bottom * z);
      }
    }
    // Tauri's macOS window sizing rounds fractional points outward. Inset to
    // whole points so a zoomed/animated host never spills over its toolbar/card.
    left = Math.ceil(left); top = Math.ceil(top);
    right = Math.floor(right); bottom = Math.floor(bottom);
    const w = right - left;
    const h = bottom - top;
    if (w < 1 || h < 1) return null;
    const pageZoom = viewportWidth ? w / viewportWidth : readAppliedUiZoom() * z;
    return { x: left, y: top, w, h, ...(pageZoom === 1 ? {} : { pageZoom }) };
  }, [viewportWidth]);

  /** Push the current rect to the native window, deduped. */
  const syncRect = useCallback(() => {
    if (!visibleRef.current || occludedRef.current || activeNativeBrowserSurface !== owner.current) return;
    const rect = computeRect();
    if (!rect) { hideOwned(); return; }
    const key = rectKey(rect);
    if (key === lastRect.current) return;
    lastRect.current = key;
    enqueueNativeBrowserWork(owner.current, async () => {
      if (visibleRef.current && !occludedRef.current && key === lastRect.current) await browserViewSetRect(rect);
    });
  }, [computeRect, hideOwned]);

  /** Capture a fresh snapshot for the occlusion swap, debounced — only while the
   *  window is visible + NOT occluded (else screencapture grabs the overlay or a
   *  hidden region). The frozen frame is stale-tolerant (shown under an overlay
   *  the user is focused on), so exact timing doesn't matter. */
  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
    snapshotTimer.current = setTimeout(() => {
      if (!visibleRef.current || occludedRef.current) return;
      void browserViewCapture().then((png) => { if (png) snapshotRef.current = png; });
    }, 900);
  }, []);

  const showOrOpen = useCallback((rect: BrowserViewRect) => {
    activeNativeBrowserSurface = owner.current;
    lastRect.current = rectKey(rect);
    enqueueNativeBrowserWork(owner.current, async () => {
      if (!visibleRef.current || occludedRef.current) return;
      const current = computeRect();
      if (!current) return;
      if (lastShownNativeBrowserUrl === url) {
        await browserViewSetRect(current);
        if (!occludedRef.current && visibleRef.current) await browserViewShow();
      } else {
        await browserViewOpen(url, current, NATIVE_BROWSER_AGENT_SOURCE);
        lastShownNativeBrowserUrl = url;
      }
    });
    scheduleSnapshot();
  }, [computeRect, scheduleSnapshot, url]);

  /** Enter/leave the occluded state: hide the native window + paint the snapshot
   *  so the o8 overlay underneath shows without a blank gap; restore on leave. */
  const setOccluded = useCallback((occluded: boolean) => {
    if (occluded === occludedRef.current) return;
    occludedRef.current = occluded;
    const img = imgRef.current;
    if (occluded) {
      if (img) {
        if (snapshotRef.current) {
          img.src = `data:image/png;base64,${snapshotRef.current}`;
          img.style.display = 'block';
        } else {
          img.style.display = 'none';
        }
      }
      enqueueNativeBrowserWork(owner.current, browserViewHide);
    } else {
      if (!visibleRef.current || activeNativeBrowserSurface !== owner.current) return;
      // Reposition before show, or open if this owner first appeared covered.
      const rect = computeRect();
      if (!rect) return;
      lastRect.current = '';
      showOrOpen(rect);
      // Hold the snapshot a beat so the native window paints before we drop it
      // (no one-frame gap during the show), then refresh it for next time.
      if (img) setTimeout(() => { img.style.display = 'none'; }, 220);
      scheduleSnapshot();
    }
  }, [computeRect, showOrOpen, scheduleSnapshot]);

  /** Detect an o8 overlay painting over the browser rect: sample the rect's
   *  center + corners with elementsFromPoint (CSS/layout coords). A hit only
   *  counts as occluding if it actually PAINTS something visible — walk up from
   *  the hit element and require a non-transparent background / image / blur
   *  before reaching the placeholder. This skips the transparent full-screen
   *  click-catcher wrappers that popovers/menus mount (which cover the rect but
   *  paint nothing — a false hide otherwise). The snapshot img is
   *  pointer-events:none so it's transparent to this probe. */
  const checkOcclusion = useCallback(() => {
    const el = ref.current;
    if (!el || !visibleRef.current) return;
    // Dashboard-forced occlusion (grab card open) wins over geometry — the card
    // only covers the bottom of the rect, so the sampler would falsely un-hide.
    if (forceOccludeRef.current) { setOccluded(true); return; }
    const r = el.getBoundingClientRect();
    // A degenerate anchor means a HIDDEN ancestor (Settings takeover's
    // display:none workspace, the width-0 collapsed right panel) — the native
    // child window ignores CSS, so treat it as occluded and hide explicitly
    // instead of keeping the last state (reviewer hardening, 2026-07-16).
    // Geometry returning >4px un-occludes through the normal probe below.
    if (r.width < 4 || r.height < 4) { setOccluded(true); return; }
    const permitsPainting = (node: Element): boolean => {
      let opacity = 1;
      for (let n: Element | null = node; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (style.display === 'none') return false;
        opacity *= Number(style.opacity || 1);
        if (opacity <= 0.02) return false;
      }
      return true;
    };
    const paintsVisibly = (hit: Element): boolean => {
      // A cached portal can retain its blur/background while its ancestor is
      // transparent. Those styles cannot paint through zero effective opacity.
      // Inert/aria-hidden alone do not suppress paint, so visible covers still win.
      if (!permitsPainting(hit) || getComputedStyle(hit).visibility !== 'visible') return false;
      let n: Element | null = hit;
      for (let i = 0; i < 6 && n && n !== document.body; i++) {
        if (n === el || el.contains(n)) return false; // reached the placeholder — not an occluder
        // Design Mode's overlay covers the whole screen but is meant to interact
        // WITH the native browser (Stage 4b click-to-grab), not hide it — skip it
        // so the native window stays visible + clickable while grabbing.
        if (n.getAttribute('data-design-mode-overlay') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
        if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
        const bg = cs.backgroundColor || '';
        if (bg && bg !== 'transparent') {
          const m = bg.match(/rgba?\(([^)]+)\)/);
          const parts = m ? m[1].split(',') : [];
          const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
          if (alpha > 0.02) return true;
        }
        n = n.parentElement;
      }
      return false;
    };
    // PORTAL RECT SWEEP (root fix, operator 2026-07-06). Point sampling kept
    // missing popovers whose overlap band dodged the probe grid (the context
    // meter cut a vertical strip between all three left-column probes). Every
    // o8 popover/menu portals into <body> with position:fixed, so instead of
    // guessing points we intersect each portal's PAINTED rect with the browser
    // rect exactly. A portal wrapper is often a transparent full-screen
    // click-catcher — when it doesn't paint, we look for its first painted
    // descendant and use THAT rect (bounded walk).
    const intersects = (a: DOMRect): boolean => {
      const ox = Math.min(a.right, r.right) - Math.max(a.left, r.left);
      const oy = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
      return ox > 12 && oy > 12;
    };
    const paintedRectIntersects = (root: Element): boolean => {
      if (root === el || el.contains(root) || root.contains(el)) return false;
      if (root.getAttribute('data-design-mode-overlay') === 'true') return false;
      if (!permitsPainting(root)) return false;
      const queue: Element[] = [root];
      let budget = 40;
      while (queue.length && budget-- > 0) {
        const n = queue.shift()!;
        const nr = n.getBoundingClientRect();
        if (nr.width < 2 || nr.height < 2) continue;
        if (paintsVisibly(n)) return intersects(nr);
        queue.push(...Array.from(n.children));
      }
      return false;
    };
    let occluded = false;
    for (const child of Array.from(document.body.children)) {
      // Skip the app root (huge, always paints) — in-app surfaces are handled
      // by the forced-occlusion channel; this sweep is for portaled overlays.
      if (child.contains(el)) continue;
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
      if (paintedRectIntersects(child)) { occluded = true; break; }
    }
    // Fallback point grid for anything exotic that neither portals nor goes
    // through the forced channel.
    if (!occluded) {
      const inset = 6;
      const xs = [r.left + inset, r.left + r.width / 2, r.right - inset];
      const ys = [r.top + inset, r.top + r.height / 2, r.bottom - inset];
      for (const px of xs) {
        for (const py of ys) {
          const top = document.elementsFromPoint?.(px, py)[0];
          if (top && top !== el && !el.contains(top) && !top.contains(el) && paintsVisibly(top)) {
            occluded = true;
            break;
          }
        }
        if (occluded) break;
      }
    }
    setOccluded(occluded);
  }, [setOccluded]);

  const openHere = useCallback(async () => {
    if (!visibleRef.current || !url || opening.current) return;
    opening.current = true;
    const request = ++calibration.current;
    try {
      const zoom = await measureZoom();
      if (!visibleRef.current || request !== calibration.current) return;
      zoomRef.current = zoom;
      occludedRef.current = false;
      if (imgRef.current) imgRef.current.style.display = 'none';
      const rect = computeRect();
      if (!rect) return;
      activeNativeBrowserSurface = owner.current;
      checkOcclusion();
      if (!occludedRef.current) showOrOpen(rect);
    } finally {
      if (request === calibration.current) opening.current = false;
    }
  }, [url, computeRect, measureZoom, showOrOpen, checkOcclusion]);

  // Visibility: open when the placeholder appears on screen, hide when it leaves
  // (tab switched away → display:none → not intersecting). The native window is a
  // separate OS window, so it won't auto-hide with the React pane — this is what
  // keeps it from floating over an unrelated tab.
  useEffect(() => {
    if (!isTauri()) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nowVisible = !!entry && entry.isIntersecting && entry.intersectionRatio > 0;
        if (nowVisible === visibleRef.current) return;
        visibleRef.current = nowVisible;
        if (nowVisible) {
          followPosition.current();
          void openHere();
        } else {
          // Tab switched away — drop occlusion state so a stale snapshot/hidden
          // flag never carries into the next show.
          calibration.current += 1;
          opening.current = false;
          occludedRef.current = false;
          if (imgRef.current) imgRef.current.style.display = 'none';
          hideOwned();
        }
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => {
      calibration.current += 1;
      opening.current = false;
      io.disconnect();
    };
  }, [openHere, hideOwned]);

  // Navigate when the URL changes while visible (tab switch / URL bar).
  useEffect(() => {
    if (!isTauri()) return;
    if (!visibleRef.current || !url || url === lastShownNativeBrowserUrl) return;
    void openHere();
  }, [url, openHere]);

  // Reposition on container/window resize + scroll. Live drag-resize jank +
  // overlay occlusion are handled in Stage 5 (hide + snapshot on settle).
  useEffect(() => {
    if (!isTauri()) return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncRect());
    ro.observe(el);
    // A floating preview moves without resizing. Follow its position/motion
    // so the native page stays inside the dragged shell on every frame.
    const pip = el.closest('[data-hover-pip]');
    const pipPositionObserver = pip ? new MutationObserver(() => syncRect()) : null;
    if (pip) pipPositionObserver?.observe(pip, { attributes: true, attributeFilter: ['style'] });
    // A window resize is also where page-zoom changes surface — remeasure the
    // zoom before repositioning. Scroll and panel-divider drags (ResizeObserver)
    // don't change zoom, so they skip it.
    let resizeMeasurement = 0;
    const onResize = () => {
      const request = ++resizeMeasurement;
      void measureZoom().then((zoom) => {
        if (request !== resizeMeasurement) return;
        zoomRef.current = zoom;
        syncRect();
      });
    };
    const onScroll = () => syncRect();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    // The o8 UI-zoom (lib/appearance/ui-zoom.ts) sets html.style.zoom, which does
    // NOT fire a window resize — observe the <html> style so the native window
    // tracks a live zoom change instead of drifting until the next reopen.
    const htmlObserver = new MutationObserver(() => syncRect());
    htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    // Ancestor motion (panel transitions, PiP transforms) can change position
    // without resizing the host. Follow rendered geometry, deduped at the seam.
    let frame = 0;
    let dpr = window.devicePixelRatio;
    let geometry = '';
    const follow = () => {
      frame = 0;
      if (!visibleRef.current) return;
      if (dpr !== window.devicePixelRatio) { dpr = window.devicePixelRatio; onResize(); }
      const rect = computeRect();
      if (!rect) hideOwned();
      // IO can stay intersecting through opacity/clip transitions. Recover
      // when rendered geometry becomes valid without stealing a newer owner.
      else if (activeNativeBrowserSurface === null) void openHere();
      else if (activeNativeBrowserSurface === owner.current && rectKey(rect) !== geometry) {
        geometry = rectKey(rect); checkOcclusion(); syncRect();
      }
      frame = requestAnimationFrame(follow);
    };
    followPosition.current = () => { if (!frame) frame = requestAnimationFrame(follow); };
    if (visibleRef.current) followPosition.current();
    return () => {
      resizeMeasurement += 1;
      followPosition.current = () => {};
      cancelAnimationFrame(frame);
      ro.disconnect();
      pipPositionObserver?.disconnect();
      htmlObserver.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [syncRect, measureZoom, computeRect, checkOcclusion, hideOwned, openHere]);

  // Occlusion detection (Stage 5). o8 overlays (⌘K/⌘⇧K palettes, modals, the
  // dictation pill, settings) portal into <body>, so a body childList mutation
  // is the primary trigger; a slow poll is the safety net for overlays that
  // toggle visibility in place. Each check is one elementsFromPoint sweep,
  // rAF-coalesced so a burst of mutations costs at most one probe per frame.
  useEffect(() => {
    if (!isTauri()) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; checkOcclusion(); });
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    const poll = setInterval(schedule, 500);
    return () => {
      mo.disconnect();
      clearInterval(poll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [checkOcclusion]);

  // Native in-page draw mode owns pointer input while the browser stays live.
  // The host arms it for the visible instance, polls the page-owned result sink,
  // captures the live window at submission, then forwards the draw payload.
  useEffect(() => {
    if (!isTauri()) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopDraw = () => {
      if (poll) clearInterval(poll);
      poll = null;
      void fetch('/api/browser/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verb: 'drawmode', args: { on: false } }),
      }).catch(() => {});
    };
    // The composer thumbnail (Cursor parity, preview only — the REAL payload
    // screenshot is still captured fresh at send). The in-page composer can't
    // screenshot itself, so when the page reports a pending drawn region we
    // capture the live window HERE, crop it, and push it back as a data: URI.
    // Deduped by region so we capture once per stroke.
    let deliveredThumbKey = '';
    const pollThumb = () => {
      void fetch('/api/browser/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'drawpending', args: {} }) })
        .then((reply) => reply.text()).then((text) => {
          if (!text || text === 'null') { deliveredThumbKey = ''; return; }
          let pending: { rect?: CropRect; viewport?: { width: number; height: number } } | null = null;
          try { pending = JSON.parse(text); } catch { return; }
          const rect = pending?.rect;
          if (!rect) return;
          const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
          if (key === deliveredThumbKey) return;
          deliveredThumbKey = key;
          void browserViewCapture().then((png) => {
            if (!png) return;
            void cropRegionBase64(png, rect, pending?.viewport ?? null, { maxHeight: 88, pad: 8 }).then((cropB64) => {
              if (!cropB64) return;
              void fetch('/api/browser/agent', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ verb: 'drawthumb', args: { dataUri: `data:image/png;base64,${cropB64}` } }),
              }).catch(() => {});
            });
          }).catch(() => {});
        }).catch(() => {});
    };

    const startPolling = () => {
      if (poll) clearInterval(poll);
      deliveredThumbKey = '';
      poll = setInterval(() => {
        void fetch('/api/browser/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'drawresult', args: {} }) })
          .then((reply) => reply.text()).then((text) => {
            if (!text || text === 'null') { pollThumb(); return; }
            let payload: Record<string, unknown> | null = null;
            try { payload = JSON.parse(text) as Record<string, unknown>; } catch { return; }
            // Esc INSIDE the native page (its keydown never reaches this
            // webview) — tear down and exit Design Mode so the brush and
            // the in-page canvas can't desync.
            if (payload?.escaped === true) {
              if (poll) clearInterval(poll); poll = null;
              stopDraw();
              window.dispatchEvent(new CustomEvent('o8:design-mode-request', { detail: { action: 'close' } }));
              return;
            }
            if (!payload?.ok) { pollThumb(); return; }
            if (poll) clearInterval(poll); poll = null;
            void browserViewCapture().then((screenshotBase64) => {
              window.dispatchEvent(new CustomEvent('o8:design-draw-native', { detail: { ...payload, screenshotBase64 } }));
              stopDraw();
            });
          }).catch(() => {});
      }, 350);
    };

    const armDrawMode = () => fetch('/api/browser/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'drawmode', args: { on: true } }),
    }).then((r) => r.json() as Promise<{ ok?: boolean; error?: string }>);

    // True while Design Mode is armed — the recreate/arm retry loop below
    // must stop the moment the operator toggles the mode off.
    let designArmed = false;

    // A lit Design brush must never sit over a page with no draw layer
    // (live-hit 2026-07-31, report 2B8A88): every abandoned arm path closes
    // the mode so the toggle visibly snaps off instead of failing silently.
    // Only the visible (arming) instance ever reaches these paths, so the
    // hidden twin cannot kill a mode its sibling is still arming.
    const bailDesignMode = (reason: string) => {
      designArmed = false;
      console.warn(`[native-browser] design mode arm failed: ${reason}`);
      window.dispatchEvent(new CustomEvent('o8:design-mode-request', { detail: { action: 'close' } }));
    };

    const onDesignMode = (event: Event) => {
      const active = (event as CustomEvent<{ active?: boolean }>).detail?.active === true;
      if (!active) {
        designArmed = false;
        stopDraw();
        return;
      }
      // Design Mode on: only the VISIBLE instance arms. O8Panel mounts
      // NativeBrowserSurface TWICE (main + utility shell); a hidden instance must
      // do NOTHING here (they drive one shared browser-view).
      if (!visibleRef.current) return;
      designArmed = true;
      void armDrawMode().then(async (resp) => {
        if (!designArmed) return;
        if (resp?.ok) { startPolling(); return; }
        if (!String(resp?.error ?? '').includes('not installed')) {
          bailDesignMode(String(resp?.error ?? 'arm rejected'));
          return;
        }
        // The agent source injects at WINDOW CREATION, so a window that
        // predates the draw layer (or any code update — page CSP blocks
        // eval-based re-injection) can never learn drawmode in place.
        // RECREATE it. Ordering matters (live-hit 2026-07-12 ×2): window
        // destruction is ASYNC — an immediate reopen finds the dying window
        // still registered and takes Rust's "exists → navigate" path, which
        // never registers the init script. Settle after close, reopen with
        // the CURRENT source, then poll-arm until the fresh page answers.
        const rect = computeRect();
        if (!rect) {
          bailDesignMode('no visible rect to recreate the browser window in');
          return;
        }
        await browserViewClose();
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        if (!designArmed) return;
        lastRect.current = '';
        await browserViewOpen(url, rect, NATIVE_BROWSER_AGENT_SOURCE);
        let attempts = 0;
        const tryArm = () => {
          if (!designArmed) return;
          void armDrawMode().then((retry) => {
            if (!designArmed) return;
            if (retry?.ok) { startPolling(); return; }
            attempts += 1;
            if (attempts < 24) window.setTimeout(tryArm, 500);
            else bailDesignMode('draw layer never answered after window recreate (24 tries)');
          }).catch(() => {
            attempts += 1;
            if (!designArmed) return;
            if (attempts < 24) window.setTimeout(tryArm, 500);
            else bailDesignMode('draw layer arm kept erroring after window recreate (24 tries)');
          });
        };
        window.setTimeout(tryArm, 800);
      }).catch((error) => {
        if (designArmed) bailDesignMode(error instanceof Error ? error.message : 'arm request failed');
      });
    };
    window.addEventListener('o8:design-mode', onDesignMode);
    return () => {
      designArmed = false;
      window.removeEventListener('o8:design-mode', onDesignMode);
      if (poll) clearInterval(poll);
    };
  }, [computeRect, url]);

  // Dashboard-forced occlusion: the Design Mode grab result card opens over the
  // native window (an always-on-top OS window), so the dashboard signals us to
  // hide it while the card is open + restore on close. The geometric sampler can't
  // see a card that only covers the bottom of the rect, so this is explicit. Only
  // the VISIBLE instance acts (dual-mount — a hidden one hiding the shared window
  // would be wrong).
  useEffect(() => {
    const onForceOcclude = (event: Event) => {
      if (!visibleRef.current) return;
      const occlude = (event as CustomEvent<{ occlude?: boolean }>).detail?.occlude === true;
      forceOccludeRef.current = occlude;
      setOccluded(occlude);
    };
    window.addEventListener('o8:native-browser-occlude', onForceOcclude);
    return () => window.removeEventListener('o8:native-browser-occlude', onForceOcclude);
  }, [setOccluded]);

  // Hide the native window on unmount (keep it alive for a fast re-show — the
  // Browser tab closing entirely is what triggers browser_view_close upstream).
  useEffect(() => {
    return () => {
      visibleRef.current = false;
      if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
      if (isTauri()) hideOwned();
    };
  }, [hideOwned]);

  return (
    <div
      ref={ref}
      data-o8-native-browser="panel"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: 'transparent',
        boxShadow: agentGlow ? 'inset 0 0 0 1.5px rgba(245,158,11,0.75)' : 'none',
        transition: 'box-shadow 200ms ease-out',
      }}
    >
      {/* Occlusion snapshot — the page's last frame, painted while the native
          window is hidden for an overlay so the area never goes blank.
          pointer-events:none keeps it transparent to the elementsFromPoint probe
          and to the human's pointer. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- transient base64
          snapshot data-URL, not a remote/LCP image; next/image can't optimize it. */}
      <img
        ref={imgRef}
        alt=""
        aria-hidden="true"
        style={{
          display: 'none',
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'fill',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
