import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import type { ComposerQueuePayload, ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';
import { listComposerAttachmentKeys, readComposerAttachmentPayload, removeComposerAttachmentPayload, saveComposerAttachmentPayload } from './composer-queue-attachment-store';
import { composerDraftKey, onComposerDraftCleared, readComposerDraftQueueAttempt, retainComposerDraftQueueAttempt } from './composer-draft-store';

interface QueueAttempt { id: string; payload: ComposerQueuePayload; accepted?: true }
const PREFIX = 'o8:composer-queue-recovery:v1:';
const LIMIT = 4_000_000;
const memory = new Map<string, QueueAttempt>();
const storedKeys = new Set<string>();
const retiredKeys = new Set<string>();
let acceptanceRevision = 0;
const acceptedVersions = new Map<string, number>();
const clearRevisions = new Map<string, number>();
const clearTasks = new Map<string, Promise<void>>();
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
  const revision = clearRevisions.get(target.threadId);
  await clearTasks.get(target.threadId);
  const { entries, failure } = await read(target);
  const existing = entries.find(attempt => sameDraft(attempt, payload)) ?? await recoveredDraftAttempt(target, payload);
  const attempt = existing ?? { id: `queue-${crypto.randomUUID()}`, payload: { ...payload, images: normalizeImages(payload.images) } };
  const key = keyFor(target) + attempt.id;
  if (revision !== clearRevisions.get(target.threadId)) throw new Error('The draft was cleared before submission. No message was queued.');
  retiredKeys.delete(key);
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
  if (revision !== clearRevisions.get(target.threadId)) {
    await confirmComposerSend(target, attempt.id);
    throw new Error('The draft was cleared before submission. No message was queued.');
  }
  return { attempt, fresh: !existing, recoveryError };
}

/** Remember receipt confirmation even when the localStorage manifest failed. */
export async function acceptComposerSend(target: ComposerQueueTarget, attempt: QueueAttempt) {
  const key = keyFor(target) + attempt.id;
  if (retiredKeys.has(key) || (!memory.has(key) && !storedKeys.has(key))) return;
  acceptedVersions.set(key, ++acceptanceRevision);
  const accepted: QueueAttempt = { ...attempt, accepted: true };
  const revision = clearRevisions.get(target.threadId);
  memory.set(key, accepted);
  try {
    if (storedKeys.has(key)) await saveComposerAttachmentPayload(key, accepted);
    if (!attempt.payload.images.length) window.localStorage.setItem(key, JSON.stringify(accepted));
  } catch { /* Confirmation is server-owned; storage failure cannot reject it. */ }
  if (revision !== clearRevisions.get(target.threadId)) await confirmComposerSend(target, attempt.id).catch(() => {});
}

/** Capture before GET so an older empty response cannot retire a newly accepted send.
 * Absence is terminal only for a previously confirmed receipt. Unknown sends keep
 * their original identity until the server confirms them or the operator discards. */
export async function captureComposerRecoveryReconcile(target: ComposerQueueTarget) {
  const revision = clearRevisions.get(target.threadId);
  const acceptedBeforeRead = acceptanceRevision;
  const { entries } = await read(target);
  return async (items: readonly { id: string; status: string; payload: ComposerQueuePayload }[]) => {
    for (const attempt of entries) {
      const key = keyFor(target) + attempt.id;
      if (revision !== clearRevisions.get(target.threadId) || retiredKeys.has(key)
        || (acceptedVersions.get(key) ?? 0) > acceptedBeforeRead) continue;
      const item = items.find(item => item.id === attempt.id);
      if ((!item && attempt.accepted) || item?.status === 'applied' || item?.status === 'cancelled') await confirmComposerSend(target, attempt.id);
      else if (item && !attempt.accepted && JSON.stringify(item.payload) === JSON.stringify(attempt.payload)) {
        // A successful read also settles a lost POST response.
        memory.set(keyFor(target) + attempt.id, attempt);
        await acceptComposerSend(target, attempt);
      }
    }
  };
}

function threadForRecoveryKey(key: string) {
  if (!key.startsWith(PREFIX)) return null;
  try { return (JSON.parse(key.slice(PREFIX.length, key.lastIndexOf(':'))) as ComposerQueueTarget).threadId; }
  catch { return null; }
}
onComposerDraftCleared(threadId => {
  clearRevisions.set(threadId, (clearRevisions.get(threadId) ?? 0) + 1);
  const keys = new Set<string>();
  for (const key of memory.keys()) if (threadForRecoveryKey(key) === threadId) { keys.add(key); memory.delete(key); retiredKeys.add(key); }
  const pending = (clearTasks.get(threadId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    // Discover records left by another mount or by a failed manifest write.
    const draftPrefix = 'o8:composer-draft:v1:' + composerDraftKey(null, 'queue-recovery', threadId) + ':';
    if (typeof indexedDB !== 'undefined') for (const key of await listComposerAttachmentKeys()) {
      if (typeof key === 'string' && (threadForRecoveryKey(key) === threadId || key.startsWith(draftPrefix))) keys.add(key);
    }
    try { for (const key of Object.keys(window.localStorage)) if (threadForRecoveryKey(key) === threadId) keys.add(key); } catch { /* IndexedDB is independent. */ }
    for (const key of keys) {
      if (storedKeys.has(key) || typeof indexedDB !== 'undefined') await removeComposerAttachmentPayload(key);
      try { window.localStorage.removeItem(key); } catch { /* No image payload remains in the attachment store. */ }
      storedKeys.delete(key); retiredKeys.add(key);
    }
  });
  clearTasks.set(threadId, pending);
  void pending.finally(() => { if (clearTasks.get(threadId) === pending) clearTasks.delete(threadId); }).catch(() => {});
});

export async function confirmComposerSend(target: ComposerQueueTarget, id: string) {
  const key = keyFor(target) + id;
  retiredKeys.add(key);
  try {
    // Discovery must not resurrect a confirmed attachment while its deletion
    // is still pending. Keep submission busy until the transaction commits.
    if (storedKeys.has(key)) await removeComposerAttachmentPayload(key);
    else if (typeof indexedDB !== 'undefined') await removeComposerAttachmentPayload(key).catch(() => {});
    window.localStorage.removeItem(key);
    memory.delete(key); storedKeys.delete(key);
  } catch { retiredKeys.delete(key); throw new Error('The saved send could not be cleared. Inspect this chat before retrying.'); }
}

export function resetComposerQueueRecoveryMemoryForTests() { memory.clear(); storedKeys.clear(); retiredKeys.clear(); acceptedVersions.clear(); acceptanceRevision = 0; clearRevisions.clear(); clearTasks.clear(); }
