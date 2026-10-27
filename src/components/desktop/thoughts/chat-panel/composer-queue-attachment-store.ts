/** Large queued-send payloads use the browser's attachment-capable storage. */
function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined;
    let active: IDBTransaction | undefined;
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { try { active?.abort(); } catch { /* The transaction may already have ended. */ } }
      database?.close();
      if (error) reject(error); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new DOMException('Attachment storage did not respond.', 'TimeoutError')), 10_000);
    try {
      if (typeof indexedDB === 'undefined') throw new DOMException('Attachment storage is unavailable.', 'SecurityError');
      const opening = indexedDB.open('o8.composer-queue-attachments.v1', 1);
      opening.onupgradeneeded = () => { opening.result.createObjectStore('attempts'); };
      opening.onerror = () => finish(opening.error ?? new Error('Attachment storage could not be opened.'));
      opening.onblocked = () => finish(new DOMException('Attachment storage is blocked.', 'SecurityError'));
      opening.onsuccess = () => {
        database = opening.result;
        if (settled) { database.close(); return; }
        try {
          active = database.transaction('attempts', mode);
          const request = action(active.objectStore('attempts'));
          let value: T;
          request.onsuccess = () => { value = request.result; };
          active.oncomplete = () => finish(undefined, value);
          active.onerror = active.onabort = () => finish(active?.error ?? request.error ?? new Error('Attachment storage was interrupted.'));
        } catch (error) { finish(error); }
      };
    } catch (error) { finish(error); }
  });
}

export const saveComposerAttachmentPayload = (key: string, value: unknown) => transaction('readwrite', store => store.put(value, key));
export const readComposerAttachmentPayload = (key: string): Promise<unknown> => transaction('readonly', store => store.get(key));
export const removeComposerAttachmentPayload = (key: string) => transaction('readwrite', store => store.delete(key));
