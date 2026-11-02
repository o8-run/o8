export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { browserAgentEval, nativeReturnEval } from '@/lib/mcp/o8-webview-tools';
import { getBrowserEngine } from '@/lib/browser-engine/engine';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { requestNextBrowser } from '@/lib/next/browser-pipe';
import { requestBrowserOpen } from '@/lib/mcp/o8-browser-open';

type EmbeddedVerb = 'read' | 'localize' | 'rect' | 'click' | 'type' | 'probe' | 'grab';

/**
 * Try a verb against the NATIVE browser-view window (Stage 4). The host evals the
 * verb into the browser-view and PULLS its JSON result back via
 * `browser_view_eval_result` (WKWebView evaluateJavaScript return value) — the
 * page can't POST results to o8's HTTP server from an HTTPS origin (mixed content
 * → "Load failed"), so the host reads the value instead of the page pushing it.
 * Returns `{ handled: false }` when the native window isn't up, so the caller
 * falls back to the iframe path.
 */
async function tryNativeVerb(
  client: O8WebviewClient,
  verb: EmbeddedVerb,
  args: Record<string, unknown>,
): Promise<{ handled: boolean; result?: string }> {
  const agentJs = nativeReturnEval(verb, args);
  const triggerCode = `(async () => { try { const r = await window.__TAURI_INTERNALS__.invoke('browser_view_eval_result', { js: ${JSON.stringify(agentJs)}, timeoutMs: 8000 }); return JSON.stringify({ open: true, result: r }); } catch (e) { const m = String((e && e.message) || e); return JSON.stringify({ open: !/not open/i.test(m), error: m }); } })()`;
  try {
    const triggerResult = await client.evalJs(triggerCode);
    const parsed = JSON.parse(triggerResult.result) as { open?: boolean; result?: string };
    if (parsed.open !== true) return { handled: false };
    const result = typeof parsed.result === 'string' && parsed.result.length
      ? parsed.result
      : '{"ok":false,"error":"empty native result"}';
    return { handled: true, result };
  } catch {
    return { handled: false };
  }
}

/**
 * Stage 4b — Design Mode click-to-grab over the native window. The click lands in
 * the native window, so the in-page agent installs a hover-highlight + one-shot
 * click handler (startDesignGrab) that stores the GrabbedElement on
 * `window.__o8DesignGrabResult`. We arm it, then PULL that sink via the host
 * (browser_view_eval_result) every 350ms while the operator hovers + clicks — the
 * page can't POST from an HTTPS origin (mixed content). Returns the grab envelope,
 * or an error if the native window isn't open / the operator never clicks.
 */
async function startNativeDesignGrab(client: O8WebviewClient): Promise<string> {
  const armJs = `(function(){ try { window.__o8DesignGrabResult = null; if (window.__o8BrowserAgent && window.__o8BrowserAgent.startDesignGrab) window.__o8BrowserAgent.startDesignGrab(); } catch (e) {} return { armed: true }; })()`;
  const armTrigger = `(async () => { try { await window.__TAURI_INTERNALS__.invoke('browser_view_eval_result', { js: ${JSON.stringify(armJs)}, timeoutMs: 4000 }); return JSON.stringify({ open: true }); } catch (e) { const m = String((e && e.message) || e); return JSON.stringify({ open: !/not open/i.test(m) }); } })()`;
  let open = false;
  try {
    const triggerResult = await client.evalJs(armTrigger);
    open = JSON.parse(triggerResult.result).open === true;
  } catch {
    open = false;
  }
  if (!open) return JSON.stringify({ ok: false, error: 'native browser-view not open' });

  // Poll the grab sink for up to 3 minutes while the operator hovers + clicks. The
  // sink read clears itself so the next session starts fresh.
  const pollJs = `(function(){ var r = window.__o8DesignGrabResult; if (r) { window.__o8DesignGrabResult = null; return r; } return null; })()`;
  const pollTrigger = `(async () => { try { const r = await window.__TAURI_INTERNALS__.invoke('browser_view_eval_result', { js: ${JSON.stringify(pollJs)}, timeoutMs: 4000 }); return JSON.stringify({ r: r }); } catch (e) { return JSON.stringify({ r: null }); } })()`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    let r: string | null = null;
    try {
      const triggerResult = await client.evalJs(pollTrigger);
      r = (JSON.parse(triggerResult.result) as { r?: string | null }).r ?? null;
    } catch {
      r = null;
    }
    // eval_result returns '' (unset) — and defensively skip a literal 'null' — so
    // only a real grab envelope ends the poll.
    if (r && r.length > 0 && r !== 'null') return r;
  }
  return JSON.stringify({ ok: false, error: 'design-grab timed out' });
}

