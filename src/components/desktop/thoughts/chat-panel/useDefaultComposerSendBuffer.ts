'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { composerBackendSupportsImages, validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import {
  useComposerSendBuffer,
  type ComposerSendBuffer,
  type ComposerSendImage,
} from '@/lib/hooks/use-composer-send-buffer';
import type { OrchestratorSendHandle } from '../useOrchestratorStream';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import { useDurableComposerQueue } from './useDurableComposerQueue';

interface UseDefaultComposerSendBufferOptions {
  active: boolean;
  blocked?: boolean;
  backend: string;
  capabilityBackend?: string;
  busy: boolean;
  threadId: string | null;
  repoPath: string | null;
  attachedImages: ThoughtsAttachedImage[];
  uploadError?: string | null;
  uploading?: boolean;
  latestInputRef: MutableRefObject<string>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setInput: (text: string) => void;
  addAttachedImage: (image: ThoughtsAttachedImage) => void;
  clearAttachments: () => void;
  dispatch: (text: string, images: ComposerSendImage[]) => OrchestratorSendHandle | null;
  captureQueuedSend: (text: string, images: ComposerSendImage[]) => ComposerQueuePayload;
  interrupt: () => void;
  undoSend: (handle: OrchestratorSendHandle) => void;
  shouldBypass: (text: string) => boolean;
  sendUnbuffered: (text: string) => void;
}

