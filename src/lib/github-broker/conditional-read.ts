import 'server-only';

interface Saved { text: string; headers: Headers }
interface Entry { saved?: Saved; etag?: string; pending?: Promise<Saved>; savedAt?: number }
const entries = new Map<string, Entry>();
const MAX_BYTES = 2 * 1024 * 1024;
async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('GitHub response is too large.'); chunks.push(value); }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
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
      const saved = { text: await boundedBody(response), headers: new Headers(response.headers) };
      // Never retain a malformed answer or interpret it as no updates.
      JSON.parse(saved.text);
      entry.saved = saved; entry.savedAt = Date.now(); entry.etag = response.headers.get('etag') ?? undefined;
      return saved;
    })().catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error; })
      .finally(() => { entry.pending = undefined; });
  }
  const saved = await entry.pending;
  return new Response(saved.text, { status: 200, headers: saved.headers });
}
