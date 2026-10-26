// @vitest-environment jsdom
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement, useRef, useLayoutEffect, type ChangeEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { WebSocket as Socket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ url: '', sockets: [] as Socket[] }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async original => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => { const socket = new Socket(transport.url); transport.sockets.push(socket); return socket; },
}));
vi.mock('@/components/desktop/thoughts/chat-panel/useDurableComposerQueue', () => ({
  useDurableComposerQueue: () => ({ items: [], removing: new Set(), ready: true, error: null, hasPending: () => false, canSteer: false }),
}));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/pretext', () => ({ usePretextHeight: () => undefined }));
vi.mock('@/lib/llm/thread-auto-title', () => ({ maybeQueueThreadAutoTitle: vi.fn() }));
const directory = mkdtempSync(join(tmpdir(), 'o8-image-delivery-'));
const repoPath = join(directory, 'repo');
const capture = join(repoPath, 'received.jsonl');
const token = crypto.randomUUID();
const releaseImage = join(repoPath, 'release-image');
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory); vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'state.db'));
const { useOrchestratorStream } = await import('@/components/desktop/thoughts/useOrchestratorStream');
const { useThoughtsComposerAttachments } = await import('@/components/desktop/thoughts/chat-panel/useThoughtsComposerAttachments');
const { useDefaultComposerSendBuffer } = await import('@/components/desktop/thoughts/chat-panel/useDefaultComposerSendBuffer');
const { useComposerDraftValue } = await import('@/components/desktop/thoughts/chat-panel/composer-draft-store');
const { ComposerUploadStatus } = await import('@/components/desktop/thoughts/chat-panel/ComposerUploadStatus');
const { ChatMessageList } = await import('@/components/desktop/thoughts/chat-panel/ChatMessageList');
const { resolveDisplayMessages } = await import('@/components/desktop/thoughts/chat-panel/resolve-display-messages');
const { deserializeStoredTranscript } = await import('@/lib/transcripts/history-serde');
const { GET: historyGet } = await import('@/app/api/v2/chat-history/route');
const { GET: mediaGet } = await import('@/app/api/mobile/media/route');
const { panelGateMiddleware } = await import('@/middleware');
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
let root: Root; let host: HTMLDivElement; let server: Server; let worker: ChildProcess;
let output = ''; let threadId: string; let backend = 'codex'; let readFails = false;
let mode: 'single' | 'fleet' = 'fleet';
let admissionGate: Promise<boolean> | undefined;
let initial: import('@/lib/mobile/types').MobileTranscriptEntry[] = [];
let stream: ReturnType<typeof useOrchestratorStream>;
let upload: ReturnType<typeof useThoughtsComposerAttachments>;
let ordinal = 0;
let readCompletions = 0;
const mediaReads: Uint8Array[] = [];

