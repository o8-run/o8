import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { NextRequest } from 'next/server';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => {} }));
const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const os = await import('node:os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o8-screenshot-queue-')));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.mkdirSync(path.join(root, 'chat-history'));
  return { root, repo };
});
vi.stubEnv('O8_DATA_DIR', fixture.root); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture.root); vi.stubEnv('CORTEX_IDE_DB_PATH', path.join(fixture.root, 'queue.db'));
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
const queue = await import('@/lib/orchestrator/composer-queue');
const api = await import('@/app/api/orchestrator/composer-queue/route');
const proofDir = process.env.O8_SCREENSHOT_QUEUE_PROOF_DIR;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=', 'base64');
const imageUri = (large: boolean) => `data:image/png;base64,${(large ? Buffer.concat([pixel, Buffer.alloc(3_136_623 - pixel.length)]) : pixel).toString('base64')}`;
let browser: Browser; let bundle: string;
beforeAll(async () => {
  const build = await esbuild.build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import { createElement, useEffect, useRef, useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { ThemeProvider } from '@/lib/theme/context';
      import { useComposerDraftValue, composerDraftKey, captureComposerDraft, moveComposerDraft } from '@/components/desktop/thoughts/chat-panel/composer-draft-store';
      import { ComposerArea } from '@/components/desktop/thoughts/chat-panel/ComposerArea';
      import { ComposerSendBufferStatus } from '@/components/desktop/thoughts/chat-panel/ComposerSendBufferStatus';
      import { useDefaultComposerSendBuffer } from '@/components/desktop/thoughts/chat-panel/useDefaultComposerSendBuffer';
      import { useBufferedOrchestratorSend } from '@/components/desktop/thoughts/chat-panel/useBufferedOrchestratorSend';
      const config = window.fixtureConfig;
      function Surface() {
        const [transientInput, setTransientInput] = useState('Queue the screenshot.'); const [transientImages, setTransientImages] = useState(config.image ? [{ name: config.imageName, mimeType: 'image/png', dataUri: config.image }] : []);
        const key = composerDraftKey(config.repo, 'review-tab', 'thoughts-screenshot');
        window.moveDraft = () => moveComposerDraft(key, composerDraftKey(config.repo, 'review-tab', 'thoughts-moved'), captureComposerDraft(key));
        const draftInput = useComposerDraftValue(key, 'input', ''); const draftImages = useComposerDraftValue(key, 'images', []);
        const [input, setInput] = config.productionDraft ? [draftInput.value, draftInput.setValue] : [transientInput, setTransientInput];
        const [images, setImages] = config.productionDraft ? [draftImages.value, draftImages.setValue] : [transientImages, setTransientImages];
        const latestInputRef = useRef(input); latestInputRef.current = input; const inputRef = useRef(null);
        const [threadId, setThreadId] = useState('thoughts-screenshot');
        useEffect(() => { window.changeDraft = (thread, text, image) => { setThreadId(thread); setInput(text); latestInputRef.current = text; setImages(image ? [{ name: config.imageName, mimeType: 'image/png', dataUri: image }] : []); }; }, []);
        const model = new URLSearchParams(location.search).get('model') || 'original-model';
        const { dispatch, capture } = useBufferedOrchestratorSend({ active: true, backend: 'codex', model, mode: 'solo', solo: false,
          effort: 'low', permissionMode: 'plan', collide: false, projectId: 'fixture-project', context: 'Fixture context', send: () => { throw new Error('Unexpected direct send'); } });
        const result = useDefaultComposerSendBuffer({ active: true, backend: 'codex', busy: !location.search.includes('idle'), threadId, repoPath: config.repo,
          attachedImages: images, latestInputRef, inputRef, setInput, addAttachedImage: entry => setImages(previous => [...previous, entry]), clearAttachments: () => setImages([]),
          dispatch, captureQueuedSend: capture, interrupt() {}, undoSend() {}, shouldBypass: () => false, sendUnbuffered() {} });
        return createElement('main', { style: { maxWidth: 760, margin: '24px auto', color: 'var(--t-text)', background: 'var(--t-chat-surface-bg)' } },
          createElement(ComposerArea, { input, inputLabel: 'Screenshot composer', onInputChange: value => { latestInputRef.current = value; setInput(value); },
            activeComposer: true, isOrchestratorMode: true, displayWaiting: true, chatMessages: [], activeTargetLabel: 'Agent', targetAgentExists: true,
            thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null, onEnhance() {}, onUndoEnhance() {},
            onSubmit: result.handleSend, onSteer: result.handleSteer, canSteerLive: false, queueSaving: result.saving, onSlashCommand() {}, modelLabel: model,
            effort: 'low', onEffortChange() {}, adaptiveEnabled: false, displayMessagesCount: 0, hasAssistantActivity: false, attachedImages: images,
            sendBufferStatus: createElement(ComposerSendBufferStatus, { attachmentError: result.attachmentError, queued: [], undoArmed: false, undoSequence: 0, onUndo() {}, onCancelQueued() {} }) }));
      }
      createRoot(document.getElementById('root')).render(createElement(ThemeProvider, null, createElement(Surface)));
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
    alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'var process = { env: { NODE_ENV: "production" }, platform: "browser", versions: {} };' },
    loader: { '.css': 'empty', '.ttf': 'dataurl' }, logLevel: 'silent', legalComments: 'none',
    plugins: [{ name: 'fixture-transport', setup(build) {
      build.onLoad({ filter: /[\\/]DesktopWebSocketContext\.tsx$/ }, () => ({ contents: 'export const useSharedDesktopWs = () => ({connectionState:"disconnected"}); export const useWsConnectionState = () => "disconnected"; export const useWsConnectionEpoch = () => 0;', loader: 'js' }));
      build.onResolve({ filter: /next\/dist\/compiled\/gzip-size/ }, () => ({ path: 'gzip-size', namespace: 'fixture-next' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture-next' }, () => ({ contents: 'export default async () => 0; export const sync = () => 0;', loader: 'js' }));
    } }],
  });
  bundle = build.outputFiles[0].text;
  const executablePath = resolveBrowserPath(); if (!executablePath) throw new Error('Chromium is required for screenshot queue recovery verification.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
beforeEach(() => {
  ensureV71ComposerQueueSchema(getSqlite()); getSqlite().exec('DELETE FROM composer_send_queue');
  for (const thread of ['thoughts-screenshot', 'thoughts-other']) fs.writeFileSync(path.join(fixture.root, `chat-history/${thread}.json`), JSON.stringify({ repoPath: fixture.repo, backend: 'codex', messages: [] }));
});
afterAll(async () => { await browser?.close(); closeDb(); vi.unstubAllEnvs(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

async function mount(page: Page, image: string, url = 'http://localhost/screenshot', productionDraft = false, imageName = 'screenshot.png') {
  await page.goto(url);
  await page.evaluate(config => { (window as unknown as { fixtureConfig: unknown }).fixtureConfig = config; }, { image, repo: fixture.repo, productionDraft, imageName });
  await page.addStyleTag({ content: fs.readFileSync('src/app/globals.css', 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.getByRole('textbox', { name: 'Screenshot composer' }).waitFor({ timeout: 5000 });
}
async function connect(page: Page, posts: Array<{ id: string; payload: { images: Array<{ dataUri: string }>; routing: { model: string } } }>, loseFirst = false) {
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname === '/api/orchestrator/composer-queue') {
      const method = request.method(); const body = request.postData();
      const native = new NextRequest(request.url(), { method, headers: { host: 'localhost', 'Content-Type': 'application/json' }, ...(body ? { body } : {}) });
      const response = method === 'POST' ? await api.POST(native) : await api.GET(native);
      if (method === 'POST') { posts.push(JSON.parse(body!)); if (loseFirst) { loseFirst = false; await route.abort('failed'); return; } }
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() }); return;
    }
    await route.fulfill({ contentType: url.pathname.startsWith('/api/') ? 'application/json' : 'text/html', body: url.pathname.startsWith('/api/') ? '{}' : '<html><body style="margin:0"><div id="root"></div></body></html>' });
  });
}

it.each([false, true])('queues a supported screenshot and reuses its original receipt after reload above the old boundary: %s', async large => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts, true); await mount(page, imageUri(large));
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => posts.length).toBe(1);
    await expect.poll(() => page.getByRole('alert').count()).toBe(1);
    expect(await page.getByRole('textbox').inputValue()).toBe('Queue the screenshot.');
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `uncertain-${large ? 'large' : 'small'}.png`) }); }
    const normalizedLength = JSON.stringify(posts[0]).length;
    if (proofDir) fs.writeFileSync(path.join(proofDir, `payload-${large ? 'large' : 'small'}.json`), JSON.stringify({ serializedRequestCharacters: normalizedLength, imageDataUriCharacters: posts[0].payload.images[0].dataUri.length, outcome: 'saved by the queue API; first response lost; exact identity replayed after reload' }, null, 2));
    expect(large ? normalizedLength > 4_000_000 : normalizedLength < 4_000_000).toBe(true);
    expect(posts[0].payload.images[0].dataUri.length).toBeLessThan(5_000_000);
    if (large) expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('o8:composer-queue-recovery:')).every(key => localStorage.getItem(key)!.length < 1000))).toBe(true);
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(1);
    await mount(page, imageUri(large), 'http://localhost/screenshot?model=changed-model&idle');
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => posts.length).toBe(2);
    await expect.poll(() => page.getByRole('textbox').inputValue()).toBe('');
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[1].payload.routing.model).toBe('original-model');
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(1);
    expect(await page.getByRole('alert').count()).toBe(0);
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `queued-${large ? 'large' : 'small'}.png`) }); }
  } finally { await page.close(); }
}, 30_000);

