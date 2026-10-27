'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import { MAX_COMPOSER_IMAGES } from '@/lib/hooks/use-file-drop';
import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import { readComposerAttachmentPayload, removeComposerAttachmentPayload, saveComposerAttachmentPayload } from './composer-queue-attachment-store';

interface ComposerDraft {
  input: string;
  images: ThoughtsAttachedImage[];
  files: string[];
  warning?: string;
  storedImages?: string;
  retryAttempt?: boolean;
}

const PREFIX = 'o8:composer-draft:v1:';
const LIMIT = 4_000_000;
const EMPTY: ComposerDraft = { input: '', images: [], files: [] };
const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();
const WARNING = 'Your latest draft changes could not be saved. Keep this window open to retain them.';
const RESTORE_WARNING = 'Saved draft attachments could not be restored. Reload this window to retry before sending.';
const imageCopies = new Map<string, { reference: string; images: ThoughtsAttachedImage[]; attempt: unknown }>();
const imageLoads = new Map<string, { reference: string; promise: Promise<void> }>();
const observedRecords = new Map<string, string | null>();
const publish = () => listeners.forEach(listener => listener());
const boundKey = (threadId: string) => composerDraftKey(null, 'queue-recovery', threadId)!;
const sendImages = (images: ComposerQueuePayload['images']) => validateComposerImageAttachments(images).map(image => ({ name: image.name ?? 'Image', dataUri: image.dataUri }));
const sendText = (draft: ComposerDraft) => draft.input.trim() || (draft.images.length ? '[Image attached]' : '');
const retireImages = (reference?: string) => { if (reference) void removeComposerAttachmentPayload(reference).catch(() => {}); };

/** Bound drafts follow the conversation through panes and repository aliases.
 * Unsent new conversations remain scoped to their repository and tab. */
export function composerDraftKey(repoPath: string | null | undefined, tabId: string | undefined, threadId: string | null) {
  return tabId ? JSON.stringify([threadId ? null : repoPath ?? null, threadId ? ['thread', threadId] : ['tab', tabId]]) : null;
}

function threadFromKey(key: string): string | null {
  try {
    const [, binding] = JSON.parse(key);
    return Array.isArray(binding) && binding[0] === 'thread' && typeof binding[1] === 'string' ? binding[1] : null;
  } catch { return null; }
}

/** Import the prior repository-scoped format; keep the original as a fallback. */
function legacyThreadDraft(key: string): string | null {
  const threadId = threadFromKey(key);
  if (!threadId) return null;
  for (const candidate of Object.keys(window.localStorage).reverse()) {
    if (!candidate.startsWith(PREFIX) || candidate === PREFIX + key) continue;
    if (threadFromKey(candidate.slice(PREFIX.length)) !== threadId) continue;
    const raw = window.localStorage.getItem(candidate);
    if (!raw || raw.length > LIMIT) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (validDraft(value) && (value.input || value.images.length || value.files.length)) return raw;
    } catch { /* An unrelated unreadable draft must not hide this conversation. */ }
  }
  return null;
}

function read(key: string): ComposerDraft {
  const cached = drafts.get(key);
  if (cached) return cached;
  let draft = EMPTY;
  try {
    const stored = window.localStorage.getItem(PREFIX + key);
    const raw = stored ?? legacyThreadDraft(key);
    if (raw) {
      if (raw.length > LIMIT) throw new Error('Draft exceeds storage limit');
      const value: unknown = JSON.parse(raw);
      if (!validDraft(value)) throw new Error('Unreadable draft');
      draft = { input: value.input, images: value.images, files: value.files };
      if (value.storedImages !== undefined) {
        if (typeof value.storedImages !== 'string' || !value.storedImages.startsWith(PREFIX + key + ':')) throw new Error('Unreadable draft attachments');
        draft.storedImages = value.storedImages;
        draft.retryAttempt = value.retryAttempt === true;
      }
      if (stored === null) {
        try { window.localStorage.setItem(PREFIX + key, raw); }
        catch { draft.warning = WARNING; }
      }
    }
  } catch { draft = { ...EMPTY, warning: WARNING }; }
  try { observedRecords.set(key, window.localStorage.getItem(PREFIX + key)); } catch { /* Keep the storage warning. */ }
  drafts.set(key, draft);
  return draft;
}

function validDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ComposerDraft;
  return typeof draft.input === 'string' && Array.isArray(draft.images) && draft.images.length <= MAX_COMPOSER_IMAGES
    && draft.images.every(image => image && typeof image.name === 'string' && typeof image.dataUri === 'string'
      && typeof image.mimeType === 'string' && image.mimeType.startsWith('image/')
      && image.dataUri.startsWith(`data:${image.mimeType};base64,`))
    && Array.isArray(draft.files) && draft.files.every(file => typeof file === 'string');
}

