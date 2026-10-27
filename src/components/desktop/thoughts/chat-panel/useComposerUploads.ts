'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { MAX_FILE_SIZE_BYTES, MAX_COMPOSER_IMAGES, type FileUploadHandler, type FileUploadResult } from '@/lib/hooks/use-file-drop';

interface UploadFailure { file: File; error: string }

/** Keep unread files retryable and block Send until every selected image is accounted for. */
export function useComposerUploads(processFiles: FileUploadHandler, draftKey?: string | null, imageSlots = MAX_COMPOSER_IMAGES) {
  const imageSlotsRef = useRef(imageSlots);
  useLayoutEffect(() => { imageSlotsRef.current = imageSlots; }, [imageSlots]);
  const inFlightImages = useRef(0);
  const owner = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ key: typeof draftKey; pending: number; failures: UploadFailure[] }>({ key: draftKey, pending: 0, failures: [] });
  const view = state.key === draftKey ? state : { key: draftKey, pending: 0, failures: [] };
  useLayoutEffect(() => {
    owner.current = new AbortController(); inFlightImages.current = 0;
    return () => { owner.current?.abort(); };
  }, [draftKey]);
  const run = useCallback<FileUploadHandler>(async (files, upload) => {
    const attempt = owner.current;
    if (!attempt) return [];
    const selected = Array.from(files);
    const current = () => !attempt.signal.aborted && (!upload?.isCurrent || upload.isCurrent());
    setState(previous => ({ key: draftKey, pending: previous.key === draftKey ? previous.pending + 1 : 1, failures: previous.key === draftKey ? previous.failures : [] }));
    let results: FileUploadResult[];
    const imageCount = selected.filter(file => file.type.startsWith('image/')).length;
    const overCapacity = imageCount > imageSlotsRef.current - inFlightImages.current;
    if (overCapacity) {
      results = selected.map(() => ({ status: 'error', error: `Attach at most ${MAX_COMPOSER_IMAGES} images. Remove an image before retrying the failed attachment.` }));
    } else {
      inFlightImages.current += imageCount;
      try {
        results = await processFiles(selected, { ...upload, isCurrent: current }) ?? selected.map(() => ({ status: 'error' as const }));
      } catch { results = selected.map(() => ({ status: 'error' })); }
      if (owner.current === attempt) inFlightImages.current -= imageCount;
    }
    if (!attempt.signal.aborted && owner.current === attempt) setState(previous => ({ key: draftKey, pending: Math.max(0, previous.pending - 1),
      failures: !current() ? previous.failures : [
        ...previous.failures.filter(failure => !selected.some(file => file.name === failure.file.name)),
        ...selected.flatMap((file, index) => results[index]?.status === 'read' ? [] : [{ file,
          error: results[index]?.error ?? (file.size > MAX_FILE_SIZE_BYTES
            ? `${file.name}: image exceeds 5 MB. Choose a smaller image or remove the failed attachment.`
            : `${file.name}: image upload could not be read. Retry the upload or remove the failed attachment.`),
        }]),
      ],
    }));
    return results;
  }, [draftKey, processFiles]);
  const retryFailedUploads = useCallback(() => { void run(view.failures.map(failure => failure.file)); }, [run, view.failures]);
  const discardFailedUploads = useCallback(() => setState(previous => ({ ...previous, failures: [] })), []);
  const clearUploads = useCallback(() => {
    owner.current?.abort(); owner.current = new AbortController(); inFlightImages.current = 0;
    setState({ key: draftKey, pending: 0, failures: [] });
  }, [draftKey]);
  return { processFiles: run, uploading: view.pending > 0, failedUploads: view.failures,
    uploadError: view.failures.map(failure => failure.error).join(' ') || null,
    retryFailedUploads, discardFailedUploads, clearUploads };
}