it.each([
  ['QuotaExceededError', 'Browser storage is full'], ['SecurityError', 'Browser storage is unavailable'], ['UnknownError', 'The draft could not be saved'],
])('keeps a large screenshot draft when attachment persistence fails with %s', async (name, advice) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } }); const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts); await mount(page, imageUri(true));
    await page.evaluate(name => { IDBObjectStore.prototype.put = () => { throw new DOMException('Fixture storage failure', name); }; }, name);
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain(advice);
    expect(await page.getByRole('alert').textContent()).toContain('Message was not queued');
    expect(posts).toEqual([]);
    expect(await page.getByRole('textbox').inputValue()).toBe('Queue the screenshot.');
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `failure-${name}.png`) }); }
  } finally { await page.close(); }
}, 30_000);


it('holds the draft and does not post when a successful attachment request aborts before transaction commit', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts); await mount(page, imageUri(true));
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const request = put.apply(this, args);
        request.addEventListener('success', () => this.transaction.abort(), { once: true });
        return request;
      };
    });
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Message was not queued');
    expect(posts).toEqual([]);
    expect(await page.getByRole('textbox').inputValue()).toBe('Queue the screenshot.');
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('o8:composer-queue-recovery:')).length)).toBe(0);
  } finally { await page.close(); }
});