const BrowserFileReader = globalThis.FileReader;
class Reader extends BrowserFileReader {
  constructor() { super(); this.addEventListener('loadend', () => { readCompletions += 1; }); }
  readAsDataURL(file: Blob) {
    if (readFails) queueMicrotask(() => this.dispatchEvent(new ProgressEvent('error')));
    else super.readAsDataURL(file);
  }
}
function Harness() {
  const draftKey = `fixture-image-${threadId}`;
  const { value: input, setValue: setInput } = useComposerDraftValue(draftKey, 'input', '');
  const latestInputRef = useRef(input);
  useLayoutEffect(() => { latestInputRef.current = input; }, [input]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachments = useThoughtsComposerAttachments({ draftKey });
  const result = useOrchestratorStream(repoPath, { threadId, hasHistory: initial.length > 0 });
  useLayoutEffect(() => { upload = attachments; stream = result; }, [attachments, result]);
  const buffer = useDefaultComposerSendBuffer({ active: true, backend, busy: false, threadId, repoPath,
    attachedImages: attachments.attachedImages, latestInputRef, inputRef, setInput,
    addAttachedImage: attachments.addAttachedImage, clearAttachments: attachments.clearAttachments,
    uploadError: attachments.uploadError, uploading: attachments.uploading,
    dispatch: (text, images) => result.send(text, { backend: backend as 'codex', model: 'gpt-5.6-sol', orchestrationMode: mode, attachments: images, beforeSend: admissionGate ? () => admissionGate! : undefined }),
    interrupt: result.interrupt, undoSend: result.undoSend,
    captureQueuedSend: () => { throw new Error('No queued turn in this fixture'); }, shouldBypass: () => false, sendUnbuffered: () => {},
  });
  const messages = resolveDisplayMessages({ historyEntries: initial, chatMessages: [], streamMessages: result.messages });
  return createElement('div', null,
    // eslint-disable-next-line react-hooks/refs -- createElement forwards this ref to the textarea without reading it.
    createElement('textarea', { ref: (node: HTMLTextAreaElement | null) => { inputRef.current = node; }, value: input, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setInput(event.currentTarget.value) }),
    createElement('input', { type: 'file', onChange: event => { if (event.target.files) void attachments.processFiles(event.target.files); } }),
    ...attachments.attachedImages.map((item, index) => createElement('img', { key: index, src: item.dataUri, alt: item.name })),
    createElement('button', { onClick: buffer.handleSend }, 'Send'),
    createElement('div', { role: 'alert' }, buffer.attachmentError),
    createElement(ComposerUploadStatus, { uploading: attachments.uploading, failed: attachments.failedUploads.length > 0, onRetry: attachments.retryFailedUploads, onDiscard: attachments.discardFailedUploads }),
    createElement(ChatMessageList, { logLabel: 'Image conversation', active: true, displayMessages: messages, displayWaiting: result.status === 'busy', threadId,
      activeTargetLabel: 'Agent', activeTargetColor: 'var(--t-text)', thoughtsMutedGlass: '', thoughtsElevatedBorder: '', thoughtsElevatedShadow: '', emptyStateFallback: null }),
  );
}
async function eventually(check: () => void, timeout = 15000) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); check(); }, { timeout, interval: 30 });
}
async function freePort() { const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve())); return port; }
function received(): Array<{ images: string[]; args: string[] }> { return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; }
async function saved() { const response = await historyGet(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${threadId}`)); return response.json(); }
async function mount() { root = createRoot(host); await act(async () => root.render(createElement(Harness))); await eventually(() => expect(stream.status).toBe('ready')); }
async function attach(size = 1, waitForRead = true) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const bytes = size === 1 ? Uint8Array.from(atob(image), value => value.charCodeAt(0)) : 'x'.repeat(size);
  const file = new File([bytes], 'fixture.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  if (waitForRead && !readFails && size === 1) await eventually(() => expect(host.querySelector('img[alt="fixture.png"]')).not.toBeNull());
}
async function send() {
  const input = host.querySelector('textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Inspect the selected image'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Send')!.click());
}

beforeAll(async () => {
  mkdirSync(repoPath); execFileSync('git', ['init', '-q', repoPath]);
  writeFileSync(join(directory, 'ws-token'), token);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'fixture-repo', name: 'fixture', localPath: repoPath }] }));
  const cli = join(directory, 'fixture-cli.mjs');
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using fixture'); process.exit(0); }
if (!args.includes('exec')) process.exit(0);
const images = args.flatMap((arg, index) => arg === '--image' ? [readFileSync(args[index + 1]).toString('base64')] : []);
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args, images}) + '\\n');
console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture-image-thread'}));
console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'Image received'}}));
while (images.length && !existsSync(${JSON.stringify(releaseImage)})) await new Promise(resolve => setTimeout(resolve, 10));
console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}));
`); chmodSync(cli, 0o700);
  const apiPort = await freePort(); const wsPort = await freePort();
  server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(request.url === '/api/setup/identity' ? { configured: false } : { ready: true })); });
  server.listen(apiPort, '127.0.0.1'); await once(server, 'listening');
  worker = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], { cwd: process.cwd(), env: { ...process.env,
    O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort), O8_CODEX_BIN: cli, O8_CLAUDE_CODE_BIN: cli,
    CORTEX_IDE_OWNED_CODEX_ROOT: join(directory, 'runtime'), O8_SUBSCRIPTION_PROFILE: 'both', O8_WORKER_SANDBOX: '0', O8_CRASH_SURVIVABLE_WORKERS: '0',
    NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_SKIP_PRELAUNCH_TYPECHECK: '1',
  } });
  worker.stdout?.on('data', chunk => { output += String(chunk); }); worker.stderr?.on('data', chunk => { output += String(chunk); });
  await vi.waitFor(() => expect(output).toContain('WebSocket server listening'), { timeout: 60000 });
  transport.url = `ws://127.0.0.1:${wsPort}/ws?token=${token}`;
}, 90000);
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('FileReader', Reader);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (String(url).startsWith('/api/mobile/media')) {
      const request = new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${token}` } });
      const gate = panelGateMiddleware(request); const result = gate.status === 200 ? await mediaGet(request) : gate;
      mediaReads.push(new Uint8Array(await result.clone().arrayBuffer())); return result;
    }
    if (String(url).includes('/api/v2/chat-history?')) return historyGet(new NextRequest(`http://localhost${url}`));
    return Response.json({});
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:fixture-image' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  localStorage.clear(); threadId = `thoughts-image-delivery-${++ordinal}`; initial = []; backend = 'codex'; readFails = false; mode = 'fleet'; admissionGate = undefined;
  host = document.createElement('div'); document.body.append(host); await mount();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); for (const socket of transport.sockets.splice(0)) socket.close(); vi.unstubAllGlobals(); });
