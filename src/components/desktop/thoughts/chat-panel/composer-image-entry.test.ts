/** @vitest-environment jsdom */
import { createElement, useState, useRef, useEffect, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { MAX_AGENT_IMAGE_BASE64 } from '@/lib/composer/image-attachment';
import { ComposerArea } from './ComposerArea';
import type { OrchestratorSendHandle } from '../useOrchestratorStream';
import { useDefaultComposerSendBuffer } from './useDefaultComposerSendBuffer';
import { useThoughtsComposerAttachments } from './useThoughtsComposerAttachments';

vi.mock('../InputButtons', async () => {
  const { AttachFilesButton } = await import('../AttachFilesButton');
  return { InputButtons: (props: { onUploadDiskFiles?: (files: FileList | File[]) => void }) => createElement(AttachFilesButton, props), RepoTargetChip: () => null };
});
vi.mock('./SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('./ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('../../composer-center-registry', () => ({ registerComposerCenter: () => () => undefined }));
vi.mock('./useDurableComposerQueue', () => ({ useDurableComposerQueue: () => ({ items: [], removing: new Set(), ready: true, error: null, hasPending: () => false, enqueue: vi.fn(), cancel: vi.fn() }) }));

// Genuine synthetic 1x1 RGBA PNG (IHDR/IDAT/IEND with valid CRCs), no file reads.
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const corruptImage = btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0));
let root: Root;
let host: HTMLDivElement;
let secondRoot: Root | undefined;
let secondHost: HTMLDivElement | undefined;
let active = true;
let disabled = false;
let context = 'first-chat';
let failed = false;
let noUpload = false;
let deferred = false;
let readers: FixtureReader[];
let decodeDeferred = false;
let decodeFailed = false;
let decoders: Array<{ resolve: () => void; reject: () => void }>;
// jsdom lacks raster decoding. Simulate only the standard browser decoder
// boundary; registered tool/client/bridge and the normal upload handler run.
class FixtureImage {
  src = '';
  naturalWidth = 1;
  naturalHeight = 1;
  removeAttribute() { this.src = ''; }
  decode() {
    return new Promise<void>((resolve, reject) => {
      const outcome = { resolve, reject: () => reject(new Error('decode failed')) };
      decoders.push(outcome);
      if (!decodeDeferred) queueMicrotask(() => decodeFailed || !this.src.endsWith(image) ? outcome.reject() : resolve());
    });
  }
}
const sent = vi.fn(() => ({} as OrchestratorSendHandle));
let submitDraft: (() => void) | undefined;
class FixtureReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL(file: File) {
    this.result = `data:${file.type};base64,${image}`;
    readers.push(this);
    if (!deferred) queueMicrotask(() => failed ? this.onerror?.() : this.onload?.());
  }
}
function Harness() {
  const attachments = useThoughtsComposerAttachments();
  const [input, setInput] = useState('unsent');
  const latestInputRef = useRef(input); const inputRef = useRef<HTMLTextAreaElement>(null);
  const { handleSend } = useDefaultComposerSendBuffer({
    active, backend: 'codex', busy: false, threadId: context, repoPath: '/fixture',
    attachedImages: attachments.attachedImages, latestInputRef, inputRef, setInput,
    addAttachedImage: attachments.addAttachedImage, clearAttachments: attachments.clearAttachments,
    dispatch: sent, interrupt: () => undefined, undoSend: () => undefined,
    captureQueuedSend: () => { throw new Error('No queued send in this idle image test.'); },
    shouldBypass: () => false, sendUnbuffered: () => undefined,
  });
  useEffect(() => { latestInputRef.current = input; submitDraft = handleSend; }, [handleSend, input]);
  return createElement(ComposerArea, {
    activeComposer: active, input, onInputChange: setInput,
    isOrchestratorMode: !disabled, displayWaiting: false, chatMessages: [], activeTargetLabel: 'Chat',
    targetAgentExists: false, thoughtsBodyBackground: 'var(--t-workspace)', enhancing: false,
    preEnhanceInput: null, onEnhance: () => undefined, onUndoEnhance: () => undefined,
    onSubmit: handleSend, onSlashCommand: () => undefined, modelLabel: 'Model', effort: 'medium',
    onEffortChange: () => undefined, adaptiveEnabled: false, displayMessagesCount: 0,
    hasAssistantActivity: false, sessionRulesThreadId: context,
    attachedImages: attachments.attachedImages, onUploadDiskFiles: noUpload ? undefined : attachments.processFiles,
  });
}
let client: O8WebviewClient;
const handlers = createO8WebviewToolHandlers(() => client);
async function call(name: string, args: Record<string, unknown> = {}) {
  let result: Awaited<ReturnType<typeof handlers[string]>>;
  await act(async () => { result = await handlers[name](args); });
  const content = result!.content[0];
  if (content.type !== 'text') throw new Error('Expected text receipt');
  return JSON.parse(content.text) as Record<string, unknown>;
}
async function attach(extra: Record<string, unknown> = {}) {
  const inspection = await call('o8_view_inspect_composer', 'allow_background' in extra ? { allow_background: extra.allow_background } : {});
  return call('o8_view_attach_image', {
    composer_id: inspection.composer_id, request_id: crypto.randomUUID(), filename: 'fixture.png',
    media_type: 'image/png', data_base64: image, ...extra,
  });
}
async function frames() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); }
function addComposer() {
  secondHost = document.createElement('div'); document.body.append(secondHost); secondRoot = createRoot(secondHost);
  act(() => secondRoot!.render(createElement(Harness)));
}
function render() { act(() => root.render(createElement(Harness))); }

