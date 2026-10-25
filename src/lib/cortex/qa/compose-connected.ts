import { KnowledgeSourcesChangedError } from '@/lib/cortex/knowledge/answer-validity';
import 'server-only';

import { currentComposerBrainRoute } from '@/lib/operator/composer-brain-context';
import { resolveBrainCodexRouteSync } from '@/lib/operator/brain-routing';
import { callCodex } from './llm/codex-adapter';
import { askClaudeOneShot } from '@/lib/claude-code/one-shot-repl';
import { buildSonnetComposeSystem, buildSonnetComposeUser, type ComposeOptions } from '@/lib/prompts/v1';
import { buildCitationLookup, rowDisplayTitle, translateCitations } from './citations';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import { createRoleRouteChoice } from '@/lib/operator/role-routing';
import type { TypedRow } from './types';
import type { SseEmit } from './compose-class-a';

/** Interactive answers use the connected runtime's reasoning tier, for both question classes. */
export async function composeConnectedBrain(question: string, repoPath: string | undefined, rows: TypedRow[], emit: SseEmit, options: ComposeOptions): Promise<boolean> {
  const route = currentComposerBrainRoute();
  if (!route?.runtime || !route.model || !route.binary) return false;
  const prompt = `${buildSonnetComposeSystem(options)}\n\n${buildSonnetComposeUser(question, repoPath, rows)}`;
  const choice = createRoleRouteChoice({ backend: route.runtime === 'codex' ? 'codex' : 'claude', runtime: route.runtime, model: route.model, effort: route.runtime === 'codex' ? resolveBrainCodexRouteSync().reasoningEffort ?? null : null });
  const receipt = (status: 'selected' | 'failed') => recordRoleRoutingReceiptSafely({ role: 'brain', repoPath: repoPath ?? null, contextType: 'brain-conversation', requested: choice, effective: status === 'selected' ? choice : null, sources: { backend: 'request-time', runtime: 'derived', model: 'derived', effort: 'derived' }, reason: 'Composer Brain uses the available connected runtime.', fallbackReason: null, status });
  try {
    const text = route.runtime === 'codex'
      ? await callCodex(prompt, { binary: route.binary, model: route.model, timeoutMs: 240_000, readOnly: true })
      : await askClaudeOneShot(prompt, { binary: route.binary, model: route.model, timeoutMs: 240_000, tools: 'none' });
    if (!text.trim()) throw new Error('The connected runtime returned no answer.');
    const { translatedAnswer, verifiedRows } = translateCitations(text, buildCitationLookup(rows));
    emit('token', { text: translatedAnswer });
    for (const row of verifiedRows) emit('citation', { kind: row.citation.kind, rowId: `${row.citation.kind}-${row.citation.rowId}`, table: row.citation.table, title: rowDisplayTitle(row), excerpt: row.citation.excerpt, url: row.citation.url, sourcePath: row.citation.sourcePath });
    receipt('selected'); emit('done', {}); return true;
  } catch (error) {
    if (error instanceof KnowledgeSourcesChangedError) throw error;
    receipt('failed');
    throw new Error(`The connected ${route.runtime === 'codex' ? 'Codex' : 'Claude'} runtime could not answer. Check its connection and try again.`, { cause: error });
  }
}