it('does not post or leave an attachment behind when the small manifest hits quota after the attachment commits', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts); await mount(page, imageUri(true));
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('o8:composer-queue-recovery:')) throw new DOMException('Fixture quota', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    });
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Browser storage is full');
    expect(posts).toEqual([]);
    expect(await page.getByRole('textbox').inputValue()).toBe('Queue the screenshot.');
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const opening = indexedDB.open('o8.composer-queue-attachments.v1');
      opening.onsuccess = () => { const db = opening.result; const count = db.transaction('attempts').objectStore('attempts').count();
        count.onsuccess = () => { db.close(); resolve(count.result); }; count.onerror = () => reject(count.error); };
      opening.onerror = () => reject(opening.error);
    }))).toBe(0);
  } finally { await page.close(); }
});

it('retains an uncertain identity and refuses another POST when its saved attachment is missing after reload', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts, true); await mount(page, imageUri(true));
    await page.getByRole('textbox').press('Enter'); await expect.poll(() => posts.length).toBe(1);
    await expect.poll(() => page.getByRole('alert').count()).toBe(1);
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('o8.composer-queue-attachments.v1');
      opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('attempts', 'readwrite'); tx.objectStore('attempts').clear();
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
      opening.onerror = () => reject(opening.error);
    }));
    await mount(page, imageUri(true)); await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Saved messages could not be checked');
    expect(posts).toHaveLength(1);
    expect(await page.getByRole('textbox').inputValue()).toBe('Queue the screenshot.');
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('o8:composer-queue-recovery:')).length)).toBe(1);
  } finally { await page.close(); }
});

