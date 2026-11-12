import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { getWsBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { KnowledgeSource } from '@/lib/operator/knowledge-source-defaults';
/** Every settings writer uses the same removal/cancellation and answer-cache boundary. */
export async function reconcileKnowledgeSources(before: KnowledgeSource[], after: KnowledgeSource[]) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (process.env.O8_NEXT_O8D === '1' && !isNativeCortexReader()) {
    // Window-bearing settings transactions stay in Next. Only WS reconciles their index.
    // Best effort: the settings are already saved, so an unreachable index owner must not
    // fail the save or roll back its window change. WS reindexes on its next reconcile.
    try {
      const response = await fetch(`${getWsBase().replace(/^ws:/, 'http:')}/api/cortex/sources`, {
        method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reconcile', before }), redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (!response.ok) console.warn('[knowledge] Knowledge source reconciliation was not accepted by its owner.');
    } catch {
      console.warn('[knowledge] Knowledge source owner unavailable; reconciliation deferred.');
    }
    return;
  }
  const { ensureKnowledgeSourceWatcher, forgetKnowledgeSource, indexKnowledgeSources } = await import('./index');
  for (const source of before) {
    if (!after.some(next => JSON.stringify(next) === JSON.stringify(source))) forgetKnowledgeSource(source.id);
  }
  ensureKnowledgeSourceWatcher();
  void indexKnowledgeSources();
}
