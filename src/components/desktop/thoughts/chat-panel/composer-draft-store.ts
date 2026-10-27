'use client';

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';
import { MAX_COMPOSER_IMAGES } from '@/lib/hooks/use-file-drop';

interface ComposerDraft {
  input: string;
  images: ThoughtsAttachedImage[];
  files: string[];
  warning?: string;
}

const PREFIX = 'o8:composer-draft:v1:';
const LIMIT = 4_000_000;
const EMPTY: ComposerDraft = { input: '', images: [], files: [] };
const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();
const WARNING = 'Your latest draft changes could not be saved. Keep this window open to retain them.';

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
      if (stored === null) {
        try { window.localStorage.setItem(PREFIX + key, raw); }
        catch { draft.warning = WARNING; }
      }
    }
  } catch { draft = { ...EMPTY, warning: WARNING }; }
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
  const next: ComposerDraft = { ...draft, warning: undefined };
  try {
    // Keep an empty bound record so clearing/sending cannot resurrect a
    // draft from the previous repository-scoped storage format on restart.
    if (!next.input && !next.images.length && !next.files.length && !threadFromKey(key)) window.localStorage.removeItem(PREFIX + key);
    else {
      const raw = JSON.stringify({ input: next.input, images: next.images, files: next.files });
      if (raw.length > LIMIT) throw new Error('Draft exceeds storage limit');
      window.localStorage.setItem(PREFIX + key, raw);
    }
  } catch { next.warning = WARNING; }
  drafts.set(key, next);
  listeners.forEach(listener => listener());
  return !next.warning;
}

export function captureComposerDraft(key: string | null) {
  return key ? read(key) : EMPTY;
}

export function moveComposerDraft(from: string, to: string, draft: ComposerDraft) {
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
  if (event.key) drafts.delete(event.key.slice(PREFIX.length)); else drafts.clear();
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

export function resetComposerDraftMemoryForTests() { drafts.clear(); }