it('keeps a late attachment save scoped to its original thread and preserves the new chat draft', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts); await mount(page, imageUri(true));
    await page.evaluate(() => {
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function(...args) {
        IDBFactory.prototype.open = open;
        const request = open.apply(this, args);
        request.addEventListener('success', event => {
          event.stopImmediatePropagation();
          (window as unknown as { releaseAttachment: () => void }).releaseAttachment = () => { request.onsuccess?.call(request, event); };
        }, { once: true });
        return request;
      };
    });
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAttachment?: unknown }).releaseAttachment)).toBe('function');
    await page.evaluate(() => (window as unknown as { changeDraft: (thread: string, text: string, image: string) => void }).changeDraft('thoughts-other', 'Different chat draft.', ''));
    await expect.poll(() => page.getByRole('textbox').inputValue()).toBe('Different chat draft.');
    await page.evaluate(() => (window as unknown as { releaseAttachment: () => void }).releaseAttachment());
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('o8:composer-queue-recovery:')).length)).toBe(1);
    expect(posts).toEqual([]);
    expect(await page.getByRole('textbox').inputValue()).toBe('Different chat draft.');
    expect(await page.getByRole('alert').count()).toBe(0);
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-other' })).toEqual([]);
  } finally { await page.close(); }
});

it('reports the application message limit without quota advice or a queue POST', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts); await mount(page, '');
    await page.evaluate(() => (window as unknown as { changeDraft: (thread: string, text: string, image: string) => void }).changeDraft('thoughts-screenshot', 'x'.repeat(2_000_100), ''));
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('This message is too large');
    expect(await page.getByRole('alert').textContent()).toContain('Shorten it and retry');
    expect(await page.getByRole('alert').textContent()).not.toContain('storage is full');
    expect(posts).toEqual([]);
    expect((await page.getByRole('textbox').inputValue()).length).toBe(2_000_100);
  } finally { await page.close(); }
});


it.each([['Queue the screenshot.', 'screenshot.png'], ['', 'screenshot.png'], ['Queue the screenshot.', ' screenshot.png ']])('restores a large screenshot and its original queue id after a real draft reload: %s / %s', async (text, imageName) => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = []; const attemptedIds: string[] = [];
  try {
    await connect(page, posts);
    await page.route('**/api/orchestrator/composer-queue', route => { if (route.request().method() !== 'POST') return route.fallback(); attemptedIds.push(route.request().postDataJSON().id); return route.abort('connectionrefused'); });
    await mount(page, '', 'http://localhost/screenshot', true, imageName);
    await page.evaluate(({ image, text }) => (window as unknown as { changeDraft: (thread: string, text: string, image: string) => void }).changeDraft('thoughts-screenshot', text, image), { image: imageUri(true), text });
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').count()).toBe(1);
    expect(attemptedIds).toHaveLength(1);
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(0);
    await mount(page, '', 'http://localhost/screenshot', true);
    expect(await page.getByRole('textbox').inputValue()).toBe(text);
    await expect.poll(() => page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.locator('img[alt]').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toContain(imageName);
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `restored-production-${text ? 'text' : 'image-only'}.png`) }); }
    await page.unroute('**/api/orchestrator/composer-queue');
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].id).toBe(attemptedIds[0]);
    expect((posts[0].payload.images[0] as { name?: string }).name).toBe('screenshot.png');
    expect(posts[0].payload.images[0].dataUri).toBe(imageUri(true));
    expect(imageUri(true).length).toBe(4_182_186);
    await expect.poll(() => page.getByRole('textbox').inputValue()).toBe('');
    await page.getByRole('textbox').press('Enter');
    expect(posts).toHaveLength(1);
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(1);
  } finally { await page.close(); }
});

