import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import type { ComposerQueuePayload, ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';
import { listComposerAttachmentKeys, readComposerAttachmentPayload, removeComposerAttachmentPayload, saveComposerAttachmentPayload } from './composer-queue-attachment-store';
import { readComposerDraftQueueAttempt, retainComposerDraftQueueAttempt } from './composer-draft-store';

interface QueueAttempt { id: string; payload: ComposerQueuePayload }
const PREFIX = 'o8:composer-queue-recovery:v1:';
const LIMIT = 4_000_000;
const memory = new Map<string, QueueAttempt>();
const storedKeys = new Set<string>();
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

class RecoveryLimit extends Error {}
function storageAdvice(error: unknown) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
  if (error instanceof RecoveryLimit) return 'This message is too large to save in a browser record. Shorten it and retry.';
  if (name === 'QuotaExceededError') return 'Browser storage is full. Keep this window open and retry saving this draft.';
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'TimeoutError') return 'Browser storage is unavailable. Keep this window open and allow site storage, then retry.';
  return 'The draft could not be saved because of an unknown storage error. Keep this window open and retry.';
}
export function composerRecoveryNotice(error: unknown, queued: boolean | 'rejected', reason?: string) {
  return `${queued === true ? 'Message queued.' : queued === 'rejected' ? 'Message was not queued.' : 'Queue submission is unconfirmed.'}${reason ? ` ${reason}` : ''} ${storageAdvice(error)} Your draft and attachments are unchanged. ${queued === 'rejected' ? 'Fix the message before retrying.' : 'Retry checks the same send.'}`;
}

async function read(target: ComposerQueueTarget) {
  const prefix = keyFor(target); const entries = new Map<string, QueueAttempt>();
  let failure: unknown;
  for (const [key, value] of memory) if (key.startsWith(prefix)) entries.set(value.id, value);
  const references: string[] = [];
  // Storage access can fail independently of the server queue. Keep the original
  // identity in memory and in the attachment store even if its small index fails.
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      if (raw.length > LIMIT) throw new RecoveryLimit();
      const value: unknown = JSON.parse(raw);
      const reference = value as { id?: unknown; storedPayload?: unknown } | null;
      if (reference?.storedPayload === true && typeof reference.id === 'string' && key === prefix + reference.id) { references.push(key); continue; }
      if (!validAttempt(value) || key !== prefix + value.id) throw new Error('Unreadable saved message');
      entries.set(value.id, value);
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (!['SecurityError', 'InvalidStateError', 'QuotaExceededError'].includes(name)) throw new Error(`Saved messages could not be checked. ${storageAdvice(error)} Inspect this chat before sending again.`);
    failure = error;
  }
  const keys = new Set(references);
  // The same persisted boundary is discoverable after reload without localStorage.
  if (typeof indexedDB !== 'undefined') {
    try { for (const key of await listComposerAttachmentKeys()) if (typeof key === 'string' && key.startsWith(prefix)) keys.add(key); }
    catch { /* A referenced entry below still has to be readable. */ }
  }
  for (const key of keys) {
    if (entries.has(key.slice(prefix.length))) continue;
    const value = await readComposerAttachmentPayload(key);
    if (!validAttempt(value) || key !== prefix + value.id) throw new Error('Saved messages could not be checked. A saved attachment is missing. Inspect this chat before sending again.');
    entries.set(value.id, value); storedKeys.add(key);
  }
  return { entries: [...entries.values()], failure };
}

async function recoveredDraftAttempt(target: ComposerQueueTarget, draft: Pick<ComposerQueuePayload, 'text' | 'images'>) {
  const recovered = await readComposerDraftQueueAttempt(target.threadId);
  return validAttempt(recovered) && sameDraft(recovered, draft) ? recovered : undefined;
}

export async function findPendingComposerSend(target: ComposerQueueTarget, draft: Pick<ComposerQueuePayload, 'text' | 'images'>) {
  return (await read(target)).entries.find(attempt => sameDraft(attempt, draft)) ?? await recoveredDraftAttempt(target, draft);
}
export { composerQueuePayloadMatches } from '@/lib/composer/queue-payload-match';

/** Recovery is best effort; only a matching server receipt confirms queueing. */
export async function prepareComposerSend(target: ComposerQueueTarget, payload: ComposerQueuePayload) {
  const { entries, failure } = await read(target);
  const existing = entries.find(attempt => sameDraft(attempt, payload)) ?? await recoveredDraftAttempt(target, payload);
  const attempt = existing ?? { id: `queue-${crypto.randomUUID()}`, payload: { ...payload, images: normalizeImages(payload.images) } };
  const key = keyFor(target) + attempt.id;
  memory.set(key, attempt);
  let recoveryError = failure;
  try {
    const raw = JSON.stringify(attempt);
    const metadata = JSON.stringify({ ...attempt, payload: { ...attempt.payload, images: [] } });
    if (metadata.length > LIMIT) throw new RecoveryLimit();
    if (attempt.payload.images.length) {
      const saved = existing ? await readComposerAttachmentPayload(key).catch(() => null) : null;
      if (!validAttempt(saved) || JSON.stringify(saved) !== raw) await saveComposerAttachmentPayload(key, attempt);
      storedKeys.add(key);
    }
    await retainComposerDraftQueueAttempt(target.threadId, attempt);
    const manifest = attempt.payload.images.length ? JSON.stringify({ id: attempt.id, storedPayload: true }) : raw;
    if (window.localStorage.getItem(key) !== manifest) window.localStorage.setItem(key, manifest);
  } catch (error) {
    recoveryError = error;
    // A text-only attempt can also survive an unavailable localStorage index.
    if (!attempt.payload.images.length && typeof indexedDB !== 'undefined') await saveComposerAttachmentPayload(key, attempt).then(() => { storedKeys.add(key); }).catch(() => {});
  }
  return { attempt, fresh: !existing, recoveryError };
}

export async function confirmComposerSend(target: ComposerQueueTarget, id: string) {
  const key = keyFor(target) + id;
  try {
    // Discovery must not resurrect a confirmed attachment while its deletion
    // is still pending. Keep submission busy until the transaction commits.
    if (storedKeys.has(key)) await removeComposerAttachmentPayload(key);
    window.localStorage.removeItem(key);
    memory.delete(key); storedKeys.delete(key);
  } catch { throw new Error('The saved send could not be cleared. Inspect this chat before retrying.'); }
}

export function resetComposerQueueRecoveryMemoryForTests() { memory.clear(); storedKeys.clear(); }
