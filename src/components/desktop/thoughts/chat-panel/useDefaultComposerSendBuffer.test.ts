/** @vitest-environment jsdom */
/* eslint-disable react-hooks/refs -- test harness owns its composer ref */
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorSendHandle } from '../useOrchestratorStream';
import { useDefaultComposerSendBuffer } from './useDefaultComposerSendBuffer';

vi.mock('./useDurableComposerQueue', () => ({ useDurableComposerQueue: () => ({ items: [], removing: new Set(), ready: true, error: null, hasPending: () => false, enqueue: vi.fn(), cancel: vi.fn() }) }));

const dispatch = vi.fn(() => ({} as OrchestratorSendHandle));
let container: HTMLDivElement;
let root: Root;

function Harness({ backend, dataUri, active = true, initialInput = 'Inspect this photo' }: { backend: string; dataUri: string; active?: boolean; initialInput?: string }) {
  const [input, setInput] = useState(initialInput);
  const [images, setImages] = useState([{ name: 'photo', dataUri, mimeType: 'image/png' }]);
  const latestInputRef = useRef(input);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { handleSend, attachmentError } = useDefaultComposerSendBuffer({
    active,
    backend,
    busy: false,
    threadId: 'thoughts-photo',
    repoPath: '/tmp/photo-repo',
    attachedImages: images,
    latestInputRef,
    inputRef,
    setInput,
    addAttachedImage: (image) => setImages((current) => [...current, image]),
    clearAttachments: () => setImages([]),
    dispatch,
    captureQueuedSend: () => { throw new Error('No queued send in this idle test.'); },
    interrupt: () => undefined,
    undoSend: () => undefined,
    shouldBypass: () => false,
    sendUnbuffered: () => undefined,
  });
  return createElement('div', null,
    createElement('textarea', { ref: inputRef, value: input, readOnly: true }),
    createElement('span', { 'data-image-count': images.length }),
    createElement('span', { role: 'alert' }, attachmentError),
    createElement('button', { type: 'button', onClick: handleSend }, 'Send'),
  );
}

describe('desktop composer image send', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    dispatch.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the text and image draft when the format is unsupported', async () => {
    act(() => root.render(createElement(Harness, { backend: 'codex', dataUri: 'data:image/heic;base64,aW1hZ2U=' })));
    await act(async () => { container.querySelector('button')?.click(); });
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('Inspect this photo');
    expect(container.querySelector('[data-image-count]')?.getAttribute('data-image-count')).toBe('1');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('PNG, JPEG, GIF, or WebP');
  });

  it('keeps the full draft when the selected backend cannot receive images', async () => {
    act(() => root.render(createElement(Harness, { backend: 'opencode', dataUri: 'data:image/png;base64,aW1hZ2U=' })));
    await act(async () => { container.querySelector('button')?.click(); });
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('Inspect this photo');
    expect(container.querySelector('[data-image-count]')?.getAttribute('data-image-count')).toBe('1');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('cannot receive images');
  });

  it('sends a supported image and then clears the composer draft', async () => {
    const image = 'data:image/png;base64,aW1hZ2U=';
    act(() => root.render(createElement(Harness, { backend: 'codex', dataUri: image })));
    await act(async () => { container.querySelector('button')?.click(); });
    expect(dispatch).toHaveBeenCalledWith('Inspect this photo', [{ name: 'photo', dataUri: image }]);
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(container.querySelector('[data-image-count]')?.getAttribute('data-image-count')).toBe('0');
  });

  it('sends an image even when the text composer is empty', async () => {
    const image = 'data:image/png;base64,aW1hZ2U=';
    act(() => root.render(createElement(Harness, { backend: 'codex', dataUri: image, initialInput: '' })));
    await act(async () => { container.querySelector('button')?.click(); });
    expect(dispatch).toHaveBeenCalledWith('[Image attached]', [{ name: 'photo', dataUri: image }]);
    expect(container.querySelector('[data-image-count]')?.getAttribute('data-image-count')).toBe('0');
  });
});
