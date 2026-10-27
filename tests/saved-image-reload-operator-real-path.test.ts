/** @vitest-environment jsdom */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { basename, join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const pathFixture = vi.hoisted(() => ({ windows: false }));
// Substitute only the read builder's platform join; fixture infrastructure and
// persistence keep the host's real node:path and filesystem semantics.
vi.mock('@/lib/mcp/o8-saved-image-read', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/mcp/o8-saved-image-read')>();
  const { win32 } = await import('node:path');
  return { ...original, savedImageReadScript: (target?: Parameters<typeof original.savedImageReadScript>[0]) => original.savedImageReadScript(target, pathFixture.windows ? win32.join : undefined) };
});
vi.mock('@/lib/pretext', () => ({ usePretextHeight: () => undefined }));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
const directory = mkdtempSync(join(tmpdir(), 'o8-saved-image-'));
const token = 'fixture-operator-credential-0123456789';
const worker = 'fixture-worker-credential-0123456789';
writeFileSync(join(directory, 'ws-token'), token);
writeFileSync(join(directory, 'worker-token'), worker);
const socketPath = join(directory, 'app.sock');
writeFileSync(`${socketPath}.token`, 'fixture-native-auth');
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
vi.stubEnv('TAURI_MCP_AUTH_TOKEN', 'fixture-native-auth');
// jsdom has no layout observer; the transcript navigator only measures with it.
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
const { panelGateMiddleware } = await import('@/middleware');
const { POST } = await import('@/app/api/mcp/route');
const { closeDb } = await import('@/lib/db');
const { persistComposerImages } = await import('@/lib/mobile/orchestrator-image-media');
const { writePersistedLlmChat, readPersistedLlmChat, mapLlmHistoryToMobileTranscript } = await import('@/lib/llm/chat-history-store');
const { ChatMessageList } = await import('@/components/desktop/thoughts/chat-panel/ChatMessageList');
const { GET: mediaGet } = await import('@/app/api/mobile/media/route');
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const [media] = persistComposerImages([{ dataUri: `data:image/png;base64,${image}`, name: 'fixture.png' }]);
const imageId = basename(media.path);
const args = { thread_id: 'fixture-thread', message_id: 'fixture-message', image_id: imageId };
const sockets = new Set<Socket>();
let frame: HTMLIFrameElement;
let root: Root;
let reloads = 0;
let drop = false;
let requests = 0;
let focused = 0;
let sent = 0;
const activeThread = args.thread_id;
const active = true;
let holdReload = false;
let reloadReached: (() => void) | undefined;
async function mount() {
  frame = document.createElement('iframe'); document.body.append(frame);
  const doc = frame.contentDocument!;
  const host = doc.createElement('div'); doc.body.append(host);
  root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frame.contentWindow!.fetch = async (url: RequestInfo | URL) => mediaGet(new NextRequest(`http://localhost${url}`));
  frame.contentWindow!.focus = () => { focused++; };
  const stored = readPersistedLlmChat(args.thread_id)!;
  await act(async () => root.render(createElement(ChatMessageList, {
    displayMessages: mapLlmHistoryToMobileTranscript(stored.history.messages), displayWaiting: false,
    threadId: activeThread, active,
    activeTargetLabel: 'fixture', activeTargetColor: 'blue', thoughtsMutedGlass: '', thoughtsElevatedBorder: '', thoughtsElevatedShadow: '', emptyStateFallback: null,
    onSelectSuggestion: () => { sent++; },
  } as Parameters<typeof ChatMessageList>[0])));
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(doc.querySelector('[data-o8-message-id="fixture-message"] [data-o8-image-source-state="error"]')).not.toBeNull();
  }, { timeout: 2000, interval: 20 });
}
const server = createServer(socket => {
  sockets.add(socket); let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString(); let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      void (async () => {
        requests++;
        expect(request.authToken).toBe('fixture-native-auth');
        expect(request.payload.window_label).toBe('main');
        let data: unknown;
        if (request.command === 'navigate_webview') {
          expect(request.payload).toEqual({ window_label: 'main', action: 'reload' });
          reloads++;
          if (holdReload) { reloadReached?.(); return; }
          act(() => root.unmount()); frame.remove(); await mount();
          data = { action: 'reload' };
        } else {
          expect(request.command).toBe('execute_js');
          const win = frame.contentWindow!;
          data = { result: runInNewContext(request.payload.code, { window: win, document: win.document, location: { hostname: 'localhost', protocol: 'http:' }, crypto: window.crypto, getComputedStyle: win.getComputedStyle.bind(win) }) };
        }
        if (drop && request.command === 'navigate_webview') { socket.destroy(); return; }
        socket.write(JSON.stringify({ id: request.id, success: true, data }) + '\n');
      })();
    }
  });
});
async function rpc(name: string, arguments_: Record<string, unknown> = {}, bearer = token) {
  const request = new NextRequest('http://127.0.0.1/api/mcp', { method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture-call', method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? undefined : { name, arguments: arguments_ } }) });
  const gate = panelGateMiddleware(request);
  if (gate.status !== 200) return { denied: gate.status };
  const result = await (await POST(request)).json();
  return result.result?.content ? JSON.parse(result.result.content[0].text) : result;
}
beforeAll(async () => {
  // Browser fetch/object URL/decode are the jsdom-only boundary substitutes.
  vi.stubGlobal('fetch', async (url: RequestInfo | URL) => mediaGet(new NextRequest(`http://localhost${url}`)));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:http://localhost/fixture-image' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  writePersistedLlmChat(args.thread_id, { messages: [
    { id: args.message_id, role: 'user', content: 'fixture', timestamp: 1, media: [media] },
    { id: 'fixture-file', role: 'user', content: 'file', timestamp: 2, media: [{ ...media, kind: 'file' }] },
    { id: 'fixture-foreign', role: 'user', content: 'foreign', timestamp: 3, media: [{ ...media, path: `https://example.test/orchestrator-images/${imageId}` }] },
  ] });
  await mount(); await new Promise<void>(resolve => server.listen(socketPath, resolve));
});
afterAll(async () => {
  act(() => root.unmount()); frame.remove(); for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
describe('registered saved image/reload HTTP -> authenticated socket -> persisted React renderer', () => {
  it('discovers both bounded controls and denies anonymous/worker credentials before socket access', async () => {
    const list = await rpc('tools/list');
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['o8_view_saved_image', 'o8_view_hard_reload']));
    const before = requests;
    for (const bearer of ['', worker, 'invalid-token']) for (const name of ['o8_view_saved_image', 'o8_view_hard_reload']) expect(await rpc(name, args, bearer)).toHaveProperty('denied');
    expect(requests).toBe(before);
  });
  it('reports opaque-media refusal before and after reload while preserving the saved upload', async () => {
    const response = await mediaGet(new NextRequest(`http://localhost/api/mobile/media?path=${encodeURIComponent(media.path)}`));
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'binary_preview_refused', redaction: { version: 1 } });
    const before = await rpc('o8_view_saved_image', args);
    expect(before).toMatchObject({ status: 'error', code: 'image_decode_failed', decoded: false, natural_width: 0 });
    const receipt = await rpc('o8_view_hard_reload', { operation: 'reload', document_id: before.document_id });
    expect(receipt).toMatchObject({ status: 'pending', action_dispatched: true, document_id: before.document_id });
    const observation = await rpc('o8_view_hard_reload', { operation: 'observe', document_id: before.document_id });
    expect(observation).toMatchObject({ status: 'ready', document_changed: true });
    expect(observation.document_id).not.toBe(before.document_id);
    expect(readPersistedLlmChat(args.thread_id)?.history.messages[0].media).toEqual([media]);
    expect(readFileSync(media.path).toString('base64')).toBe(image);
    expect(await rpc('o8_view_saved_image', args)).toMatchObject({ status: 'error', code: 'image_decode_failed', decoded: false, image_id: imageId, thread_id: args.thread_id });
    expect(focused).toBe(0); expect(sent).toBe(0);
  });
  it('refuses bad schema, wrong chat/message/image, inactive and ambiguous targets, foreign/direct URLs and non-images', async () => {
    const before = reloads;
    const beforeRequests = requests;
    for (const invalid of [{ ...args, url: 'https://example.test' }, { ...args, image_id: '../image.png' }, { ...args, message_id: { code: 'bad' } }, { ...args, thread_id: '' }]) expect(await rpc('o8_view_saved_image', invalid)).toMatchObject({ code: 'invalid_schema' });
    expect(requests).toBe(beforeRequests);
    for (const extra of [{ url: 'https://example.test' }, { code: 'anything' }, { window_label: 'other' }]) expect(await rpc('o8_view_hard_reload', { operation: 'reload', ...extra })).toMatchObject({ status: 'error', code: 'invalid_schema' });
    expect(await rpc('o8_view_saved_image', { ...args, thread_id: 'wrong' })).toMatchObject({ code: 'wrong_thread' });
    expect(await rpc('o8_view_saved_image', { ...args, message_id: 'fixture-file' })).toMatchObject({ code: 'missing_image' });
    expect(await rpc('o8_view_saved_image', { ...args, message_id: 'fixture-foreign' })).toMatchObject({ code: 'foreign_image' });
    expect(await rpc('o8_view_hard_reload', { operation: {}, document_id: crypto.randomUUID() })).toMatchObject({ code: 'invalid_schema' });
    expect(await rpc('o8_view_saved_image', { ...args, message_id: 'missing' })).toMatchObject({ code: 'missing_message' });
    expect(await rpc('o8_view_saved_image', { ...args, image_id: 'f'.repeat(64) + '.png' })).toMatchObject({ code: 'missing_image' });
    const target = frame.contentDocument!.querySelector('[data-o8-chat-thread]')!;
    target.setAttribute('data-o8-active-chat', 'false'); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'no_active_chat' }); target.setAttribute('data-o8-active-chat', 'true');
    const message = target.querySelector('[data-o8-message-id]')!;
    const duplicateMessage = message.cloneNode(true); message.parentElement!.append(duplicateMessage); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'ambiguous_message' }); duplicateMessage.parentNode!.removeChild(duplicateMessage);
    const clone = target.cloneNode(true); target.parentElement!.append(clone); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'ambiguous_chat' }); clone.parentNode!.removeChild(clone);
    const mediaTarget = frame.contentDocument!.querySelector('[data-o8-message-id="fixture-message"] [data-o8-saved-image]')!;
    const duplicateImage = mediaTarget.cloneNode(true); mediaTarget.parentElement!.append(duplicateImage); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'ambiguous_image' }); duplicateImage.parentNode!.removeChild(duplicateImage);
    const path = mediaTarget.getAttribute('data-o8-media-path')!;
    mediaTarget.setAttribute('data-o8-media-path', 'https://example.test/' + imageId); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'foreign_image' }); mediaTarget.setAttribute('data-o8-media-path', path);
    const img = frame.contentDocument!.createElement('img'); mediaTarget.append(img); img.setAttribute('src', 'https://example.test/image.png'); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'foreign_image' }); img.setAttribute('src', 'blob:http://localhost/fixture-image');
    img.remove(); mediaTarget.setAttribute('data-o8-image-source-state', 'loading'); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ status: 'pending', decoded: false });
    mediaTarget.setAttribute('data-o8-image-source-state', 'error'); expect(await rpc('o8_view_saved_image', args)).toMatchObject({ status: 'error', code: 'image_decode_failed' });
    expect(await rpc('o8_view_hard_reload', { operation: 'reload', document_id: crypto.randomUUID() })).toMatchObject({ code: 'stale_document', action_dispatched: false });
    expect(reloads).toBe(before);
  });
  it('keeps reload uncertainty truthful after response loss and never replays', async () => {
    const observation = await rpc('o8_view_hard_reload', { operation: 'observe' }); const before = reloads; drop = true;
    expect(await rpc('o8_view_hard_reload', { operation: 'reload', document_id: observation.document_id })).toMatchObject({ status: 'unknown', action_dispatched: null });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(reloads).toBe(before + 1); drop = false;
    expect(await rpc('o8_view_hard_reload', { operation: 'observe', document_id: observation.document_id })).toMatchObject({ document_changed: true });
    expect(reloads).toBe(before + 1);
  });
  it('reports timeout uncertainty without same-document completion or replay', async () => {
    const observation = await rpc('o8_view_hard_reload', { operation: 'observe' }); const before = reloads;
    holdReload = true;
    const reached = new Promise<void>(resolve => { reloadReached = resolve; });
    vi.useFakeTimers();
    try {
      const pending = rpc('o8_view_hard_reload', { operation: 'reload', document_id: observation.document_id });
      await reached;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await pending).toMatchObject({ status: 'unknown', document_id: observation.document_id, action_dispatched: null });
      expect(reloads).toBe(before + 1);
    } finally { vi.useRealTimers(); holdReload = false; reloadReached = undefined; }
    expect(await rpc('o8_view_hard_reload', { operation: 'observe', document_id: observation.document_id })).toMatchObject({ document_changed: false });
    expect(reloads).toBe(before + 1);
  });

  it('reads Windows-shaped persisted uploads through the real entry with exact own-root/URL guards', async () => {
    const previousRoot = process.env.CORTEX_IDE_MEDIA_ROOT;
    const stored = readPersistedLlmChat(args.thread_id)!.history;
    const windowsRoot = String.raw`C:\fixture\media`;
    const windowsPath = win32.join(windowsRoot, 'orchestrator-images', imageId);
    try {
      pathFixture.windows = true; vi.stubEnv('CORTEX_IDE_MEDIA_ROOT', windowsRoot);
      writePersistedLlmChat(args.thread_id, { ...stored, messages: stored.messages.map(message => message.id === args.message_id ? { ...message, media: [{ ...media, path: windowsPath }] } : message) }, { replace: true });
      // Linux cannot open Windows drive paths. Translate only this exact fixture
      // upload at the filesystem boundary; the normal authenticated media route,
      // React renderer, builder, client and registered HTTP handler still run.
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.searchParams.get('path') === windowsPath) url.searchParams.set('path', media.path);
        return mediaGet(new NextRequest(url));
      });
      act(() => root.unmount()); frame.remove(); await mount();
      const result = await rpc('o8_view_saved_image', args);
      expect(result).toMatchObject({ status: 'error', code: 'image_decode_failed', decoded: false, image_id: imageId, natural_width: 0 });
      const target = frame.contentDocument!.querySelector('[data-o8-message-id="fixture-message"] [data-o8-saved-image]')!;
      expect(target.getAttribute('data-o8-media-path')).toBe(windowsPath);
      for (const foreign of [win32.join('D:\\foreign', 'orchestrator-images', imageId), windowsPath.replace('C:', 'c:'), `${windowsRoot}/orchestrator-images/${imageId}`, `https://example.test/orchestrator-images/${imageId}`]) {
        target.setAttribute('data-o8-media-path', foreign);
        expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'foreign_image' });
      }
      target.setAttribute('data-o8-media-path', windowsPath);
      const img = frame.contentDocument!.createElement('img'); target.append(img); img.setAttribute('src', 'https://example.test/image.png');
      expect(await rpc('o8_view_saved_image', args)).toMatchObject({ code: 'foreign_image' });
      expect(await rpc('o8_view_saved_image', { ...args, message_id: 'fixture-foreign' })).toMatchObject({ code: 'foreign_image' });
      for (const bearer of ['', worker]) expect(await rpc('o8_view_saved_image', args, bearer)).toHaveProperty('denied');
    } finally {
      pathFixture.windows = false;
      if (previousRoot === undefined) delete process.env.CORTEX_IDE_MEDIA_ROOT; else process.env.CORTEX_IDE_MEDIA_ROOT = previousRoot;
      writePersistedLlmChat(args.thread_id, stored, { replace: true });
      vi.stubGlobal('fetch', async (url: RequestInfo | URL) => mediaGet(new NextRequest(`http://localhost${url}`)));
      act(() => root.unmount()); frame.remove(); await mount();
    }
  });

});
