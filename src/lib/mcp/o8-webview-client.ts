import { savedImageReadScript, type SavedImageTarget } from '@/lib/mcp/o8-saved-image-read';
import { validateImageAttachment, validateComposerInspection, imageRequestId, type ImageAttachmentRequest } from '@/lib/composer/image-attachment';
import { readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';

import { sendScreenshotWithFallback } from '@/lib/mcp/o8-screenshot-fallback';
import { resolveO8WebviewSocketPath } from '@/lib/mcp/o8-webview-socket';
import {
  createCodedError, getErrorCode, isMutationAckTimeout, queueCommandWrite, WebviewMutationUncertainError,
  type PendingRequest,
} from '@/lib/mcp/o8-webview-command-transport';
// Retry-safety is classified once, next to the command's documentation, in the
// socket command catalog. See o8-webview-commands.ts for the full surface.
import { RECONNECT_RETRY_SAFE_COMMANDS } from '@/lib/mcp/o8-webview-commands';
import { nativeWebviewError, WebviewBridgeError } from '@/lib/mcp/o8-webview-error';

const DEFAULT_WINDOW_LABEL = 'main';
const REQUEST_TIMEOUT_MS = 30_000;

import {
  coercePageMap, detectImageMimeType, extractCoordinates, extractDataUrlPayload,
  formatSnapshotTree, getImageDimensions, normalizeTextResult, unwrapCommandData,
  type O8AppInfo, type O8EventsAction, type O8NavigateWebviewAction,
  type O8WindowInfo, type O8WindowOperation, type SocketResponse,
} from '@/lib/mcp/o8-webview-client-data';
import { parseDirectoryResolve, type DirectoryResolve } from '@/lib/mcp/o8-directory-dialog-tools';
export type {
  O8AppInfo, O8EventsAction, O8MonitorInfo, O8NavigateWebviewAction, O8WindowInfo, O8WindowOperation,
} from '@/lib/mcp/o8-webview-client-data';

export class O8WebviewClient {
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private socket: Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private isConnected = false;
  private buffer = '';
  private authToken?: string;
  private readonly pending = new Map<string, PendingRequest>();
  private typeQueue: Promise<unknown> = Promise.resolve();
  private cancelled = false;

  constructor() {
    this.socketPath = resolveO8WebviewSocketPath();
    this.tokenPath = `${this.socketPath}.token`;

    const cleanup = () => {
      this.dispose();
    };

    process.once('beforeExit', cleanup);
    process.once('exit', cleanup);
  }

  async inspectSavedImage(target: SavedImageTarget): Promise<Record<string, unknown>> {
    return JSON.parse((await this.evalJs(savedImageReadScript(target))).result);
  }

  async hardReload(args: { operation: 'observe' | 'reload'; document_id?: string }): Promise<Record<string, unknown>> {
    const observed = JSON.parse((await this.evalJs(savedImageReadScript())).result) as Record<string, unknown>;
    if (observed.status !== 'ready') return observed;
    if (args.operation === 'observe') return { ...observed, document_changed: args.document_id ? observed.document_id !== args.document_id : null };
    if (observed.document_id !== args.document_id) return { status: 'error', code: 'stale_document', action_dispatched: false, document_id: observed.document_id };
    try {
      await this.navigateWebview({ action: 'reload' });
      return { status: 'pending', document_id: args.document_id, action_dispatched: true, next: 'Observe document identity; never automatically replay reload' };
    } catch {
      return { status: 'unknown', document_id: args.document_id, action_dispatched: null, next: 'Observe document identity; never automatically replay reload' };
    }
  }

  async inspectDirectoryDialog(): Promise<Record<string, unknown>> {
    return unwrapCommandData(await this.sendCommand('inspect_directory_dialog', {}));
  }

  /** Narrow read route for native appearance; never request the whole store. */
  async readNativePreference(key: string): Promise<string | null> {
    if (!['cortex-theme-palette', 'cortex-theme', 'cortex-reduce-transparency',
      'cortex-workspace-glass', 'o8:sidebar:visible', 'o8:sidebar:width'].includes(key)) {
      throw new Error('Unsupported native preference');
    }
    const value = await this.sendCommand('manage_local_storage', { action: 'get', key, window_label: 'main' });
    if (value === null || typeof value === 'string' && value.length <= 4096) return value;
    throw new Error('Invalid native preference response');
  }

  async resolveDirectoryDialog(args: DirectoryResolve): Promise<Record<string, unknown>> {
    return unwrapCommandData(await this.sendCommand('resolve_directory_dialog', parseDirectoryResolve(args)));
  }

  async screenshot(): Promise<{ imageBase64: string; mimeType: string; width: number; height: number }> {
    const result = await sendScreenshotWithFallback(
      (command, payload) => this.sendCommand(command, payload),
      () => this.dispose(),
      DEFAULT_WINDOW_LABEL,
    );
    const { base64, mimeType } = extractDataUrlPayload(result);
    const resolvedMimeType = detectImageMimeType(base64, mimeType);
    const { width, height } = getImageDimensions(base64);
    return { imageBase64: base64, mimeType: resolvedMimeType, width, height };
  }

  async snapshot(): Promise<{ tree: string }> {
    const payload = {
      window_label: DEFAULT_WINDOW_LABEL,
      include_content: false,
      interactive_only: false,
      include_metadata: false,
    };
    let raw: unknown;
    try {
      raw = await this.sendCommand('get_page_map', payload);
    } catch (error) {
      if (!isMutationAckTimeout(error)) throw error;
      raw = await this.sendCommand('get_page_map', payload);
    }
    const pageMap = coercePageMap(raw);
    return { tree: formatSnapshotTree(pageMap) };
  }

  async click(opts: { ref?: number; x?: number; y?: number }): Promise<{ ok: boolean; element?: string }> {
    let targetX = opts.x;
    let targetY = opts.y;

    if (typeof opts.ref === 'number') {
      const coords = extractCoordinates(await this.sendCommand('get_element_position', {
        window_label: DEFAULT_WINDOW_LABEL,
        selector_type: 'ref',
        selector_value: String(opts.ref),
        should_click: false,
      }));
      targetX = coords.x;
      targetY = coords.y;
    }

    if (typeof targetX !== 'number' || typeof targetY !== 'number') {
      throw new Error('click requires either ref or x/y coordinates');
    }

    // Click via JS element.click() instead of native NSEvent. React 17+
    // installs its synthetic event system at the React tree root and ignores
    // synthetic/low-trust MouseEvents dispatched through NSWindow.sendEvent —
    // every onClick handler silently drops. A direct element.click() call
    // generates a trusted click that React handles identically to a real
    // user click. This is the only reliable way to drive a React button
    // from webview automation.
    //
    // We walk up from elementFromPoint via closest() to the nearest
    // interactive ancestor so hits on child nodes (SVG icons inside a
    // button, span text inside an <a>) still fire the parent's onClick.
    const x = Math.round(targetX);
    const y = Math.round(targetY);
    const clickScript = `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return JSON.stringify({ ok: false, err: 'no element at (${x},${y})' });
  const target = el.closest('button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="switch"], [role="option"], input, textarea, select, label[for], [onclick], [data-clickable]') || el;
  if (!(target instanceof HTMLElement)) {
    return JSON.stringify({ ok: false, err: 'target not HTMLElement', tag: target.tagName });
  }
  try { target.focus({ preventScroll: true }); } catch (_) {}
  const mouse = { bubbles: true, cancelable: true, composed: true, view: window, clientX: ${x}, clientY: ${y}, button: 0 };
  const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, mouse);
  const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  target.dispatchEvent(new PointerCtor('pointerdown', Object.assign({ buttons: 1 }, pointer)));
  target.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, mouse)));
  target.dispatchEvent(new PointerCtor('pointerup', Object.assign({ buttons: 0 }, pointer)));
  target.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, mouse)));
  target.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0, detail: 1 }, mouse)));
  const cls = (target.className || '').toString().slice(0, 80);
  return JSON.stringify({ ok: true, tag: target.tagName, id: target.id || null, cls, title: target.title || null });
})()`;

    const { result } = await this.evalJs(clickScript);
    let parsed: { ok: boolean; err?: string; tag?: string } = { ok: false };
    try {
      parsed = JSON.parse(result);
    } catch {
      throw new Error(`click eval returned unparseable result: ${result.slice(0, 200)}`);
    }
    if (!parsed.ok) {
      throw new Error(`click failed at (${x},${y}): ${parsed.err || 'unknown'}`);
    }
    return { ok: true, element: parsed.tag };
  }

  async type(text: string): Promise<{ ok: boolean; warning?: string }> {
    const run = async (): Promise<{ ok: boolean; warning?: string }> => {
      try {
        await this.sendCommand('type_into_focused', {
          window_label: DEFAULT_WINDOW_LABEL,
          text,
          delay_ms: 0,
        });
        return { ok: true };
      } catch (error) {
        if (!isMutationAckTimeout(error)) throw error;
        const verified = await this.focusedValueEndsWith(text).catch(() => false);
        if (!verified) throw error;
        return {
          ok: true,
          warning: `type ack timed out after the text landed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    const queued = this.typeQueue.then(run, run);
    this.typeQueue = queued.catch(() => undefined);
    return queued;
  }

  async scroll(opts: {
    direction?: 'up' | 'down';
    amount?: number | 'half';
    toRef?: number;
    toTop?: boolean;
    toBottom?: boolean;
  }): Promise<{ ok: boolean; warning?: string }> {
    try {
      await this.sendCommand('scroll_page', {
        window_label: DEFAULT_WINDOW_LABEL,
        direction: opts.direction,
        amount: opts.amount,
        to_ref: opts.toRef,
        to_top: opts.toTop,
        to_bottom: opts.toBottom,
      });
      return { ok: true };
    } catch (error) {
      if (!isMutationAckTimeout(error)) throw error;
      return {
        ok: true,
        warning: `scroll ack timed out after dispatch; treating as delivered to avoid duplicate scrolling: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async pressKey(opts: {
    key: string;
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
  }): Promise<{ ok: boolean }> {
    // No native key command in the plugin — dispatch a synthetic KeyboardEvent
    // through eval (same approach as navigate). Fires o8's own React keybindings
    // (Cmd+K, Esc-to-close, Enter); it won't trigger OS-level shortcuts.
    const init = JSON.stringify({
      key: opts.key,
      code: opts.key,
      metaKey: !!opts.meta,
      ctrlKey: !!opts.ctrl,
      shiftKey: !!opts.shift,
      altKey: !!opts.alt,
      bubbles: true,
      cancelable: true,
    });
    await this.evalJs(`(() => {
      const el = document.activeElement || document.body;
      const init = ${init};
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return 'ok';
    })()`);
    return { ok: true };
  }

  async readPage(): Promise<{ text: string }> {
    const result = await this.evalJs(`(() => {
      const root = document.body || document.documentElement;
      return (root?.innerText || '').trim();
    })()`);
    return { text: result.result };
  }

  // Fixed app-owned bridge calls only. execute_js is never reconnect-replayed.
  private async composerImageCall(method: 'inspect' | 'attach' | 'status', argument: unknown = null): Promise<Record<string, unknown>> {
    const code = `(() => { const bridge = window.__o8ComposerImages__; return JSON.stringify(bridge ? bridge.${method}(${JSON.stringify(argument)}) : {status:'error',code:'bridge_unavailable'}); })()`;
    const { result } = await this.evalJs(code);
    const data = JSON.parse(result) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || !['ready', 'pending', 'completed', 'error'].includes(String(data.status))) {
      throw createCodedError('Invalid composer bridge receipt', 'bridge_unavailable');
    }
    if (data.status !== 'error') {
      if (typeof data.allow_background !== 'boolean' || typeof data.document_visibility !== 'string' || (method !== 'status' && data.allow_background !== ((argument as { allow_background?: boolean }).allow_background === true))) {
        throw createCodedError('Uncorrelated attachment mode', 'outcome_unknown');
      }
      if (method === 'inspect' && data.status !== 'ready') throw createCodedError('Invalid inspection receipt', 'bridge_unavailable');
      if (method !== 'inspect') {
        const id = method === 'status' ? argument : (argument as ImageAttachmentRequest).request_id;
        if (data.status === 'ready' || data.request_id !== id || (method === 'attach' && data.composer_id !== (argument as ImageAttachmentRequest).composer_id)) {
          throw createCodedError('Uncorrelated attachment receipt', 'outcome_unknown');
        }
      }
    }
    return data;
  }
  async inspectImageComposer(options: { allow_background?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.composerImageCall('inspect', validateComposerInspection(options));
  }
  async attachComposerImage(request: ImageAttachmentRequest): Promise<Record<string, unknown>> {
    return this.composerImageCall('attach', validateImageAttachment(request));
  }
  async imageAttachmentStatus(requestId: string): Promise<Record<string, unknown>> {
    return this.composerImageCall('status', imageRequestId(requestId));
  }

  async evalJs(code: string): Promise<{ result: string }> {
    const result = await this.sendCommand('execute_js', {
      window_label: DEFAULT_WINDOW_LABEL,
      code,
    });
    return { result: normalizeTextResult(result) };
  }

  async queueEvalJs(code: string): Promise<void> {
    await this.queueCommand('execute_js', {
      window_label: DEFAULT_WINDOW_LABEL,
      code,
    });
  }
  private async focusedValueEndsWith(text: string): Promise<boolean> {
    const suffix = JSON.stringify(text);
    const raw = await this.evalJs(`(() => {
      const el = document.activeElement;
      if (!el) return 'false';
      const value = typeof el.value === 'string' ? el.value : (el.textContent || '');
      return value.endsWith(${suffix}) ? 'true' : 'false';
    })()`);
    return raw.result === 'true';
  }

  async waitFor(opts: { selector: string; text?: string; timeoutMs?: number }): Promise<{
    ok: boolean;
    matchedText: string;
    elapsedMs: number;
  }> {
    const selector = opts.selector;
    const expectedText = typeof opts.text === 'string' && opts.text.length > 0 ? opts.text : null;
    const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, 25_000)
      : 10_000;

    // The Rust execute_js bridge does not await Promises, so we poll from Node.
    // Each tick runs a synchronous scan in the webview; the sleep happens here.
    // When `text` is provided, scan every match (querySelectorAll), not just
    // the first — otherwise `button` + text="Orchestrator" never finds the
    // right button.
    const started = Date.now();
    const deadline = started + timeoutMs;
    const probeCode = expectedText === null
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return '__O8_WAIT_NOT_FOUND__';
          const text = (el.innerText || el.textContent || '').trim();
          return '__O8_WAIT_FOUND__' + text.slice(0, 200);
        })()`
      : `(() => {
          const needle = ${JSON.stringify(expectedText)};
          const candidates = document.querySelectorAll(${JSON.stringify(selector)});
          for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text.includes(needle)) {
              return '__O8_WAIT_FOUND__' + text.slice(0, 200);
            }
          }
          return '__O8_WAIT_NOT_FOUND__';
        })()`;

    while (true) {
      const raw = await this.evalJs(probeCode);
      const result = raw.result;
      if (typeof result === 'string' && result.startsWith('__O8_WAIT_FOUND__')) {
        return {
          ok: true,
          matchedText: result.slice('__O8_WAIT_FOUND__'.length),
          elapsedMs: Date.now() - started,
        };
      }
      if (Date.now() >= deadline) {
        throw createCodedError(
          `wait_for timed out after ${Date.now() - started}ms (selector: ${selector}${expectedText ? `, text: ${expectedText}` : ''})`,
          'ETIMEDOUT',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async navigate(path: string): Promise<{ ok: boolean }> {
    // Drive the renderer's Next.js App Router via the NavigationBridge
    // (mounted in the root layout). This is the only path that performs
    // a true SPA transition — `webview.navigate(url)` triggers a full
    // HTTP reload and `pushState + popstate` doesn't always cross
    // page-route segments (eg. /context-graph ↔ /dashboard), which
    // leaves Next.js mid-route and freezes the JS thread for 10–30s.
    // See issue #863.
    //
    // The pushState + popstate path is kept as a fallback for the few
    // moments before NavigationBridge mounts after a cold launch.
    //
    // `navigateWebview()` exposes the real `navigate_webview` command for the
    // cases this cannot serve — hard reload, a URL outside the app's routes,
    // an overlay window. Routing o8's own page-to-page moves through it is
    // the regression this method exists to avoid.
    await this.evalJs(`(() => {
      const next = new URL(${JSON.stringify(path)}, window.location.origin);
      const route = \`\${next.pathname}\${next.search}\${next.hash}\`;
      const bridge = (window).__o8Navigate__;
      if (typeof bridge === 'function') {
        bridge(route);
        return route;
      }
      window.history.pushState(window.history.state, '', route);
      const event = typeof PopStateEvent === 'function'
        ? new PopStateEvent('popstate', { state: window.history.state })
        : new Event('popstate');
      window.dispatchEvent(event);
      return route;
    })()`);
    return { ok: true };
  }

  /**
   * Every window the app owns, with `visible` / `focused` / position / size.
   *
   * This is the only way to see o8's overlay windows (`dock`, `spatial-ink`,
   * `agent-partials`). They are separate always-on-top, transparent,
   * click-through windows, so nothing in the main window's document reports
   * whether they are on screen. It is also how you catch an overlay holding
   * focus while `main` does not: keystrokes disappear into a click-through
   * window and the DOM shows nothing that explains it. `manageWindow({
   * operation: 'focus' })` is the fix once you can see it.
   */
  async listWindows(): Promise<{ windows: O8WindowInfo[] }> {
    const data = unwrapCommandData(await this.sendCommand('list_windows', {}));
    return { windows: Array.isArray(data.windows) ? data.windows as O8WindowInfo[] : [] };
  }

  /** Package name/version, OS, every window, and monitors with scale factors. */
  async getAppInfo(): Promise<O8AppInfo> {
    return unwrapCommandData(await this.sendCommand('get_app_info', {})) as O8AppInfo;
  }

  /**
   * Show / hide / focus / center / minimize a window by label.
   *
   * The wire field is `operation`, not `action` — `navigate_webview` and the
   * `manage_*` commands take `action`, this one does not. Encoded here so
   * callers never have to discover it through `missing field 'operation'`.
   */
  async manageWindow(opts: {
    operation: O8WindowOperation;
    windowLabel?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): Promise<{ ok: boolean }> {
    await this.sendCommand('manage_window', {
      window_label: opts.windowLabel ?? DEFAULT_WINDOW_LABEL,
      operation: opts.operation,
      ...(typeof opts.x === 'number' ? { x: opts.x } : {}),
      ...(typeof opts.y === 'number' ? { y: opts.y } : {}),
      ...(typeof opts.width === 'number' ? { width: opts.width } : {}),
      ...(typeof opts.height === 'number' ? { height: opts.height } : {}),
    });
    return { ok: true };
  }

  /**
   * Real webview navigation through the Rust `navigate_webview` command.
   *
   * Deliberately separate from `navigate(path)`, which stays the in-app SPA
   * route transition (see the comment there and issue #863). `navigate`
   * here performs a genuine document load, so use it for a hard reload, a URL
   * outside the app's own routes, or an overlay window — not for moving
   * between o8's own pages, which this would freeze mid-route.
   */
  async navigateWebview(opts: {
    action: O8NavigateWebviewAction;
    url?: string;
    windowLabel?: string;
  }): Promise<{ action?: string; url?: string }> {
    const data = unwrapCommandData(await this.sendCommand('navigate_webview', {
      window_label: opts.windowLabel ?? DEFAULT_WINDOW_LABEL,
      action: opts.action,
      ...(typeof opts.url === 'string' ? { url: opts.url } : {}),
    }));
    return data as { action?: string; url?: string };
  }

  /** Emit, target, listen on or sniff the internal Tauri event bus. */
  async manageEvents(opts: {
    action: O8EventsAction;
    event?: string;
    target?: string;
    payload?: unknown;
    durationMs?: number;
  }): Promise<Record<string, unknown>> {
    return unwrapCommandData(await this.sendCommand('manage_events', {
      action: opts.action,
      ...(typeof opts.event === 'string' ? { event: opts.event } : {}),
      ...(typeof opts.target === 'string' ? { target: opts.target } : {}),
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      ...(typeof opts.durationMs === 'number' ? { duration_ms: opts.durationMs } : {}),
    }));
  }

  /**
   * Restart the app. The Rust side clamps the delay to 100–5000ms.
   *
   * `restart_app` is the one command whose payload is camelCase (`delayMs`);
   * every other command takes snake_case fields. Sending `delay_ms` here is
   * silently ignored and you get the 500ms default.
   */
  async restartApp(opts: { delayMs?: number } = {}): Promise<{ ok: boolean; message?: string }> {
    const data = unwrapCommandData(await this.sendCommand('restart_app', {
      ...(typeof opts.delayMs === 'number' ? { delayMs: opts.delayMs } : {}),
    }));
    return { ok: true, message: typeof data.message === 'string' ? data.message : undefined };
  }

  cancel(): void {
    this.cancelled = true;
    this.dispose();
  }

  dispose(): void {
    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      clearTimeout(pending.timeout);
      pending.reject(createCodedError('Socket connection closed', this.cancelled ? 'ECANCELED' : 'ECONNRESET'));
      this.pending.delete(requestId);
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.isConnected = false;
    this.connectPromise = null;
    this.buffer = '';
  }

  private async sendCommand(command: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.withReconnectRetry(
      () => this.sendCommandOnce(command, payload),
      RECONNECT_RETRY_SAFE_COMMANDS.has(command),
    );
  }

  private async sendCommandOnce(command: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    this.authToken = this.resolveAuthToken();

    if (!this.socket) {
      throw new Error('Socket client not initialized');
    }

    const socket = this.socket;

    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new WebviewBridgeError('webview_bridge_unresponsive'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
        timeout,
      });

      const request = JSON.stringify({
        command,
        payload,
        id: requestId,
        ...(this.authToken ? { authToken: this.authToken } : {}),
      }) + '\n';

      socket.write(request, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(this.normalizeConnectionError(error));
      });
    });
  }

  private async queueCommand(command: string, payload: Record<string, unknown>): Promise<void> {
    await this.ensureConnected();
    this.authToken = this.resolveAuthToken();
    if (!this.socket) {
      throw new Error('Socket client not initialized');
    }
    await queueCommandWrite({
      socket: this.socket,
      pending: this.pending,
      command,
      payload,
      authToken: this.authToken,
      timeoutMs: REQUEST_TIMEOUT_MS,
      normalizeConnectionError: (error) => this.normalizeConnectionError(error),
    });
  }

  private async withReconnectRetry<T>(operation: () => Promise<T>, retrySafe: boolean): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code = getErrorCode(error);
      // Native JS failures share the auth error's string-only envelope. Never
      // treat its text as proof that an arbitrary eval did not execute.
      if (retrySafe && error instanceof WebviewBridgeError && code === 'webview_auth_rejected') {
        return operation();
      }
      if (code !== 'EPIPE' && code !== 'ECONNRESET') {
        throw error;
      }

      this.dispose();
      if (!retrySafe) {
        // The socket dropped after the write — on the Rust side the action
        // usually ALREADY fired. Re-running would type the text twice or
        // double-fire a click; surface the uncertainty instead.
        throw new WebviewMutationUncertainError();
      }
      return operation();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.cancelled) throw createCodedError('Webview read cancelled', 'ECANCELED');
    if (this.isConnected && this.socket && !this.socket.destroyed) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.authToken = this.resolveAuthToken();

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let settled = false;

      this.socket = socket;
      this.isConnected = false;
      this.buffer = '';

      socket.on('connect', () => {
        settled = true;
        this.isConnected = true;
        this.connectPromise = null;
        resolve();
      });

      socket.on('data', (chunk) => {
        this.handleData(chunk);
      });

      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          this.socket = null;
          reject(this.normalizeConnectionError(error));
        }
      });

      socket.on('close', () => {
        this.isConnected = false;
        this.connectPromise = null;
        if (this.socket === socket) {
          this.socket = null;
        }

        const pendingError = createCodedError('Socket connection closed', 'ECONNRESET');
        for (const [requestId, pending] of Array.from(this.pending.entries())) {
          clearTimeout(pending.timeout);
          pending.reject(pendingError);
          this.pending.delete(requestId);
        }

        this.buffer = '';

        if (!settled) {
          settled = true;
          reject(pendingError);
        }
      });
    });

    return this.connectPromise;
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const jsonLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!jsonLine.trim()) {
        newlineIndex = this.buffer.indexOf('\n');
        continue;
      }

      try {
        const response = JSON.parse(jsonLine) as SocketResponse;
        let requestId: string | undefined;
        if (typeof response.id === 'string' && this.pending.has(response.id)) {
          requestId = response.id;
        } else if (this.pending.size === 1) {
          // Known plugin seam: some responses come back without the echoed
          // id. With exactly one request in flight the match is unambiguous.
          requestId = this.pending.keys().next().value as string | undefined;
        } else if (this.pending.size > 1) {
          // NEVER guess across multiple in-flight requests — "oldest pending"
          // matching cross-wired results (a screenshot resolving a snapshot
          // call). Drop the frame; the per-request timeout surfaces the loss.
          console.error(
            `[o8-webview] Dropping response with ${typeof response.id === 'string' ? `unknown id ${response.id}` : 'no id'} while ${this.pending.size} requests are pending — refusing to guess the match`,
          );
        }

        if (!requestId) {
          newlineIndex = this.buffer.indexOf('\n');
          continue;
        }

        const pending = this.pending.get(requestId);
        if (!pending) {
          newlineIndex = this.buffer.indexOf('\n');
          continue;
        }

        this.pending.delete(requestId);
        if (response.success === false) {
          pending.reject(this.normalizeResponseError(response.error));
        } else {
          pending.resolve(response.data);
        }
      } catch (error) {
        console.error(`[o8-webview] Failed to parse socket response: ${(error as Error).message}`);
      }

      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private resolveAuthToken(): string {
    try {
      const token = readFileSync(this.tokenPath, 'utf-8').trim();
      if (token) return token;
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(getErrorCode(error) ?? '')) throw new WebviewBridgeError('webview_permission_denied');
    }
    const envToken = process.env.TAURI_MCP_AUTH_TOKEN?.trim();
    if (envToken) return envToken;
    throw new WebviewBridgeError('webview_auth_missing');
  }

  private normalizeConnectionError(error: Error): Error {
    const code = getErrorCode(error);
    if (code === 'ECONNREFUSED' || code === 'ENOENT') {
      return new WebviewBridgeError('webview_bridge_missing');
    }
    if (code === 'EACCES' || code === 'EPERM') return new WebviewBridgeError('webview_permission_denied');
    return createCodedError(error.message, code);
  }

  private normalizeResponseError(error: unknown): Error {
    return nativeWebviewError(error);
  }
}