export function useDefaultComposerSendBuffer({
  active,
  blocked = false,
  backend,
  capabilityBackend = backend,
  busy,
  threadId,
  repoPath,
  attachedImages,
  uploadError = null,
  uploading = false,
  latestInputRef,
  inputRef,
  setInput,
  addAttachedImage,
  clearAttachments,
  dispatch,
  captureQueuedSend,
  interrupt,
  undoSend,
  shouldBypass,
  sendUnbuffered,
}: UseDefaultComposerSendBufferOptions): {
  durable: ReturnType<typeof useDurableComposerQueue>;
  sendBuffer: ComposerSendBuffer;
  handleSend: () => void;
  attachmentError: string | null;
  saving: boolean;
  handleSteer: () => void;
} {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const queueOwnerRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    queueOwnerRef.current = {}; savingRef.current = false; setSaving(false);
    return () => { queueOwnerRef.current = null; };
  }, [repoPath, threadId]);
  const imagesRef = useRef(attachedImages); imagesRef.current = attachedImages;
  const uploadStateRef = useRef({ uploading, uploadError });
  useLayoutEffect(() => { uploadStateRef.current = { uploading, uploadError }; }, [uploading, uploadError]);
  const durable = useDurableComposerQueue(active && threadId && repoPath ? { repoPath, threadId } : null, busy, capabilityBackend);
  const restoreDraft = useCallback((text: string, images: ComposerSendImage[]) => {
    setInput(text);
    latestInputRef.current = text;
    clearAttachments();
    for (const image of images) {
      const mimeType = image.dataUri.match(/^data:([^;]+);/)?.[1] ?? 'image/png';
      addAttachedImage({ ...image, mimeType });
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [addAttachedImage, clearAttachments, inputRef, latestInputRef, setInput]);

  const dispatched = useRef<OrchestratorSendHandle | null>(null);
  const trackedDispatch = useCallback((text: string, images: ComposerSendImage[]) => {
    const handle = dispatch(text, images); dispatched.current = handle; return handle;
  }, [dispatch]);
  const sendBuffer = useComposerSendBuffer<OrchestratorSendHandle>({
    busy: active && busy,
    dispatch: trackedDispatch,
    interrupt,
    restore: restoreDraft,
    truncate: undoSend,
  });
  const clearSendBuffer = sendBuffer.clear;
  const scopeRef = useRef({ threadId, repoPath });
  useEffect(() => {
    const previous = scopeRef.current;
    const repoChanged = previous.repoPath !== repoPath;
    const switchedExistingThread = previous.threadId !== null && previous.threadId !== threadId;
    if (repoChanged || switchedExistingThread) { clearSendBuffer(); setAttachmentError(null); }
    scopeRef.current = { threadId, repoPath };
  }, [clearSendBuffer, repoPath, threadId]);

  const submit = useCallback((intent: 'send-next' | 'steer-now') => {
    if (blocked || savingRef.current || uploading || uploadError) return;
    const draft = latestInputRef.current;
    const text = latestInputRef.current.trim() || (attachedImages.length > 0 ? '[Image attached]' : '');
    if (!text) return;
    const images = attachedImages.map((image) => ({ name: image.name, dataUri: image.dataUri }));
    const owner = queueOwnerRef.current;
    savingRef.current = true; setSaving(true);
    void (async () => {
      try {
        const retryPending = active && !shouldBypass(text) && await durable.hasPending(text, images);
        if (queueOwnerRef.current !== owner) return;
        if (images.length > 0) {
          try {
            validateComposerImageAttachments(images);
          } catch (error) {
            setAttachmentError(error instanceof Error ? error.message : 'Invalid image attachment.');
            return;
          }
          if (!active || shouldBypass(text) || (!retryPending && !composerBackendSupportsImages(backend))) {
            setAttachmentError('This chat mode cannot receive images. Select a Codex or Claude agent, then send again.');
            return;
          }
        }
        setAttachmentError(null);
        if (!active || shouldBypass(text)) {
          sendUnbuffered(text);
          return;
        }

        if (!durable.ready) { setAttachmentError('Wait for queued messages to load before sending.'); return; }
        if (busy || durable.items.length > 0 || retryPending) {
          const attachmentSnapshot = JSON.stringify(images);
          const confirm = await durable.enqueue({ text, images }, () => captureQueuedSend(text, images), intent);
          if (queueOwnerRef.current !== owner) return;
          confirm();
          if (latestInputRef.current === draft && JSON.stringify(imagesRef.current.map(image => ({ name: image.name, dataUri: image.dataUri }))) === attachmentSnapshot) {
            setInput(''); latestInputRef.current = ''; clearAttachments();
          }
          return;
        }

        if (!sendBuffer.send(text, images)) return;
        const admission = dispatched.current?.admission;
        if (images.length && admission) {
          const attachmentDraft = imagesRef.current;
          await admission.then(result => {
            if (queueOwnerRef.current !== owner) return;
            if (result.status === 'accepted') {
              if (latestInputRef.current === draft && imagesRef.current === attachmentDraft && !uploadStateRef.current.uploading && !uploadStateRef.current.uploadError) {
                setInput(''); latestInputRef.current = ''; clearAttachments();
              }
            } else if (result.status !== 'cancelled') {
              setAttachmentError(result.status === 'rejected' ? `Image was not sent. ${result.error ?? 'The attachment was refused.'} Fix the error or reattach the image, then send again.`
                : 'Image delivery is unconfirmed. Check the conversation and use Retry there before sending another turn.');
            }
          });
          return;
        }
        if (latestInputRef.current === draft && JSON.stringify(imagesRef.current.map(image => ({ name: image.name, dataUri: image.dataUri }))) === JSON.stringify(images)) {
          setInput(''); latestInputRef.current = ''; clearAttachments();
        }
      } catch (error) {
        if (queueOwnerRef.current === owner) setAttachmentError(error instanceof Error ? error.message : 'Unable to save the queued message.');
      } finally {
        if (queueOwnerRef.current === owner) { savingRef.current = false; setSaving(false); }
      }
    })();
  }, [active, attachedImages, backend, blocked, busy, uploading, uploadError, captureQueuedSend, clearAttachments, durable, latestInputRef, sendBuffer, sendUnbuffered, setInput, shouldBypass]);

  const handleSend = useCallback(() => submit('send-next'), [submit]);
  const supportsSteer = durable.canSteer;
  const handleSteer = useCallback(() => submit(supportsSteer ? 'steer-now' : 'send-next'), [supportsSteer, submit]);
  const queued = durable.items.map(item => ({
    id: item.sequence, text: item.payload.text, images: item.payload.images,
    status: item.status, reason: item.reason,
    cancellable: !durable.removing.has(item.sequence) && (item.status !== 'dispatching' || item.admittedAt === null),
  }));
  return {
    durable,
    sendBuffer: { ...sendBuffer, queued, cancelQueued: id => { void durable.cancel(id); } },
    handleSend, handleSteer, saving: saving || uploading, attachmentError: uploadError ?? (uploading ? 'Wait for the image upload to finish before sending.' : attachmentError ?? durable.error),
  };
}
