import 'server-only';

import { withGitHubAbort } from './abort';

interface Saved { text: string; headers: Headers }
interface Pending { promise: Promise<Saved>; controller: AbortController; consumers: number }
interface Entry { saved?: Saved; etag?: string; pending?: Pending; savedAt?: number }
const entries = new Map<string, Entry>();
const MAX_BYTES = 2 * 1024 * 1024;
const SHARED_READ_TIMEOUT_MS = 30_000;
let reportedOversizedResponse = false;
/** Authorization is resolved before this read; the key includes the current credential scope. */
export async function sharedConditionalGitHubRead(key: string,
  read: (etag: string | undefined, signal: AbortSignal) => Promise<Response>,
  { maxAgeMs = 0, signal }: { maxAgeMs?: number; signal?: AbortSignal | null } = {}): Promise<Response> {
  signal?.throwIfAborted();
  const entry = entries.get(key) ?? {};
  if (entry.saved && Date.now() - (entry.savedAt ?? 0) < maxAgeMs) {
    return new Response(entry.saved.text, { status: 200, headers: entry.saved.headers });
  }
  if (!entry.pending) {
    if (entries.size >= 32 && !entries.has(key)) entries.delete(entries.keys().next().value!);
    entries.set(key, entry);
    // The transport belongs to all consumers, rather than the first caller.
    const controller = new AbortController();
    const pending: Pending = { controller, consumers: 0, promise: undefined! };
    const timer = setTimeout(() => controller.abort(new DOMException('GitHub read timed out.', 'TimeoutError')), SHARED_READ_TIMEOUT_MS);
    timer.unref?.();
    pending.promise = withGitHubAbort(controller.signal, async () => {
      const response = await read(entry.etag, controller.signal);
      controller.signal.throwIfAborted();
      let saved: Saved;
      if (response.status === 304 && entry.etag && entry.saved) {
        const headers = new Headers(entry.saved.headers); response.headers.forEach((value, name) => headers.set(name, value));
        saved = { text: entry.saved.text, headers };
      } else {
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`GitHub read failed (${response.status}).`); }
        saved = { text: await response.text(), headers: new Headers(response.headers) };
        controller.signal.throwIfAborted();
        // Never retain a malformed answer or interpret it as no updates.
        JSON.parse(saved.text);
      }
      // Bound retained cache memory without rejecting a valid larger response.
      // Pending consumers can still share it, but later reads get no validator.
      if (Buffer.byteLength(saved.text, 'utf8') > MAX_BYTES) {
        if (entries.get(key) === entry) entries.delete(key);
        if (!reportedOversizedResponse) {
          reportedOversizedResponse = true;
          console.warn('[github-broker] Skipping conditional cache for responses over 2 MiB.');
        }
        return saved;
      }
      // Abandoned/evicted work must never replace a newer entry for this key.
      if (entries.get(key) === entry) {
        entry.saved = saved; entry.savedAt = Date.now();
        entry.etag = response.headers.get('etag') ?? (response.status === 304 ? entry.etag : undefined);
      }
      return saved;
    }).catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error; })
      .finally(() => { clearTimeout(timer); if (entry.pending === pending) entry.pending = undefined; });
    entry.pending = pending;
  }
  const pending = entry.pending;
  pending.consumers += 1;
  try {
    const saved = await withGitHubAbort(signal, () => pending.promise);
    return new Response(saved.text, { status: 200, headers: saved.headers });
  } finally {
    pending.consumers -= 1;
    if (pending.consumers === 0 && entry.pending === pending) {
      if (entries.get(key) === entry) entries.delete(key);
      entry.pending = undefined;
      pending.controller.abort();
    }
  }
}
