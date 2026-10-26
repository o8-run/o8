'use client';

import { useCallback, useEffect, type DragEvent, type RefObject } from 'react';
import { useComposerUploads } from './useComposerUploads';
import { useComposerDraftValue } from './composer-draft-store';
import { useFileDrop, MAX_COMPOSER_IMAGES } from '@/lib/hooks/use-file-drop';

export interface ThoughtsAttachedImage {
  name: string;
  dataUri: string;
  mimeType: string;
  /** Transient upload acknowledgment; omitted from normal send payloads. */
  uploadRequestId?: string;
}

export interface ThoughtsComposerDragHandlers {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

export interface UseThoughtsComposerAttachmentsOptions {
  /** Optional ref to hit-test Tauri drag-drop events against (see #1136). */
  hostRef?: RefObject<HTMLElement | null>;
  draftKey?: string | null;
}

export function useThoughtsComposerAttachments(options?: UseThoughtsComposerAttachmentsOptions) {
  const { value: attachedImages, setValue: setAttachedImages, warning } = useComposerDraftValue(options?.draftKey ?? null, 'images', []);
  const { value: attachedFiles, setValue: setAttachedFiles } = useComposerDraftValue(options?.draftKey ?? null, 'files', []);
  const {
    pendingFiles,
    setPendingFiles,
    dragOver,
    processFiles,
    clearPendingFiles,
    dragHandlers,
  } = useFileDrop({ enablePaste: false, hostRef: options?.hostRef });

  const uploads = useComposerUploads(processFiles, options?.draftKey, MAX_COMPOSER_IMAGES - attachedImages.length - pendingFiles.filter(file => file.mimeType.startsWith('image/')).length);
  const processOwnedFiles = uploads.processFiles;
  const clearUploads = uploads.clearUploads;
  const onDrop = useCallback((event: DragEvent) => {
    dragHandlers.onDragLeave(event);
    if (event.dataTransfer.files.length) void processOwnedFiles(event.dataTransfer.files);
  }, [dragHandlers, processOwnedFiles]);

  useEffect(() => {
    if (pendingFiles.length === 0) return;

    const promote = (files: typeof pendingFiles) => {
      for (const file of files) {
        if (file.isCurrent && !file.isCurrent()) continue;
        if (file.mimeType.startsWith('image/')) {
          setAttachedImages((current) => {
            if ((file.isCurrent && !file.isCurrent()) || current.length >= MAX_COMPOSER_IMAGES || (file.uploadRequestId && current.some(image => image.uploadRequestId === file.uploadRequestId))) return current;
            return [
              ...current,
              {
                name: file.name,
                dataUri: `data:${file.mimeType};base64,${file.content}`,
                mimeType: file.mimeType,
                ...(file.uploadRequestId ? { uploadRequestId: file.uploadRequestId } : {}),
              },
            ];
          });
        } else {
          setAttachedFiles((current) => (
            current.includes(file.name) ? current : [...current, file.name]
          ));
        }
      }
      // Consume only this snapshot, preserving manual/newly queued files.
      setPendingFiles(current => {
        const remaining = current.filter(file => !files.includes(file));
        if (remaining.length === current.length) return current;
        for (const file of current) {
          if (files.includes(file) && file.preview?.startsWith('blob:')) URL.revokeObjectURL(file.preview);
        }
        return remaining;
      });
    };
    const background = pendingFiles.filter(file => file.backgroundAgent === true && file.isCurrent && file.uploadRequestId);
    if (background.length > 0) promote(background);
    const paced = pendingFiles.filter(file => !background.includes(file));
    if (paced.length === 0) return;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => { if (!cancelled) promote(paced); });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [pendingFiles, setAttachedFiles, setAttachedImages, setPendingFiles]);

  const removeAttachedImage = useCallback((index: number) => {
    setAttachedImages((current) => current.filter((_, imageIndex) => imageIndex !== index));
  }, [setAttachedImages]);

  // Swap one attachment in place (e.g. after screenshot annotation) — keeps the
  // array position so the thumbnail updates without a remount, and the send path
  // (which reads live state) picks up the annotated dataUri on the next send.
  const replaceAttachedImage = useCallback((index: number, image: ThoughtsAttachedImage) => {
    setAttachedImages((current) => current.map((im, i) => (i === index ? image : im)));
  }, [setAttachedImages]);

  // Programmatic add (e.g. "Add to chat" from an o8.md inline image). Respects
  // the same image cap as the drop/paste bridge above.
  const addAttachedImage = useCallback((image: ThoughtsAttachedImage) => {
    setAttachedImages((current) => (current.length >= MAX_COMPOSER_IMAGES ? current : [...current, image]));
  }, [setAttachedImages]);

  const removeAttachedFile = useCallback((fileName: string) => {
    setAttachedFiles((current) => current.filter((name) => name !== fileName));
  }, [setAttachedFiles]);

  const clearAttachments = useCallback(() => {
    clearUploads();
    setAttachedImages([]);
    setAttachedFiles([]);
    clearPendingFiles();
  }, [clearPendingFiles, setAttachedFiles, setAttachedImages, clearUploads]);

  const consumeAttachedImages = useCallback((images: ThoughtsAttachedImage[]) => {
    setAttachedImages(current => current.filter(image => !images.includes(image)));
  }, [setAttachedImages]);

  return {
    ...uploads,
    uploading: uploads.uploading || pendingFiles.length > 0,
    attachedImages,
    attachedFiles,
    retentionWarning: warning,
    dragOver,
    dragHandlers: { ...dragHandlers, onDrop },
    processFiles: processOwnedFiles,
    addAttachedImage,
    removeAttachedImage,
    replaceAttachedImage,
    removeAttachedFile,
    clearAttachments,
    consumeAttachedImages,
  };
}