function write(key: string, draft: ComposerDraft) {
  const previous = drafts.get(key);
  const keepImages = previous?.storedImages && previous.images === draft.images;
  const next: ComposerDraft = { ...draft, warning: undefined,
    storedImages: keepImages ? previous.storedImages : undefined,
    retryAttempt: Boolean(keepImages && previous.retryAttempt && previous.input === draft.input && previous.files === draft.files) };
  try {
    // Keep an empty bound record so clearing/sending cannot resurrect a
    // draft from the previous repository-scoped storage format on restart.
    if (!next.input && !next.images.length && !next.files.length && !threadFromKey(key)) {
      window.localStorage.removeItem(PREFIX + key); observedRecords.set(key, null);
    }
    else {
      if (next.storedImages) {
        const current = JSON.parse(window.localStorage.getItem(PREFIX + key) ?? 'null');
        if (current?.storedImages !== next.storedImages) throw new Error('Draft attachments changed in another window');
      }
      const raw = JSON.stringify({ input: next.input, images: next.storedImages ? [] : next.images, files: next.files,
        revision: crypto.randomUUID(), ...(next.storedImages ? { storedImages: next.storedImages, retryAttempt: next.retryAttempt } : {}) });
      if (raw.length > LIMIT) throw new Error('Draft exceeds storage limit');
      window.localStorage.setItem(PREFIX + key, raw);
      observedRecords.set(key, raw);
    }
  } catch { next.warning = WARNING; }
  drafts.set(key, next);
  if (!keepImages) { imageLoads.delete(key); imageCopies.delete(key); }
  if (!next.warning && previous?.storedImages !== next.storedImages) retireImages(previous?.storedImages);
  publish();
  return !next.warning;
}

/** A queued image owns a draft copy independently of queue confirmation cleanup. */
export async function retainComposerDraftQueueAttempt(threadId: string, attempt: { id: string; payload: ComposerQueuePayload }) {
  const key = boundKey(threadId); const draft = drafts.get(key);
  const { images, ...payload } = attempt.payload;
  if (!draft || sendText(draft) !== payload.text || JSON.stringify(sendImages(draft.images)) !== JSON.stringify(images)
    || JSON.stringify({ input: draft.input, images: draft.images, files: draft.files }).length <= LIMIT) return;
  const before = window.localStorage.getItem(PREFIX + key);
  if (!observedRecords.has(key) || observedRecords.get(key) !== before) throw new Error('The draft changed in another window. Reopen this chat before retrying.');
  const copy = imageCopies.get(key);
  const savedAttempt = copy?.attempt as { id?: unknown; payload?: unknown } | undefined;
  if (draft.retryAttempt && copy?.reference === draft.storedImages && savedAttempt && savedAttempt.id === attempt.id
    && JSON.stringify(savedAttempt.payload) === JSON.stringify(payload)) return;
  const reference = PREFIX + key + ':' + crypto.randomUUID();
  const storedAttempt = { id: attempt.id, payload };
  try {
    await saveComposerAttachmentPayload(reference, { images: draft.images, attempt: storedAttempt });
    const current = drafts.get(key);
    if (current?.images !== draft.images || window.localStorage.getItem(PREFIX + key) !== before) { retireImages(reference); return; }
    const retryAttempt = sendText(current) === payload.text && current.files === draft.files;
    const raw = JSON.stringify({ input: current.input, images: [], files: current.files, storedImages: reference, retryAttempt, revision: crypto.randomUUID() });
    if (raw.length > LIMIT) throw new Error('Draft exceeds storage limit');
    window.localStorage.setItem(PREFIX + key, raw);
    observedRecords.set(key, raw);
    drafts.set(key, { ...current, warning: undefined, storedImages: reference, retryAttempt });
    imageCopies.set(key, { reference, images: current.images, attempt: storedAttempt });
    imageLoads.delete(key); retireImages(current.storedImages); publish();
  } catch (error) { retireImages(reference); throw error; }
}

/** Hydration cannot consume a newer edit, explicit image removal or storage event. */
export async function restoreComposerDraftImages(key: string | null): Promise<ComposerDraft | null> {
  const draft = key ? drafts.get(key) : undefined;
  if (!key || !draft?.storedImages) return null;
  if (window.localStorage.getItem(PREFIX + key) !== observedRecords.get(key)) throw new Error(RESTORE_WARNING);
  if (imageCopies.get(key)?.reference === draft.storedImages && imageCopies.get(key)?.images === draft.images) return null;
  let load = imageLoads.get(key);
  if (!load || load.reference !== draft.storedImages) {
    const reference = draft.storedImages; const placeholder = draft.images;
    const entry = { reference, promise: Promise.resolve() };
    imageLoads.set(key, entry);
    entry.promise = (async () => {
      try {
        const stored = await readComposerAttachmentPayload(reference) as { images?: unknown; attempt?: unknown } | undefined;
        const current = drafts.get(key);
        if (imageLoads.get(key) !== entry || current?.storedImages !== reference || current.images !== placeholder) return;
        const recovered: unknown = { input: current.input, images: stored?.images, files: current.files };
        if (!validDraft(recovered)) throw new Error('Unreadable draft attachments');
        const pointer = JSON.parse(window.localStorage.getItem(PREFIX + key) ?? 'null');
        if (pointer?.storedImages !== reference) throw new Error('Draft attachments changed in another window');
        drafts.set(key, { ...current, images: recovered.images, warning: undefined });
        imageCopies.set(key, { reference, images: recovered.images, attempt: stored?.attempt });
        publish();
      } catch {
        const current = drafts.get(key);
        if (imageLoads.get(key) === entry && current?.storedImages === reference) {
          drafts.set(key, { ...current, warning: RESTORE_WARNING }); publish();
        }
        throw new Error(RESTORE_WARNING);
      }
    })();
    load = entry;
  }
  await load.promise;
  return drafts.get(key) ?? null;
}