it('review: a native localStorage quota failure gives storage advice, without monkeypatching storage', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await connect(page, posts); await mount(page, imageUri(false));
    const quota = await page.evaluate(() => {
      let count = 0;
      let name = 'no quota hit';
      for (const size of [131072, 1024, 64, 1]) {
        try { while (count < 10000) localStorage.setItem('review-filler-' + count++, 'x'.repeat(size)); }
        catch (error) { name = (error as DOMException).name; }
      }
      return { count, name };
    });
    expect(quota.name).toBe('QuotaExceededError');
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Browser storage is full');
    expect(posts).toEqual([]);
    expect(await page.getByRole('textbox').inputValue()).toBe('Queue the screenshot.');
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
  } finally { await page.close(); }
});

async function failLargeDraft(page: Page, posts: Parameters<typeof connect>[1]) {
  await connect(page, posts);
  let id = '';
  await page.route('**/api/orchestrator/composer-queue', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    id = route.request().postDataJSON().id; return route.abort('connectionrefused');
  });
  await mount(page, '', 'http://localhost/screenshot', true);
  await page.evaluate(image => (window as unknown as { changeDraft: (thread: string, text: string, image: string) => void })
    .changeDraft('thoughts-screenshot', 'Queue the screenshot.', image), imageUri(true));
  await page.getByRole('textbox').press('Enter');
  await expect.poll(() => page.getByRole('alert').count()).toBe(1);
  expect(id).not.toBe(''); return id;
}

async function holdRestoration(page: Page) {
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (window as unknown as { releaseDraftReads: () => void }).releaseDraftReads = release;
    const setter = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!.set!;
    indexedDB.open = (...args) => {
      const request = open(...args);
      Object.defineProperty(request, 'onsuccess', { configurable: true,
        set(callback: (event: Event) => void) { setter.call(request, (event: Event) => { void gate.then(() => callback.call(request, event)); }); } });
      return request;
    };
  });
}

it('retries a saved screenshot without rewriting attachments when new storage writes fail', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    const id = await failLargeDraft(page, posts); await page.unroute('**/api/orchestrator/composer-queue');
    await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Fixture quota', 'QuotaExceededError'); }; });
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].id).toBe(id);
    expect(posts[0].payload.images[0].dataUri).toBe(imageUri(true));
    await expect.poll(() => page.getByRole('textbox').inputValue()).toBe('');
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(1);
  } finally { await page.close(); }
});

it('blocks a text-only send when the saved draft image copy is missing', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await failLargeDraft(page, posts); await page.unroute('**/api/orchestrator/composer-queue');
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const key = Object.keys(localStorage).find(key => key.startsWith('o8:composer-draft:'))!;
      const reference = JSON.parse(localStorage.getItem(key)!).storedImages;
      const opening = indexedDB.open('o8.composer-queue-attachments.v1');
      opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('attempts', 'readwrite'); tx.objectStore('attempts').delete(reference);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
      opening.onerror = () => reject(opening.error);
    }));
    await mount(page, '', 'http://localhost/screenshot', true);
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Saved draft attachments could not be restored');
    expect(posts).toEqual([]);
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(0);
  } finally { await page.close(); }
});

it('refuses a draft move during restoration and retains text edited while the image loads', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await failLargeDraft(page, posts); await holdRestoration(page);
    await mount(page, '', 'http://localhost/screenshot', true);
    const before = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('o8:composer-draft:')));
    expect(await page.evaluate(() => (window as unknown as { moveDraft: () => boolean }).moveDraft())).toBe(false);
    expect(await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('o8:composer-draft:')))).toEqual(before);
    await page.getByRole('textbox').fill('Edited while restoring.');
    await page.evaluate(() => (window as unknown as { releaseDraftReads: () => void }).releaseDraftReads());
    await expect.poll(() => page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByRole('textbox').inputValue()).toBe('Edited while restoring.');
    expect(posts).toEqual([]);
  } finally { await page.close(); }
});