/** Tear down the in-page design-grab handler (Design Mode toggled off). */
async function stopNativeDesignGrab(client: O8WebviewClient): Promise<void> {
  const stopJs = `(function(){ try { if (window.__o8BrowserAgent && window.__o8BrowserAgent.stopDesignGrab) window.__o8BrowserAgent.stopDesignGrab(); } catch (e) {} })()`;
  const triggerCode = `(async () => { try { await window.__TAURI_INTERNALS__.invoke('browser_view_eval', { js: ${JSON.stringify(stopJs)} }); return '1'; } catch (e) { return '0'; } })()`;
  try {
    await client.evalJs(triggerCode);
  } catch {
    // best-effort teardown
  }
}

/**
 * Browser-verb bridge for the `o8 browser` CLI (#1232) — gated in middleware
 * (loopback + token). Two tiers behind one contract:
 *
 *   - EMBEDDED (phase 1): the verb evals into the in-page agent riding o8's
 *     own browser surfaces over the Tauri webview socket. Localhost pages.
 *   - ENGINE (phase 3): playwright-core drives the user's installed Chrome
 *     headless for external URLs the iframes can't show. One isolated
 *     context per scope (packetId or 'operator'); the canvas browser card
 *     live-views it via /api/browser/engine/view.
 *
 * Routing: `open` picks the tier by URL (external → engine). Other verbs
 * honor an explicit `surface: 'engine'`, else continue on the engine when
 * the scope already has a live engine page, else go embedded.
 *
 * Worker calls carry a packetId so every action lands in the lane's audit
 * trail as a `browser_acted` event.
 */

const VERBS = new Set(['read', 'localize', 'rect', 'click', 'type', 'probe', 'grab', 'open', 'close', 'designgrab', 'stopdesigngrab', 'drawmode', 'drawresult', 'drawpending', 'drawthumb']);

interface AgentBody {
  verb?: unknown;
  args?: unknown;
  packetId?: unknown;
}

function webviewClient(): O8WebviewClient {
  const store = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!store.__o8BrowserAgentClient) store.__o8BrowserAgentClient = new O8WebviewClient();
  return store.__o8BrowserAgentClient;
}

function isLocalUrl(url: string): boolean {
  if (url.startsWith('/')) return true;
  try {
    const host = new URL(url.includes('://') ? url : `http://${url}`).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return true; // unparseable → let the embedded tier report it
  }
}

function recordAction(packetId: string, verb: string, args: Record<string, unknown>, ok: boolean, url?: string, surface?: string) {
  try {
    const lane = findLatestLaneByPacket(packetId);
    if (!lane) return;
    recordLaneEvent(lane.id, 'browser_acted', 'system', {
      packetId,
      verb,
      ok,
      ...(typeof args.selector === 'string' ? { selector: String(args.selector).slice(0, 200) } : {}),
      ...(surface ? { surface } : typeof args.surface === 'string' ? { surface: args.surface } : {}),
      ...(url ? { url: url.slice(0, 200) } : {}),
    });
  } catch (error) {
    // The audit trail must never fail the action itself.
    console.error('[browser-agent] browser_acted event failed:', error);
  }
}

/** Best-effort reveal of the live-view tab in the canvas browser card. */
async function revealEngineView(scope: string): Promise<void> {
  try {
    const code = `(() => { try { window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: ${JSON.stringify(`o8-engine://${scope}`)} } })); return 'ok'; } catch { return 'skip'; } })()`;
    await webviewClient().evalJs(code);
  } catch {
    // Engine works headless even when the o8 window is closed.
  }
}