beforeEach(() => {
  // Freeze the wall clock before mounting or creating receipts. Keep timers,
  // microtasks and animation frames real so React and browser work still settle.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  active = true; disabled = false; context = 'first-chat'; failed = false; noUpload = false; deferred = false; readers = [];
  decodeDeferred = false; decodeFailed = false; decoders = [];
  sent.mockClear(); localStorage.clear();
  vi.stubGlobal('Image', FixtureImage);
  vi.stubGlobal('FileReader', FixtureReader);
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  vi.stubEnv('O8_TAURI_MCP_SOCKET', '/fixture/never-connected.sock');
  client = new O8WebviewClient();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 40, top: 0, left: 0, bottom: 40, right: 100, x: 0, y: 0, toJSON: () => ({}) });
  // Simulate only the established native execute_js boundary. The registered
  // tool, typed client scripts, ComposerArea and normal reader/attachment flow run.
  vi.spyOn(client, 'evalJs').mockImplementation(async code => ({ result: new Function('window', `return ${code}`)(window) as string }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); render();
});
afterEach(() => { act(() => { secondRoot?.unmount(); root.unmount(); }); secondHost?.remove(); secondRoot = undefined; secondHost = undefined; host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

describe('registered image tool -> normal installed composer handler', () => {
  it('acknowledges committed attachment state, correlates status, never sends or replays', async () => {
    deferred = true;
    const pending = await attach();
    expect(pending.status).toBe('pending');
    expect(decoders).toHaveLength(1);
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    const before = readers.length;
    await act(async () => readers[0].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('completed');
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('fixture.png');
    expect((await attach({ request_id: pending.request_id })).code).toBe('duplicate_request');
    expect(readers).toHaveLength(before); expect(sent).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')?.value).toBe('unsent');
  });
  it('does not acknowledge a simultaneous manual upload with identical bytes as the agent request', async () => {
    deferred = true;
    const pending = await attach();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([atob(image)], 'fixture.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => readers[1].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    await act(async () => readers[0].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('completed');
  });
  it('refuses invalid arguments before reading or uploading', async () => {
    for (const extra of [
      { data_base64: 'not-base64' }, { data_base64: 'AAAA' }, { data_base64: 'A'.repeat(MAX_AGENT_IMAGE_BASE64 + 4) }, { data_base64: 'A'.repeat(MAX_AGENT_IMAGE_BASE64) },
      { composer_id: 'bad' }, { request_id: 'bad' }, { data_base64: 1 }, { filename: 'a'.repeat(121) + '.png' },
      { media_type: 'application/pdf' }, { filename: '../image.png' }, { filename: 'image\0.png' },
      { filename: 'image.jpg' }, { path: '/some/file.png' }, { script: 'arbitrary' },
    ]) expect((await attach(extra)).status).toBe('error');
    expect(readers).toHaveLength(0);
  });
  it('refuses inactive, disabled, hidden, missing and stale composers', async () => {
    const original = await call('o8_view_inspect_composer');
    context = 'different-chat'; render();
    expect((await attach({ composer_id: original.composer_id })).code).toBe('stale_composer');
    active = false; render(); expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    active = true; disabled = true; render(); expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    disabled = false; render(); host.querySelector('textarea')!.style.display = 'none';
    expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    act(() => root.render(null)); expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    expect(readers).toHaveLength(0);
  });
  it('refuses a changed target during reading and prevents a late attachment', async () => {
    deferred = true;
    const pending = await attach(); context = 'changed-while-reading'; render();
    await act(async () => readers[0].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('target_changed');
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it('drops a read result when its target changes before the attachment frame', async () => {
    deferred = true;
    const pending = await attach();
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { queued.push(callback); return queued.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    await act(async () => readers[0].onload?.());
    expect(host.querySelectorAll('img')).toHaveLength(0);
    context = 'changed-before-frame'; render();
    await act(async () => { for (const callback of queued) callback(0); });
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('target_changed');
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it('preserves the manual file-input path and enforces image capacity', async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([atob(image)], 'manual.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await frames();
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('manual.png');
    for (let count = 0; count < 3; count++) { expect((await attach()).status).toBe('pending'); await frames(); }
    expect((await attach()).code).toBe('image_capacity');
    expect(host.querySelectorAll('img')).toHaveLength(4); expect(sent).not.toHaveBeenCalled();
  });
  it('expires a pending upload and blocks late reader completion', async () => {
    deferred = true;
    const startedAt = Date.now();
    const pending = await attach();
    vi.setSystemTime(startedAt + 19_999);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    vi.setSystemTime(startedAt + 20_000);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('upload_expired');
    await act(async () => readers[0].onload?.()); await frames();
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it('reports upload read failure and missing receipts honestly', async () => {
    failed = true; const pending = await attach(); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('upload_failed');
    expect((await call('o8_view_image_attachment_status', { request_id: 'missing-request' })).code).toBe('unknown_request');
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it.each([
    ['image/png', 'fixture.png', corruptImage],
    ['image/jpeg', 'fixture.jpg', btoa(String.fromCharCode(255, 216, 255, 0))],
    ['image/gif', 'fixture.gif', btoa('GIF89a')],
    ['image/webp', 'fixture.webp', btoa('RIFF0000WEBP')],
  ])('refuses corrupt %s bytes after decoding, before normal upload', async (media_type, filename, data_base64) => {
    const pending = await attach({ media_type, filename, data_base64 });
    expect(pending.status).toBe('pending');
    expect(await call('o8_view_image_attachment_status', { request_id: pending.request_id })).toMatchObject({
      request_id: pending.request_id, composer_id: pending.composer_id, status: 'error', code: 'invalid_image',
    });
    expect(decoders).toHaveLength(1); expect(readers).toHaveLength(0);
    expect(host.querySelectorAll('img')).toHaveLength(0); expect(sent).not.toHaveBeenCalled();
  });
  it('reports browser decode failure without invoking the upload handler', async () => {
    decodeFailed = true;
    const pending = await attach();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('invalid_image');
    expect(readers).toHaveLength(0); expect(sent).not.toHaveBeenCalled();
  });
  it.each(['changed', 'expired'])('guards a %s target throughout asynchronous decoding', async (condition) => {
    decodeDeferred = true;
    const startedAt = Date.now();
    const pending = await attach();
    expect(readers).toHaveLength(0);
    if (condition === 'changed') { context = 'changed-while-decoding'; render(); }
    else {
      vi.setSystemTime(startedAt + 19_999);
      expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
      vi.setSystemTime(startedAt + 20_000);
    }
    await act(async () => decoders[0].resolve()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe(condition === 'changed' ? 'target_changed' : 'upload_expired');
    expect(readers).toHaveLength(0); expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it('commits exactly one background image with RAF permanently stalled and strips transient metadata from normal submit', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const focus = vi.spyOn(host.querySelector('textarea')!, 'focus');
    const pending = await attach({ allow_background: true });
    expect(await call('o8_view_image_attachment_status', { request_id: pending.request_id })).toMatchObject({ status: 'completed', allow_background: true });
    expect(host.querySelectorAll('img')).toHaveLength(1); expect(frame).not.toHaveBeenCalled();
    render(); render();
    expect(host.querySelectorAll('img')).toHaveLength(1); expect(sent).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    // Explicit test-only submit through the production composer send hook. The
    // agent tool did not send; dispatch is a fixture and never reaches a provider.
    await act(async () => { submitDraft!(); });
    expect(sent).toHaveBeenCalledExactlyOnceWith('unsent', [{ name: 'fixture.png', dataUri: `data:image/png;base64,${image}` }]);
  });
  it('promotes background work without consuming mixed manual queues or cancelled frames', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); deferred = true;
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { queued.push(callback); return queued.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const manual = async (name: string) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File([atob(image)], name, { type: 'image/png' })] });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      await act(async () => readers.at(-1)!.onload?.());
    };
    await manual('first.png'); expect(host.querySelectorAll('img')).toHaveLength(0);
    const pending = await attach({ allow_background: true });
    await act(async () => readers.at(-1)!.onload?.());
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('completed');
    expect([...host.querySelectorAll('img')].map(img => img.alt)).toEqual(['fixture.png']);
    await manual('second.png');
    // Call even cancelled fixture frames to verify their stale snapshots cannot
    // duplicate an image or remove files queued by another upload.
    await act(async () => { for (const callback of queued) callback(0); });
    expect([...host.querySelectorAll('img')].map(img => img.alt)).toEqual(['fixture.png', 'first.png', 'second.png']);
    render(); expect(host.querySelectorAll('img')).toHaveLength(3); expect(sent).not.toHaveBeenCalled();
  });
  it('retains the image cap and duplicate refusal for immediate background commits', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    let completed: Record<string, unknown> = {};
    for (let count = 0; count < 4; count++) {
      const pending = await attach({ allow_background: true });
      completed = await call('o8_view_image_attachment_status', { request_id: pending.request_id });
      expect(completed.status).toBe('completed');
    }
    expect((await attach({ allow_background: true, request_id: completed.request_id })).code).toBe('duplicate_request');
    expect((await attach({ allow_background: true })).code).toBe('image_capacity');
    render(); expect(host.querySelectorAll('img')).toHaveLength(4); expect(frame).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  });
  it('retains manual queued work while refusing a stale mixed background read', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); deferred = true;
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { queued.push(callback); return queued.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([atob(image)], 'manual.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => readers[0].onload?.());
    const pending = await attach({ allow_background: true }); context = 'changed-mixed-chat'; render();
    await act(async () => readers[1].onload?.());
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('target_changed');
    await act(async () => { for (const callback of queued) callback(0); });
    expect([...host.querySelectorAll('img')].map(img => img.alt)).toEqual(['manual.png']); expect(sent).not.toHaveBeenCalled();
  });
  it('retains frame scheduling for ordinary visible uploads when RAF is stalled', async () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const pending = await attach();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    expect(frame).toHaveBeenCalled(); expect(host.querySelectorAll('img')).toHaveLength(0); expect(sent).not.toHaveBeenCalled();
  });
  it('requires explicit background mode at inspect and attach, acknowledging the normal React commit', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    for (const options of [{}, { allow_background: false }]) {
      expect(await call('o8_view_inspect_composer', options)).toMatchObject({ code: 'no_active_composer', reason: 'hidden_document', allow_background: false, document_visibility: 'hidden' });
    }
    const inspection = await call('o8_view_inspect_composer', { allow_background: true });
    expect(inspection).toMatchObject({ status: 'ready', allow_background: true, document_visibility: 'hidden' });
    expect((await attach({ composer_id: inspection.composer_id, allow_background: false })).code).toBe('no_active_composer');
    const focus = vi.spyOn(host.querySelector('textarea')!, 'focus');
    const pending = await attach({ allow_background: true }); await frames();
    expect(focus).not.toHaveBeenCalled();
    expect(await call('o8_view_image_attachment_status', { request_id: pending.request_id })).toMatchObject({ status: 'completed', composer_id: inspection.composer_id, allow_background: true, document_visibility: 'hidden' });
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('fixture.png'); expect(sent).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')?.value).toBe('unsent');
  });
  it.each([null, 'true', 1])('refuses malformed background mode %s before decode/upload', async allow_background => {
    expect((await call('o8_view_inspect_composer', { allow_background })).code).toBe('invalid_schema');
    expect((await attach({ allow_background })).code).toBe('invalid_schema');
    expect(decoders).toHaveLength(0); expect(readers).toHaveLength(0);
  });
  it.each(['css', 'visibility', 'geometry', 'disconnected', 'disabled', 'inactive', 'missing-upload', 'ambiguous'])('retains %s refusal in explicit background mode', async condition => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const original = await call('o8_view_inspect_composer', { allow_background: true });
    const textarea = host.querySelector('textarea')!;
    if (condition === 'css') textarea.style.display = 'none';
    if (condition === 'visibility') textarea.style.visibility = 'hidden';
    if (condition === 'geometry') vi.spyOn(textarea, 'getBoundingClientRect').mockReturnValue({ width: 0, height: 0 } as DOMRect);
    if (condition === 'disconnected') textarea.remove();
    if (condition === 'disabled') textarea.disabled = true;
    if (condition === 'inactive') textarea.removeAttribute('data-o8-active-composer');
    if (condition === 'missing-upload') { noUpload = true; render(); }
    if (condition === 'ambiguous') addComposer();
    const result = await call('o8_view_inspect_composer', { allow_background: true });
    expect(result.code).toBe('no_active_composer'); expect(result.reason).toEqual(condition === 'ambiguous' ? 'ambiguous_composer' : expect.any(String));
    expect((await attach({ allow_background: true, composer_id: original.composer_id })).status).toBe('error');
    expect(readers).toHaveLength(0); expect(decoders).toHaveLength(0);
  });
  it('rotates the background identity on context change and refuses the stale nonce', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const original = await call('o8_view_inspect_composer', { allow_background: true });
    context = 'new-background-chat'; render();
    expect((await call('o8_view_inspect_composer', { allow_background: true })).composer_id).not.toBe(original.composer_id);
    expect((await attach({ allow_background: true, composer_id: original.composer_id })).code).toBe('stale_composer');
    expect(readers).toHaveLength(0); expect(decoders).toHaveLength(0);
  });
  it('expires a background decode and does not replay or upload a late result', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); decodeDeferred = true;
    const startedAt = Date.now();
    const pending = await attach({ allow_background: true });
    vi.setSystemTime(startedAt + 19_999);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    vi.setSystemTime(startedAt + 20_000);
    expect(await call('o8_view_image_attachment_status', { request_id: pending.request_id })).toMatchObject({ code: 'upload_expired', allow_background: true });
    await act(async () => decoders[0].resolve()); await frames();
    expect(readers).toHaveLength(0); expect(decoders).toHaveLength(1);
  });
  it('keeps corrupt background bytes correlated and prevents upload', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const pending = await attach({ allow_background: true, data_base64: corruptImage });
    expect(await call('o8_view_image_attachment_status', { request_id: pending.request_id })).toMatchObject({ code: 'invalid_image', allow_background: true, document_visibility: 'hidden' });
    expect(readers).toHaveLength(0); expect(sent).not.toHaveBeenCalled();
  });
  it.each(['decode', 'upload', 'commit', 'dispose', 'disabled', 'ambiguous'])('invalidates background target during %s', async condition => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    decodeDeferred = condition !== 'upload' && condition !== 'commit'; deferred = true;
    const pending = await attach({ allow_background: true });
    if (condition === 'commit') await act(async () => {
      readers[0].onload?.(); context = 'background-changed-at-commit'; root.render(createElement(Harness));
    });
    if (condition === 'dispose') act(() => root.render(null));
    else if (condition === 'disabled') host.querySelector('textarea')!.disabled = true;
    else if (condition === 'ambiguous') addComposer();
    else if (condition !== 'commit') { context = 'background-context-changed'; render(); }
    await act(async () => { for (const decoder of decoders) decoder.resolve(); for (const reader of readers) reader.onload?.(); });
    await frames();
    expect(await call('o8_view_image_attachment_status', { request_id: pending.request_id })).toMatchObject({ code: 'target_changed', allow_background: true });
    expect(host.querySelectorAll('img')).toHaveLength(0); expect(sent).not.toHaveBeenCalled();
  });
  it('retains each request mode during status and refuses duplicate requests under another mode', async () => {
    decodeDeferred = true;
    const visible = await attach();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(await call('o8_view_image_attachment_status', { request_id: visible.request_id })).toMatchObject({ code: 'target_changed', allow_background: false, document_visibility: 'hidden' });
    const background = await attach({ allow_background: true });
    expect(await call('o8_view_image_attachment_status', { request_id: background.request_id })).toMatchObject({ status: 'pending', allow_background: true });
    expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    expect((await call('o8_view_image_attachment_status', { request_id: background.request_id, allow_background: false })).code).toBe('invalid_schema');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    expect((await attach({ request_id: background.request_id, allow_background: false })).code).toBe('duplicate_request');
    await act(async () => decoders.at(-1)!.resolve()); await frames();
    expect(await call('o8_view_image_attachment_status', { request_id: background.request_id })).toMatchObject({ status: 'completed', allow_background: true, document_visibility: 'visible' });
  });
  it('bounds receipts and reclaims expired terminal records without disposing the active composer', async () => {
    let now = Date.now() + 700_000;
    vi.setSystemTime(now);
    const original = await call('o8_view_inspect_composer');
    failed = true;
    let terminal: Record<string, unknown> = {};
    for (let count = 0; count < 64; count++) {
      terminal = await attach();
      expect(terminal.status).toBe('pending');
      expect((await call('o8_view_image_attachment_status', { request_id: terminal.request_id })).code).toBe('upload_failed');
    }
    expect((await attach()).code).toBe('receipt_capacity');
    now += 700_000; vi.setSystemTime(now);
    expect((await call('o8_view_image_attachment_status', { request_id: terminal.request_id })).code).toBe('unknown_request');
    expect((await call('o8_view_inspect_composer')).composer_id).toBe(original.composer_id);
    failed = false; decodeDeferred = true;
    const pending = await attach();
    now += 19_999; vi.setSystemTime(now);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    expect((await attach()).code).toBe('upload_pending');
    await act(async () => decoders.at(-1)!.resolve()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('completed');
    now += 600_001; vi.setSystemTime(now);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('unknown_request');
    expect((await call('o8_view_inspect_composer')).composer_id).toBe(original.composer_id);
    expect(sent).not.toHaveBeenCalled();
  });

});
