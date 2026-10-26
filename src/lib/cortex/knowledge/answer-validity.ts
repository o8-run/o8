import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import type { TypedRow } from '@/lib/cortex/qa/types';
export class KnowledgeSourcesChangedError extends Error {
  constructor() { super('Knowledge sources changed while answering. Ask again.'); this.name = 'KnowledgeSourcesChangedError'; }
}
export function assertKnowledgeAnswerCurrent(rows: TypedRow[], revision: string) {
  if (rows.some(row => row.fields.sourceKind === 'knowledge') && revision !== readMemoryRevision()) throw new KnowledgeSourcesChangedError();
}