async function runEngineVerb(verb: string, scope: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const engine = getBrowserEngine();
  const selector = typeof args.selector === 'string' ? args.selector : '';
  switch (verb) {
    case 'open': {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const result = await engine.open(scope, url);
      if (result.ok) void revealEngineView(scope);
      return result;
    }
    case 'read':
      return engine.read(scope, typeof args.maxChars === 'number' ? args.maxChars : undefined);
    case 'click':
      if (!selector) return { ok: false, error: 'click requires a selector' };
      return engine.click(scope, selector);
    case 'type':
      if (!selector) return { ok: false, error: 'type requires a selector' };
      return engine.type(scope, selector, typeof args.text === 'string' ? args.text : '', args.submit === true);
    case 'probe':
      return engine.probe(scope, selector, typeof args.text === 'string' ? args.text : undefined);
    case 'grab':
      if (!selector) return { ok: false, error: 'grab requires a selector' };
      return engine.grab(scope, selector);
    case 'close':
      return engine.close(scope);
    default:
      return { ok: false, error: `engine does not support verb ${verb}` };
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AgentBody | null;
  const verb = typeof body?.verb === 'string' ? body.verb : '';
  if (!VERBS.has(verb)) {
    return NextResponse.json({ ok: false, error: `verb must be one of ${[...VERBS].join(', ')}` }, { status: 400 });
  }
  const args = (body?.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  const packetId = typeof body?.packetId === 'string' && body.packetId ? body.packetId : null;
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }
  const scope = packetId ?? 'operator';

  // Native-only Design Mode click-to-grab (Stage 4b) — handled before engine
  // routing (it drives the native browser-view agent, never the engine tier).
  if (verb === 'designgrab' || verb === 'stopdesigngrab') {
    try {
      const client = webviewClient();
      if (verb === 'designgrab') {
        const result = await startNativeDesignGrab(client);
        return new NextResponse(result, { headers: { 'content-type': 'application/json' } });
      }
      await stopNativeDesignGrab(client);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'design-grab failed' });
    }
  }

  // Native in-page drawing is deliberately pulled through the same narrow eval
  // channel as design-grab: arbitrary HTTPS pages cannot POST back to o8.
  if (verb === 'drawmode' || verb === 'drawresult' || verb === 'drawpending' || verb === 'drawthumb') {
    let js: string;
    if (verb === 'drawmode') {
      js = `(function(){ var a=window.__o8BrowserAgent; return a && a.drawmode ? a.drawmode(${JSON.stringify(args)}) : { ok:false,error:'native browser agent not installed yet' }; })()`;
    } else if (verb === 'drawthumb') {
      // Push a host-cropped thumbnail data: URI into the open draw composer.
      js = `(function(){ var a=window.__o8BrowserAgent; return a && a.drawthumb ? a.drawthumb(${JSON.stringify(args)}) : { ok:false }; })()`;
    } else if (verb === 'drawpending') {
      // Read (without clearing) the region the host should thumbnail.
      js = `(function(){ var a=window.__o8BrowserAgent; return a && a.drawpending ? a.drawpending() : null; })()`;
    } else {
      js = `(function(){ var r=window.__o8DesignDrawResult; if(r) window.__o8DesignDrawResult=null; return r || null; })()`;
    }
    const trigger = `(async()=>{try{const r=await window.__TAURI_INTERNALS__.invoke('browser_view_eval_result',{js:${JSON.stringify(js)},timeoutMs:4000});return JSON.stringify({open:true,result:r});}catch(e){return JSON.stringify({open:false});}})()`;
    try {
      const result = await webviewClient().evalJs(trigger);
      const parsed = JSON.parse(result.result) as { open?: boolean; result?: string | null };
      if (parsed.open !== true) return NextResponse.json({ ok: false, error: 'native browser-view not open' });
      if (verb === 'drawresult' || verb === 'drawpending') return new NextResponse(parsed.result || 'null', { headers: { 'content-type': 'application/json' } });
      return new NextResponse(parsed.result || '{"ok":false,"error":"empty native result"}', { headers: { 'content-type': 'application/json' } });
    } catch {
      return NextResponse.json({ ok: false, error: 'native draw bridge failed' });
    }
  }

  // Tier routing — explicit surface wins; `open` splits on URL locality;
  // other verbs stick with the engine once the scope has a live page.
  const engine = getBrowserEngine();
  const wantsEngine = args.surface === 'engine'
    || (verb === 'open' && typeof args.url === 'string' && args.url.trim() !== '' && !isLocalUrl(args.url.trim()))
    || (verb !== 'open' && verb !== 'localize' && verb !== 'rect' && args.surface === undefined && engine.hasSession(scope))
    || verb === 'close';

  try {
    if (wantsEngine) {
      const result = await runEngineVerb(verb, scope, args);
      const ok = result.ok === true;
      const url = typeof result.url === 'string' ? result.url : undefined;
      if (packetId && verb !== 'probe') recordAction(packetId, verb, args, ok, url, 'engine');
      return NextResponse.json(result);
    }

    // The owned Next child precedes classic's native/iframe panel path. Explicit
    // canvas and engine targeting retain their existing routing. A lost receipt
    // must never send a click/type a second time through a different renderer.
    if (args.surface !== 'canvas' && args.surface !== 'engine') {
      const next = requestNextBrowser(verb, args);
      if (next) {
        const result = await next as Record<string, unknown>;
        if (packetId && verb !== 'probe') recordAction(packetId, verb, args, result?.ok === true, typeof result?.url === 'string' ? result.url : undefined, 'native');
        return NextResponse.json(result);
      }
    }

    const client = webviewClient();
    if (verb === 'open') {
      const receipt = await requestBrowserOpen(client, args);
      if (packetId) recordAction(packetId, verb, args, receipt.ok, typeof receipt.url === 'string' ? receipt.url : undefined);
      return NextResponse.json(receipt);
    }

    // Native browser-view first (Stage 4) — the panel surface when the operator's
    // native path is up. Skips 'canvas' (browser cards stay on the iframe path),
    // and falls back to the iframe path below when the native window isn't open.
    if (
      (verb === 'read' || verb === 'localize' || verb === 'rect' || verb === 'click' || verb === 'type' || verb === 'grab' || verb === 'probe')
      && args.surface !== 'canvas'
    ) {
      const native = await tryNativeVerb(client, verb, args);
      if (native.handled) {
        const raw = native.result ?? '{"ok":false,"error":"empty native result"}';
        let ok = false;
        let url: string | undefined;
        try {
          const parsed = JSON.parse(raw) as { ok?: boolean; url?: string };
          ok = parsed.ok === true;
          url = typeof parsed.url === 'string' ? parsed.url : undefined;
        } catch {
          // envelope stays raw
        }
        if (packetId && verb !== 'probe') recordAction(packetId, verb, args, ok, url, 'native');
        return new NextResponse(raw, { headers: { 'content-type': 'application/json' } });
      }
    }

    if (verb === 'probe') {
      // One-shot probe — the CLI loops client-side for waits.
      const result = await client.evalJs(browserAgentEval('probe', args));
      return new NextResponse(result.result, { headers: { 'content-type': 'application/json' } });
    }
    const result = await client.evalJs(browserAgentEval(verb as EmbeddedVerb, args));
    let ok = false;
    let url: string | undefined;
    try {
      const parsed = JSON.parse(result.result) as { ok?: boolean; url?: string };
      ok = parsed.ok === true;
      url = typeof parsed.url === 'string' ? parsed.url : undefined;
    } catch {
      // envelope stays raw
    }
    if (packetId) recordAction(packetId, verb, args, ok, url);
    return new NextResponse(result.result, { headers: { 'content-type': 'application/json' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'browser agent bridge failed',
      hint: wantsEngine
        ? 'Engine tier — is Google Chrome installed? The engine drives the installed Chrome headless.'
        : 'The o8 app window must be running — the bridge rides the Tauri webview socket.',
    });
  }
}
