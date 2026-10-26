import 'server-only';

interface Saved { text: string; headers: Headers }
interface Entry { saved?: Saved; etag?: string; pending?: Promise<Saved>; savedAt?: number }
const entries = new Map<string, Entry>();
const MAX_BYTES = 2 * 1024 * 1024;
let reportedOversizedResponse = false;
/** Authorization is resolved before this read; the key includes the current credential scope. */
export async function sharedConditionalGitHubRead(key: string, read: (etag?: string) => Promise<Response>, maxAgeMs = 0): Promise<Response> {
  const entry = entries.get(key) ?? {};
  if (entry.saved && Date.now() - (entry.savedAt ?? 0) < maxAgeMs) {
    return new Response(entry.saved.text, { status: 200, headers: entry.saved.headers });
  }
  if (!entry.pending) {
    if (entries.size >= 32 && !entries.has(key)) entries.delete(entries.keys().next().value!);
    entries.set(key, entry);
    entry.pending = (async () => {
      const response = await read(entry.etag);
      if (response.status === 304 && entry.etag && entry.saved) {
        entry.savedAt = Date.now();
        const headers = new Headers(entry.saved.headers); response.headers.forEach((value, name) => headers.set(name, value));
        return { text: entry.saved.text, headers };
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`GitHub read failed (${response.status}).`); }
      const saved = { text: await response.text(), headers: new Headers(response.headers) };
      // Never retain a malformed answer or interpret it as no updates.
      JSON.parse(saved.text);
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
      entry.saved = saved; entry.savedAt = Date.now(); entry.etag = response.headers.get('etag') ?? undefined;
      return saved;
    })().catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error; })
      .finally(() => { entry.pending = undefined; });
  }
  const saved = await entry.pending;
  return new Response(saved.text, { status: 200, headers: saved.headers });
}
