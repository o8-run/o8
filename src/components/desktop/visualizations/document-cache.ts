import { isVisualizationReference, VISUALIZATION_LIMITS, type VisualizationDocument } from '@/lib/visualizations/types';

const cache = new Map<string, VisualizationDocument>();
type Distance = () => number;
type QueuedLoad = { distances: Distance[]; start: () => void };
const pending = new Map<string, { promise: Promise<VisualizationDocument>; distances: Distance[] }>();
const queue: QueuedLoad[] = [];
const SOURCE_LOAD_LIMIT = 4;
let active = 0;
let scheduled = false;

function scheduleLoads() {
  if (scheduled) return;
  scheduled = true;
  // Collect this render's cards before choosing the nearest ones. Recheck their
  // positions on each drain so scrolling reprioritizes the remaining work.
  setTimeout(() => {
    scheduled = false;
    const ranked = queue.map(load => ({ load, distance: Math.min(...load.distances.map(distance => distance())) }));
    ranked.sort((a, b) => a.distance - b.distance);
    for (const { load } of ranked) {
      if (active >= SOURCE_LOAD_LIMIT) break;
      queue.splice(queue.indexOf(load), 1);
      load.start();
    }
  }, 0);
}
const CACHE_BYTES = 16 * 1024 * 1024;
export function cachedVisualization(id: string): VisualizationDocument | undefined { return cache.get(id); }

export function loadVisualization(id: string, distance: Distance = () => Infinity): Promise<VisualizationDocument> {
  const cached = cache.get(id);
  if (cached) { cache.delete(id); cache.set(id, cached); return Promise.resolve(cached); }
  const underway = pending.get(id);
  if (underway) { underway.distances.push(distance); return underway.promise; }
  const distances = [distance];
  // Queue time counts toward the existing source deadline. Stalled sources must
  // also settle cards still waiting for a slot, without a late request burst.
  const signal = AbortSignal.timeout(12_000);
  const work = new Promise<VisualizationDocument>((resolve, reject) => {
    const expire = () => {
      const index = queue.indexOf(load);
      if (index !== -1) queue.splice(index, 1);
      reject(signal.reason);
    };
    const load: QueuedLoad = { distances, start: () => {
      signal.removeEventListener('abort', expire);
      if (signal.aborted) { reject(signal.reason); return; }
      active++;
      void fetchVisualization(id, signal).then(resolve, reject).finally(() => { active--; scheduleLoads(); });
    } };
    signal.addEventListener('abort', expire, { once: true });
    queue.push(load);
    scheduleLoads();
  }).catch(error => {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('This visualization could not be loaded in time. Retry it or rebuild it from this chat.');
    }
    throw error;
  }).finally(() => pending.delete(id));
  pending.set(id, { promise: work, distances });
  return work;
}

async function fetchVisualization(id: string, signal: AbortSignal): Promise<VisualizationDocument> {
  const response = await fetch(`/api/visualizations/${encodeURIComponent(id)}`, { cache: 'no-store', signal });
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
}