it('does not resurrect an image explicitly removed during restoration', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await failLargeDraft(page, posts); await holdRestoration(page);
    await mount(page, '', 'http://localhost/screenshot', true);
    await page.evaluate(() => (window as unknown as { changeDraft: (thread: string, text: string, image: string) => void })
      .changeDraft('thoughts-screenshot', 'Keep only this text.', ''));
    await page.evaluate(() => (window as unknown as { releaseDraftReads: () => void }).releaseDraftReads());
    await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
      const opening = indexedDB.open('o8.composer-queue-attachments.v1');
      opening.onsuccess = () => { const db = opening.result; const request = db.transaction('attempts').objectStore('attempts').count();
        request.onsuccess = () => { db.close(); resolve(request.result); }; request.onerror = () => reject(request.error); };
      opening.onerror = () => reject(opening.error);
    }))).toBe(1); // The uncertain queue attempt remains; its draft copy retired.
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBe(0);
    await mount(page, '', 'http://localhost/screenshot', true);
    expect(await page.getByRole('textbox').inputValue()).toBe('Keep only this text.');
    expect(await page.getByText('screenshot.png', { exact: true }).count()).toBe(0);
    expect(posts).toEqual([]);
  } finally { await page.close(); }
});

it('does not replace another window’s saved draft before its storage event arrives', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    await failLargeDraft(page, posts); await page.unroute('**/api/orchestrator/composer-queue');
    const other = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('o8:composer-draft:'))!;
      const raw = JSON.stringify({ input: 'Another window owns this edit.', images: [], files: [], revision: 'other-window' });
      localStorage.setItem(key, raw); return { key, raw };
    });
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Saved draft attachments could not be restored');
    expect(await page.evaluate(key => localStorage.getItem(key), other.key)).toBe(other.raw);
    expect(posts).toEqual([]);
  } finally { await page.close(); }
});

it('retains image and identity when clearing fails after acceptance and queue recovery is retired', async () => {
  const page = await browser.newPage(); const posts: Parameters<typeof connect>[1] = [];
  try {
    const id = await failLargeDraft(page, posts); await page.unroute('**/api/orchestrator/composer-queue');
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, raw) {
        if (key.startsWith('o8:composer-draft:')) {
          const value = JSON.parse(raw);
          if (!value.input && !value.images.length && !value.storedImages) throw new DOMException('Fixture clear denied', 'SecurityError');
        }
        return set.call(this, key, raw);
      };
    });
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => posts.length).toBe(1);
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('draft could not be cleared');
    expect(posts[0].id).toBe(id);
    // Another owner may confirm this same send and retire its queue recovery.
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const keys = Object.keys(localStorage).filter(key => key.startsWith('o8:composer-queue-recovery:'));
      const opening = indexedDB.open('o8.composer-queue-attachments.v1');
      opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('attempts', 'readwrite');
        for (const key of keys) { tx.objectStore('attempts').delete(key); localStorage.removeItem(key); }
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
      opening.onerror = () => reject(opening.error);
    }));
    await mount(page, '', 'http://localhost/screenshot?model=changed-model&idle', true);
    await expect.poll(() => page.getByText('screenshot.png', { exact: true }).count()).toBeGreaterThan(0);
    await page.getByRole('textbox').press('Enter');
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toEqual(posts[0]);
    await expect.poll(() => page.getByRole('textbox').inputValue()).toBe('');
    expect(queue.listQueuedComposerSends({ repoPath: fixture.repo, threadId: 'thoughts-screenshot' })).toHaveLength(1);
    expect(posts[1].payload.images[0].dataUri).toBe(imageUri(true));
  } finally { await page.close(); }
});