afterAll(async () => {
  if (worker?.exitCode === null) { worker.kill('SIGTERM'); await once(worker, 'exit'); }
  server?.closeAllConnections(); if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  const { closeDb } = await import('@/lib/db'); closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

for (const selectedMode of ['fleet', 'single'] as const) it.skipIf(selectedMode === 'single' && process.platform !== 'darwin').each([false, true])(`delivers image bytes to the selected CLI and reopens protected media (${selectedMode}, resume=%s)`, async resume => {
  mode = selectedMode;
  if (resume) { const before = received().length; await send(); await eventually(() => expect(received()).toHaveLength(before + 1)); await eventually(() => expect(stream.status).toBe('ready')); }
  const count = received().length; rmSync(releaseImage, { force: true });
  await attach(); expect(host.querySelector('img[alt="fixture.png"]')).not.toBeNull();
  await send();
  await eventually(() => expect(host.querySelector('[role="log"] img')).not.toBeNull());
  await eventually(() => expect(received()).toHaveLength(count + 1));
  expect(received().at(-1)?.images).toEqual([image]);
  expect(stream.status).toBe('busy');
  expect(host.querySelector('[role="log"] img')).not.toBeNull();
  writeFileSync(releaseImage, 'finish');
  expect(received().at(-1)?.args.includes('resume')).toBe(resume);
  await eventually(() => expect(stream.status).toBe('ready'));
  const history = await saved();
  const user = history.messages.filter((entry: { role: string }) => entry.role === 'user').at(-1);
  expect(user.media[0]).toMatchObject({ kind: 'image', name: 'fixture.png' });
  expect(JSON.stringify(history)).not.toContain('data:image/'); expect(JSON.stringify(history)).not.toContain(image);
  expect(JSON.stringify(user.media).length).toBeLessThan(1000);
  initial = deserializeStoredTranscript(history.messages); await act(async () => root.unmount()); await mount();
  await eventually(() => expect(host.querySelector('[role="log"] img')).not.toBeNull());
  await eventually(() => expect(mediaReads.some(bytes => Buffer.from(bytes).toString('base64') === image)).toBe(true));
  const denied = panelGateMiddleware(new NextRequest(`http://localhost/api/mobile/media?path=${encodeURIComponent(user.media[0].path)}`));
  expect(denied.status).not.toBe(200);
}, 45000);

it.each(['read', 'size'] as const)('keeps the draft and never starts a text-only worker when image upload fails: %s', async failure => {
  const count = received().length; readFails = failure === 'read'; await attach(failure === 'size' ? 6 * 1024 * 1024 : 1);
  await send();
  expect(host.querySelector('textarea')?.value).toBe('Inspect the selected image');
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/image|upload/i);
  expect(received()).toHaveLength(count);
  expect((await saved()).messages ?? []).toEqual([]);
  if (failure === 'read') {
    readFails = false; await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Retry image upload')!.click());
    await eventually(() => expect(host.querySelector('img[alt="fixture.png"]')).not.toBeNull());
  }
});

it('keeps the image and text when the persisted media write is refused', async () => {
  await attach();
  const rootPath = join(directory, 'media', 'orchestrator-images'); const backup = `${rootPath}-backup`;
  if (existsSync(rootPath)) renameSync(rootPath, backup); else mkdirSync(join(directory, 'media'), { recursive: true });
  writeFileSync(rootPath, 'refuse upload'); const count = received().length;
  try {
    await send();
    await eventually(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('Image was not sent'));
    expect(host.querySelector('textarea')?.value).toBe('Inspect the selected image');
    expect(host.querySelector('img[alt="fixture.png"]')).not.toBeNull();
    expect(received()).toHaveLength(count); expect((await saved()).messages ?? []).toEqual([]);
  } finally { rmSync(rootPath, { force: true }); if (existsSync(backup)) renameSync(backup, rootPath); }
});

it('refuses an unsupported backend while retaining both draft parts', async () => {
  await attach(); backend = 'pi'; await act(async () => root.render(createElement(Harness)));
  const count = received().length; await send();
  expect(host.querySelector('textarea')?.value).toBe('Inspect the selected image');
  expect(host.querySelector('img[alt="fixture.png"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot receive images');
  expect(received()).toHaveLength(count); expect((await saved()).messages ?? []).toEqual([]);
});


it('blocks Send while an image read is pending and keeps a failed over-capacity batch', async () => {
  const count = received().length;
  const deferred: { read?: () => void } = {};
  class DeferredReader extends Reader { readAsDataURL(file: Blob) { deferred.read = () => super.readAsDataURL(file); } }
  vi.stubGlobal('FileReader', DeferredReader);
  await attach(1, false); await send();
  expect(host.querySelector('textarea')?.value).toBe('Inspect the selected image');
  expect(received()).toHaveLength(count);
  await act(async () => deferred.read?.());
  await eventually(() => expect(host.querySelector('img[alt="fixture.png"]')).not.toBeNull());
  const files = Array.from({ length: 4 }, (_, index) => new File(['x'], `extra-${index}.png`, { type: 'image/png' }));
  await act(async () => { await upload.processFiles(files); });
  await send();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('at most 4 images');
  expect(host.querySelector('textarea')?.value).toBe('Inspect the selected image');
  expect(host.querySelector('img[alt="fixture.png"]')).not.toBeNull();
  expect(received()).toHaveLength(count); expect((await saved()).messages ?? []).toEqual([]);
});


it('preserves a newer draft when an older image send is accepted after asynchronous preparation', async () => {
  let release: (value: boolean) => void = () => {};
  admissionGate = new Promise(resolve => { release = resolve; });
  writeFileSync(releaseImage, 'finish');
  await attach(); const count = received().length; await send();
  const input = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'New draft while sending');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    upload.removeAttachedImage(0);
    release(true);
  });
  await eventually(() => expect(received()).toHaveLength(count + 1));
  expect(received().at(-1)?.images).toEqual([image]);
  expect(input.value).toBe('New draft while sending');
  await eventually(() => expect(stream.status).toBe('ready'));
});


