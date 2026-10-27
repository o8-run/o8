import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import type { ComposerQueuePayload, ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';
import { readComposerAttachmentPayload, removeComposerAttachmentPayload, saveComposerAttachmentPayload } from './composer-queue-attachment-store';
import { readComposerDraftQueueAttempt, retainComposerDraftQueueAttempt } from './composer-draft-store';

interface QueueAttempt { id: string; payload: ComposerQueuePayload }
const PREFIX = 'o8:composer-queue-recovery:v1:';
const LIMIT = 4_000_000;
const keyFor = (target: ComposerQueueTarget) => PREFIX + JSON.stringify(target) + ':';
const normalizeImages = (images: ComposerQueuePayload['images']) =>
  validateComposerImageAttachments(images).map(image => ({ name: image.name ?? 'Image', dataUri: image.dataUri }));
const sameDraft = (attempt: QueueAttempt, draft: Pick<ComposerQueuePayload, 'text' | 'images'>) =>
  attempt.payload.text === draft.text && JSON.stringify(attempt.payload.images) === JSON.stringify(normalizeImages(draft.images));

function validAttempt(value: unknown): value is QueueAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<QueueAttempt>;
  return typeof entry.id === 'string' && /^queue-[A-Za-z0-9-]{8,120}$/.test(entry.id)
    && typeof entry.payload?.text === 'string' && typeof entry.payload?.wireMessage === 'string'
    && Array.isArray(entry.payload?.images) && entry.payload.images.every(image =>
      image && typeof image.name === 'string' && typeof image.dataUri === 'string')
    && Boolean(entry.payload?.routing && typeof entry.payload.routing === 'object');
}

function storageAdvice(error: unknown) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
  if (name === 'QuotaExceededError') return 'Browser storage is full. Make room for saved drafts or remove an attachment, then retry.';
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'TimeoutError') return 'Browser storage is unavailable. Keep this window open and allow site storage, then retry.';
  return 'The draft could not be saved. Keep this window open and retry.';
}

async function read(target: ComposerQueueTarget): Promise<QueueAttempt[]> {
  try {
    const prefix = keyFor(target); const storage = window.localStorage; const entries: QueueAttempt[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      if (raw.length > LIMIT) throw new Error('Recovery exceeds storage limit');
      let value: unknown = JSON.parse(raw);
      const reference = value as { id?: unknown; storedPayload?: unknown } | null;
      if (reference?.storedPayload === true && typeof reference.id === 'string' && key === prefix + reference.id) value = await readComposerAttachmentPayload(key);
      if (!validAttempt(value) || key !== prefix + value.id) throw new Error('Unreadable recovery');
      entries.push(value);
    }
    if (entries.length > 20) throw new Error('Recovery exceeds queue limit');
    return entries;
  } catch (error) {
    throw new Error(`Saved messages could not be checked. ${storageAdvice(error)} Inspect this chat before sending again.`);
  }
}

async function recoveredDraftAttempt(target: ComposerQueueTarget, draft: Pick<ComposerQueuePayload, 'text' | 'images'>) {
  const recovered = await readComposerDraftQueueAttempt(target.threadId);
  return validAttempt(recovered) && sameDraft(recovered, draft) ? recovered : undefined;
}

export async function findPendingComposerSend(target: ComposerQueueTarget, draft: Pick<ComposerQueuePayload, 'text' | 'images'>) {
  return (await read(target)).find(attempt => sameDraft(attempt, draft)) ?? await recoveredDraftAttempt(target, draft);
}

export { composerQueuePayloadMatches } from '@/lib/composer/queue-payload-match';

/** Separate keys keep one completion from overwriting another window's pending send. */
export async function prepareComposerSend(target: ComposerQueueTarget, payload: ComposerQueuePayload) {
  const entries = await read(target);
  const existing = entries.find(attempt => sameDraft(attempt, payload)) ?? await recoveredDraftAttempt(target, payload);
  if (existing) {
    try { await retainComposerDraftQueueAttempt(target.threadId, existing); }
    catch (error) { throw new Error(`Saved messages could not be checked. ${storageAdvice(error)} Inspect this chat before sending again.`); }
    return { attempt: existing, fresh: false };
  }
  if (entries.length >= 20) throw new Error('There are 20 unconfirmed sends in this chat. Inspect the chat and retry those messages before adding more.');
  const attempt = { id: `queue-${crypto.randomUUID()}`, payload: { ...payload, images: normalizeImages(payload.images) } };
  const key = keyFor(target) + attempt.id;
  const raw = JSON.stringify(attempt);
  if (raw.length > LIMIT && (!attempt.payload.images.length || JSON.stringify({ ...attempt, payload: { ...attempt.payload, images: [] } }).length > LIMIT)) {
    throw new Error('Message was not queued. This message is too large to save. Shorten it and retry. Your draft and attachments are unchanged.');
  }
  let storedPayload = false;
  try {
    if (raw.length > LIMIT) { await saveComposerAttachmentPayload(key, attempt); storedPayload = true; }
    await retainComposerDraftQueueAttempt(target.threadId, attempt);
    window.localStorage.setItem(key, storedPayload ? JSON.stringify({ id: attempt.id, storedPayload: true }) : raw);
  } catch (error) {
    if (storedPayload) await removeComposerAttachmentPayload(key).catch(() => {});
    throw new Error(`Message was not queued. ${storageAdvice(error)} Your draft and attachments are unchanged.`);
  }
  return { attempt, fresh: true };
}

export function confirmComposerSend(target: ComposerQueueTarget, id: string) {
  const key = keyFor(target) + id;
  try {
    const raw = window.localStorage.getItem(key);
    const storedPayload = raw && (JSON.parse(raw) as { storedPayload?: unknown }).storedPayload === true;
    window.localStorage.removeItem(key);
    // Retire the retry identity first. Cleanup failure cannot turn a confirmed
    // send back into an uncertain draft, which could invite a duplicate send.
    if (storedPayload) void removeComposerAttachmentPayload(key).catch(() => {});
  } catch { throw new Error('The saved send could not be cleared. Keep this draft and retry to check the same send.'); }
}
