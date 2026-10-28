import { isVisualizationReference, VISUALIZATION_LIMITS, type VisualizationDocument } from '@/lib/visualizations/types';

const cache = new Map<string, VisualizationDocument>();
const pending = new Map<string, Promise<VisualizationDocument>>();
const CACHE_BYTES = 16 * 1024 * 1024;
export function cachedVisualization(id: string): VisualizationDocument | undefined { return cache.get(id); }

export function loadVisualization(id: string): Promise<VisualizationDocument> {
  const cached = cache.get(id);
  if (cached) { cache.delete(id); cache.set(id, cached); return Promise.resolve(cached); }
  const underway = pending.get(id);
  if (underway) return underway;
  const work = (async () => {
    const response = await fetch(`/api/visualizations/${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    const body = await response.json() as { result?: { visualization?: VisualizationDocument }; error?: { message?: string } };
    const doc = body.result?.visualization;
    if (!response.ok || !doc || !isVisualizationReference(doc) || doc.id !== id || typeof doc.html !== 'string'
      || new TextEncoder().encode(doc.html).length > VISUALIZATION_LIMITS.documentBytes) throw new Error(response.status === 404 ? 'This saved visualization is unavailable. Its source could not be found.' : body.error?.message ?? 'This visualization is unavailable.');
    cache.set(id, doc);
    let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.html.length * 2, 0);
    while (cache.size > 6 || bytes > CACHE_BYTES) {
      const oldest = cache.keys().next().value!;
      const removed = cache.get(oldest)!;
      cache.delete(oldest);
      bytes -= removed.html.length * 2;
    }
    return doc;
  })().catch(error => {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('This visualization could not be loaded in time. Retry it or rebuild it from this chat.');
    }
    throw error;
  }).finally(() => pending.delete(id));
  pending.set(id, work);
  return work;
}