it('blocks Send between a completed image read and promotion into the composer', async () => {
  const frames: FrameRequestCallback[] = [];
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  const count = received().length; const completed = readCompletions;
  try {
    await attach(1, false);
    await eventually(() => expect(readCompletions).toBeGreaterThan(completed));
    await send();
    expect(host.querySelector('textarea')?.value).toBe('Inspect the selected image');
    expect(received()).toHaveLength(count);
    expect((await saved()).messages ?? []).toEqual([]);
  } finally {
    await act(async () => { for (const callback of frames) callback(performance.now()); });
    frame.mockRestore();
  }
});

it('keeps a new image upload when acceptance arrives for the previous image', async () => {
  let release: (value: boolean) => void = () => {};
  admissionGate = new Promise(resolve => { release = resolve; });
  writeFileSync(releaseImage, 'finish');
  await attach(); const count = received().length; await send();
  const deferred: { read?: () => void } = {};
  class DeferredReader extends Reader { readAsDataURL(file: Blob) { deferred.read = () => super.readAsDataURL(file); } }
  vi.stubGlobal('FileReader', DeferredReader);
  const next = new File([Uint8Array.from(atob(image), value => value.charCodeAt(0))], 'next-image.png', { type: 'image/png' });
  await act(async () => { void upload.processFiles([next]); });
  await act(async () => release(true));
  await eventually(() => expect(received()).toHaveLength(count + 1));
  await eventually(() => expect(stream.status).toBe('ready'));
  expect(host.querySelector('textarea')?.value).toBe('Inspect the selected image');
  await act(async () => deferred.read?.());
  await eventually(() => expect(host.querySelector('img[alt="next-image.png"]')).not.toBeNull());
  expect(received()).toHaveLength(count + 1);
});
