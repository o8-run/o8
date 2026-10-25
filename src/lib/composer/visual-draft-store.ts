import { parseRippleResolutionResult, type RippleChoiceResolution } from '@/lib/mobile/ripple-contract';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import { parseVisualInstruction, visualInstructionScope, type VisualInstruction } from './visual-instruction';

export interface VisualInstructionDraft {
  principal: string;
  request: Omit<VisualInstruction, 'utterance'> & { utterance: string };
  template: ComposerQueuePayload;
  status: 'draft' | 'saving' | 'saved' | 'unknown';
  error?: string;
  inspectionReadyAt?: number;
  visualQuestion?: { key: string; resolution: RippleChoiceResolution; dismissed?: boolean };
  meaningCheck?: { key: string; status: 'none' | 'choice' | 'error' | 'timeout' | 'accepted' | 'dismissed';
    latencyMs: number; resolution?: RippleChoiceResolution; selectedValue?: string };
}
const drafts = new Map<string, VisualInstructionDraft>();
const listeners = new Set<() => void>();
const keyFor = (principal: string, target: VisualInstruction['target']) => JSON.stringify([principal, visualInstructionScope(target)]);
export const subscribeVisualDrafts = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = () => listeners.forEach(listener => listener());
export const readVisualDraft = (principal: string, target: VisualInstruction['target']) => drafts.get(keyFor(principal, target)) ?? null;

let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Visual draft storage is unavailable. Keep this window open.')); return; }
    const opening = indexedDB.open('o8.visual-instructions.v1', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('drafts');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('Unable to open visual draft storage.'));
  }).catch(error => { database = null; throw error; });
  return database;
}
async function persist(key: string, draft: VisualInstructionDraft | null, signal?: AbortSignal): Promise<void> {
  const db = await openDatabase();
  if (signal?.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    const finish = (error?: Error | DOMException) => {
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => {
      try { transaction.abort(); } catch { /* An already completed transaction needs no cancellation. */ }
      finish();
    };
    transaction.oncomplete = () => finish();
    transaction.onerror = () => finish(transaction.error ?? new Error('Unable to save the visual draft.'));
    transaction.onabort = () => finish(signal?.aborted ? undefined : transaction.error ?? new Error('Visual draft saving was interrupted.'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (draft) store.put(draft, key); else store.delete(key);
  });
}

/** Publish immediately, retain on storage error, and serialize writes for each destination. */
const writes = new Map<string, Promise<void>>();
const advisoryWrites = new Map<string, AbortController>();
const revisions = new Map<string, number>();
export function saveVisualDraft(draft: VisualInstructionDraft, options: { advisory?: boolean } = {}): Promise<void> {
  const key = keyFor(draft.principal, draft.request.target);
  // Receipt-only writes yield to normal edits and durable sends, including when
  // an IndexedDB transaction has already started. Aborting prevents stale puts.
  advisoryWrites.get(key)?.abort(); advisoryWrites.delete(key);
  const advisory = options.advisory ? new AbortController() : undefined;
  if (advisory) advisoryWrites.set(key, advisory);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  drafts.set(key, draft); publish();
  const write = (writes.get(key) ?? Promise.resolve()).catch(() => {})
    .then(() => drafts.get(key) === draft ? persist(key, draft, advisory?.signal) : undefined)
    .finally(() => { if (advisory && advisoryWrites.get(key) === advisory) advisoryWrites.delete(key); });
  writes.set(key, write);
  return write.catch(error => {
    if (drafts.get(key) === draft) { drafts.set(key, { ...draft, error: error instanceof Error ? error.message : 'Visual draft saving failed.' }); publish(); }
    throw error;
  });
}

export async function restoreVisualDraft(principal: string, target: VisualInstruction['target']): Promise<void> {
  const key = keyFor(principal, target);
  if (drafts.has(key)) return;
  const revision = revisions.get(key) ?? 0;
  const db = await openDatabase();
  const stored = await new Promise<unknown>((resolve, reject) => {
    const read = db.transaction('drafts', 'readonly').objectStore('drafts').get(key);
    read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
  });
  if (!stored || drafts.has(key) || (revisions.get(key) ?? 0) !== revision) return;
  const value = stored as VisualInstructionDraft;
  const request = parseVisualInstruction(value.request, true);
  if (!request || value.principal !== principal || visualInstructionScope(request.target) !== visualInstructionScope(target)
    || !['draft', 'saving', 'saved', 'unknown'].includes(value.status)
    || !value.template?.routing || typeof value.template.wireMessage !== 'string') return;
  const storedQuestion = value.visualQuestion;
  const resolution = storedQuestion && parseRippleResolutionResult(storedQuestion.resolution);
  const visualQuestion = storedQuestion && typeof storedQuestion.key === 'string' && storedQuestion.key.length <= 32_000 && resolution?.kind === 'choice'
    ? { key: storedQuestion.key, resolution, ...(storedQuestion.dismissed === true ? { dismissed: true } : {}) } : undefined;
  const check = value.meaningCheck;
  const meaningResolution = parseRippleResolutionResult(check?.resolution);
  const meaningCheck = check && typeof check.key === 'string' && check.key.length <= 250_000
    && ['none', 'choice', 'error', 'timeout', 'accepted', 'dismissed'].includes(check.status)
    && Number.isFinite(check.latencyMs) && check.latencyMs >= 0
    && (!['choice', 'accepted'].includes(check.status) || meaningResolution?.kind === 'choice')
    ? { key: check.key, status: check.status, latencyMs: check.latencyMs,
      ...(meaningResolution?.kind === 'choice' ? { resolution: meaningResolution } : {}),
      ...(typeof check.selectedValue === 'string' && check.selectedValue.length <= 96 ? { selectedValue: check.selectedValue } : {}) } : undefined;
  drafts.set(key, { ...value, visualQuestion, meaningCheck, request, status: value.status === 'saving' ? 'unknown' : value.status }); publish();
}

export async function removeVisualDraft(principal: string, target: VisualInstruction['target'], id: string): Promise<void> {
  const key = keyFor(principal, target);
  const removing = drafts.get(key);
  if (removing?.request.id !== id) return;
  advisoryWrites.get(key)?.abort(); advisoryWrites.delete(key);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  const write = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => drafts.get(key) === removing ? persist(key, null) : undefined);
  writes.set(key, write); await write;
  if (drafts.get(key) === removing) { drafts.delete(key); publish(); }
}
