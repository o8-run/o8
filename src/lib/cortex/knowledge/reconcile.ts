import type { KnowledgeSource } from '@/lib/operator/knowledge-source-defaults';
/** Every settings writer uses the same removal/cancellation and answer-cache boundary. */
export async function reconcileKnowledgeSources(before: KnowledgeSource[], after: KnowledgeSource[]) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const { ensureKnowledgeSourceWatcher, forgetKnowledgeSource, indexKnowledgeSources } = await import('./index');
  for (const source of before) {
    if (!after.some(next => JSON.stringify(next) === JSON.stringify(source))) forgetKnowledgeSource(source.id);
  }
  ensureKnowledgeSourceWatcher();
  void indexKnowledgeSources();
}
