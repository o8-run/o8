'use client';

import { useCallback, useEffect, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { useTauriFileDrop } from './use-tauri-file-drop';

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Max images a single composer message may carry. Shared so the orchestrator
 * composer and the LLM-chat composer enforce one cap from one source instead
 * of repeating the magic number at each `attachedImages` push site.
 */
export const MAX_COMPOSER_IMAGES = 4;

export interface DroppedFile {
  name: string;
  mimeType: string;
  content: string; // base64
  preview?: string; // ObjectURL for images
  /**
   * Absolute path on disk, populated when the file arrived through the
   * Tauri drag-drop bridge (Finder → app). Undefined for HTML5 drops and
   * pastes — those have no path.
   */
  absolutePath?: string;
  /** Agent upload guard, kept only in transient pending state. */
  isCurrent?: () => boolean;
  uploadRequestId?: string;
  /** Explicit agent-only scheduling policy; never copied into attachments. */
  backgroundAgent?: boolean;
}

export interface UseFileDropOptions {
  /** Maximum number of files allowed at once */
  maxFiles?: number;
  /** Listen for window-level paste events */
  enablePaste?: boolean;
  /**
   * Element to hit-test Tauri drag-drop events against. When provided AND
   * running in Tauri, the hook subscribes to the Rust drag-drop bridge
   * (see #1136) and routes drops landing inside this element through
   * `read_dropped_file`, populating DroppedFile.absolutePath.
   *
   * Omit to keep legacy HTML5-only behavior (used by mobile AgentPanelChat
   * and other surfaces that don't need absolute paths).
   */
  hostRef?: React.RefObject<HTMLElement | null>;
}

export interface FileUploadOptions { isCurrent?: () => boolean; requestId?: string; backgroundAgent?: boolean }
export interface FileUploadResult { status: 'read' | 'skipped' | 'error'; error?: string }
export type FileUploadHandler = (files: FileList | File[], options?: FileUploadOptions) => Promise<FileUploadResult[]> | void;

export interface UseFileDropResult {
  pendingFiles: DroppedFile[];
  setPendingFiles: React.Dispatch<React.SetStateAction<DroppedFile[]>>;
  dragOver: boolean;
  processFiles: FileUploadHandler;
  removePendingFile: (index: number) => void;
  clearPendingFiles: () => void;
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

interface ReadDroppedFileResult {
  name: string;
  mimeType: string;
  contentBase64: string;
  size: number;
}

async function readDroppedFileViaTauri(path: string): Promise<ReadDroppedFileResult | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<ReadDroppedFileResult>('read_dropped_file', { path });
  } catch (err) {
    console.warn(`[file-drop] read_dropped_file failed for ${path}`, err);
    return null;
  }
}

export function useFileDrop(options?: UseFileDropOptions): UseFileDropResult {
  const maxFiles = options?.maxFiles ?? 10;
  const enablePaste = options?.enablePaste ?? true;
  const hostRef = options?.hostRef;

  const [pendingFiles, setPendingFiles] = useState<DroppedFile[]>([]);
  const [htmlDragOver, setHtmlDragOver] = useState(false);

  const processFiles = useCallback((files: FileList | File[], upload?: FileUploadOptions) => (
    Promise.all(Array.from(files).map((file) => new Promise<FileUploadResult>((resolve) => {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        console.warn(`[file-drop] Skipping ${file.name}: exceeds 5 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
        resolve({ status: 'skipped' });
        return;
      }
      const reader = new FileReader();
      reader.onerror = reader.onabort = () => resolve({ status: 'error' });
      reader.onload = () => {
        if (upload?.isCurrent && !upload.isCurrent()) { resolve({ status: 'skipped' }); return; }
        const base64 = (reader.result as string).split(',')[1];
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setPendingFiles((prev) => {
          if ((upload?.isCurrent && !upload.isCurrent()) || prev.length >= maxFiles) {
            if (preview) URL.revokeObjectURL(preview);
            return prev;
          }
          return [...prev, { name: file.name, mimeType: file.type || 'application/octet-stream', content: base64, preview, ...(upload?.isCurrent ? { isCurrent: upload.isCurrent } : {}), ...(upload?.requestId ? { uploadRequestId: upload.requestId } : {}), ...(upload?.backgroundAgent === true && upload.isCurrent && upload.requestId ? { backgroundAgent: true } : {}) }];
        });
        resolve({ status: 'read' });
      };
      try { reader.readAsDataURL(file); } catch { resolve({ status: 'error' }); }
    })))
  ), [maxFiles]);

  // #1136 Tauri drag-drop bridge. When hostRef is provided AND running in
  // Tauri, subscribe to the Rust bridge and route drops through
  // `read_dropped_file`, populating DroppedFile.absolutePath. Skipped
  // otherwise — the HTML5 path below handles every shipping surface.
  //
  // NOTE (2026-05-30): this bridge is currently INERT at runtime. lib.rs emits
  // `o8:tauri-file-drop-*` from `WindowEvent::DragDrop`, which never fires while
  // `dragDropEnabled: false` in tauri.conf.json (the macOS transparency+vibrancy
  // trap — flipping it true kills DragDrop on our window). So all working image
  // drops go through the HTML5 path; this is scaffolding kept for the (greenlit
  // but trap-blocked) #636 native-path epic, not a live code path today.
  const tauriEnabled = Boolean(hostRef) && isTauri();
  const handleTauriDrop = useCallback(
    (paths: string[]) => {
      void (async () => {
        for (const path of paths) {
          const result = await readDroppedFileViaTauri(path);
          if (!result) continue;
          const preview = result.mimeType.startsWith('image/')
            ? `data:${result.mimeType};base64,${result.contentBase64}`
            : undefined;
          setPendingFiles((prev) => {
            if (prev.length >= maxFiles) return prev;
            return [
              ...prev,
              {
                name: result.name,
                mimeType: result.mimeType,
                content: result.contentBase64,
                preview,
                absolutePath: path,
              },
            ];
          });
        }
      })();
    },
    [maxFiles],
  );

  const { dragOver: tauriDragOver } = useTauriFileDrop({
    hostRef: (hostRef ?? { current: null }) as React.RefObject<HTMLElement | null>,
    onDrop: handleTauriDrop,
    disabled: !tauriEnabled,
  });

  const dragOver = htmlDragOver || tauriDragOver;

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const f = prev[index];
      if (f?.preview && f.preview.startsWith('blob:')) URL.revokeObjectURL(f.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearPendingFiles = useCallback(() => {
    setPendingFiles((prev) => {
      prev.forEach((f) => { if (f.preview && f.preview.startsWith('blob:')) URL.revokeObjectURL(f.preview); });
      return [];
    });
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHtmlDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHtmlDragOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHtmlDragOver(false);
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files);
  }, [processFiles]);

  useEffect(() => {
    if (!enablePaste) return undefined;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) processFiles(files);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [enablePaste, processFiles]);

  return {
    pendingFiles,
    setPendingFiles,
    dragOver,
    processFiles,
    removePendingFile,
    clearPendingFiles,
    dragHandlers: { onDragOver, onDragLeave, onDrop },
  };
}