/** A failed draft clear must retain the original id even after queue cleanup. */
export async function readComposerDraftQueueAttempt(threadId: string): Promise<unknown> {
  const key = boundKey(threadId); read(key); await restoreComposerDraftImages(key);
  const draft = drafts.get(key); const copy = imageCopies.get(key);
  if (!draft?.retryAttempt || !copy || copy.reference !== draft.storedImages || !copy.attempt || typeof copy.attempt !== 'object') return null;
  const attempt = copy.attempt as { id?: unknown; payload?: unknown };
  if (!attempt.payload || typeof attempt.payload !== 'object') return null;
  return { id: attempt.id, payload: { ...attempt.payload, images: sendImages(draft.images) } };
}

/** Commit a recovered draft's consumption in one write before retiring its id. */
export function consumeRecoveredComposerDraft(threadId: string, text: string, images: ComposerQueuePayload['images']) {
  const key = boundKey(threadId); const draft = drafts.get(key);
  if (!draft?.storedImages) return true;
  if (!draft.retryAttempt || sendText(draft) !== text || JSON.stringify(sendImages(draft.images)) !== JSON.stringify(sendImages(images))) return false;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    const saved = JSON.parse(raw ?? 'null');
    if (raw !== observedRecords.get(key)) throw new Error('Draft changed in another window');
    if (saved?.storedImages !== draft.storedImages || saved.input !== draft.input) throw new Error('Draft changed in another window');
    const empty = JSON.stringify({ ...EMPTY, revision: crypto.randomUUID() });
    window.localStorage.setItem(PREFIX + key, empty); observedRecords.set(key, empty);
  }
  catch { drafts.set(key, { ...draft, warning: WARNING }); publish(); return false; }
  drafts.set(key, EMPTY); imageLoads.delete(key); imageCopies.delete(key); retireImages(draft.storedImages); publish();
  return true;
}

export function captureComposerDraft(key: string | null) {
  return key ? read(key) : EMPTY;
}

export function moveComposerDraft(from: string, to: string, draft: ComposerDraft) {
  if (draft.storedImages && imageCopies.get(from)?.images !== draft.images) {
    drafts.set(from, { ...draft, warning: 'Wait for saved attachments to finish restoring before starting a fresh conversation.' }); publish();
    return false;
  }
  if (!write(to, draft)) {
    drafts.set(from, { ...draft, warning: WARNING });
    listeners.forEach(listener => listener());
    return false;
  }
  if (from !== to) write(from, EMPTY);
  return true;
}

function storageChanged(event: StorageEvent) {
  if (event.storageArea !== window.localStorage || (event.key && !event.key.startsWith(PREFIX))) return;
  if (event.key) {
    const key = event.key.slice(PREFIX.length); drafts.delete(key); imageLoads.delete(key); imageCopies.delete(key); observedRecords.delete(key);
  } else { drafts.clear(); imageLoads.clear(); imageCopies.clear(); observedRecords.clear(); }
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', storageChanged);
  };
}

/** Write in the input/attachment action, without a debounce or a teardown-only save. */
export function useComposerDraftValue<K extends 'input' | 'images' | 'files'>(key: string | null, field: K, initial: ComposerDraft[K]) {
  const [transient, setTransient] = useState(initial);
  const owner = useRef<{ key: string | null; field: K } | null>(null);
  useLayoutEffect(() => {
    owner.current = { key, field };
    return () => { owner.current = null; };
  }, [key, field]);
  const snapshot = useCallback(() => key && typeof window !== 'undefined' ? read(key) : EMPTY, [key]);
  const draft = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  useEffect(() => { if (key) void restoreComposerDraftImages(key).catch(() => {}); }, [key, draft.storedImages]);
  const setValue = useCallback<Dispatch<SetStateAction<ComposerDraft[K]>>>((update) => {
    if (!owner.current) return;
    const { key, field } = owner.current;
    if (!key) { setTransient(update); return; }
    const current = read(key);
    write(key, { ...current, [field]: typeof update === 'function' ? update(current[field]) : update });
  }, []);
  const captureOwner = useCallback(() => {
    const expected = owner.current;
    return () => expected !== null && owner.current === expected;
  }, []);
  return { value: key ? draft[field] : transient, setValue, captureOwner, warning: key ? draft.warning : undefined };
}

export function resetComposerDraftMemoryForTests() { drafts.clear(); imageLoads.clear(); imageCopies.clear(); observedRecords.clear(); }
