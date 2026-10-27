/**
 * Operator corrections retriever (#2219).
 *
 * Surfaces rejection reasons (approvals) and steer messages (lane events) for
 * the repos in scope, so a question like "why was the parser change rejected?"
 * cites the operator's own words instead of guessing from outcomes.
 *
 * Ranking is plain token overlap against reason + title + packet id. When the
 * question itself asks about rejections, steering, or feedback, every in-scope
 * correction qualifies and recency breaks ties.
 *
 * Standing (#2395): only operator rows (rejections, operator-sourced steers)
 * carry operator authority. Orchestrator and heal-bot steers are labeled as
 * machine steering, scored at half weight, and cite with a lower authority.
 */

import 'server-only';

import path from 'node:path';

import { readOperatorCorrections, type OperatorCorrection } from '@/lib/cortex/operator-corrections';
import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';

const DEFAULT_LIMIT = 8;
/** An explicit operator ruling — below directives, above agent-written outcomes. */
export const OPERATOR_CORRECTION_AUTHORITY = 0.95;
/** A steer the orchestrator or heal-bot sent — below PRs and issues. */
export const MACHINE_STEER_AUTHORITY = 0.6;
const MACHINE_SCORE_WEIGHT = 0.5;
const SCAN_LIMIT = 100;
const CORRECTION_INTENT = /\b(reject|rejected|rejection|steer|steered|correct|correction|feedback|pushback|disagree|denied)\b/i;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'why', 'what', 'did', 'does', 'with', 'this', 'that', 'from', 'about',
  'how', 'who', 'when', 'where', 'are', 'were', 'has', 'have', 'had', 'its', 'into', 'our', 'operator',
]);

function scopedRepoPaths(input: RetrieverInput): string[] {
  const active = getActiveProjectScopeForRepoSync(input.repoPath);
  if (input.repoPath?.trim()) {
    const explicit = path.resolve(input.repoPath);
    return active.repoInActiveProject ? [explicit, ...active.repoPaths] : [explicit];
  }
  return active.repoPaths;
}

function questionTokens(question: string): string[] {
  return [...new Set(
    question.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}

function scoreCorrection(correction: OperatorCorrection, tokens: string[], question: string): number {
  const haystack = `${correction.reason} ${correction.title} ${correction.packetId ?? ''}`.toLowerCase();
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  const packetMention = correction.packetId && question.toLowerCase().includes(correction.packetId.toLowerCase()) ? 1 : 0;
  const score = (tokens.length > 0 ? matched / tokens.length : 0) + packetMention;
  return correction.standing === 'machine' ? score * MACHINE_SCORE_WEIGHT : score;
}

function toRow(correction: OperatorCorrection, score: number): TypedRow {
  const verb = correction.standing === 'machine'
    ? `Machine steer via ${correction.source ?? 'unknown'}`
    : correction.kind === 'rejected' ? 'Operator rejected' : 'Operator steered';
  return {
    citation: {
      kind: 'correction',
      rowId: correction.rowId,
      table: correction.table,
      excerpt: correction.reason.slice(0, 200),
      title: `${verb}: ${correction.title}`,
    },
    fields: {
      title: `${verb}: ${correction.title}`,
      body: correction.reason,
      correctionKind: correction.kind,
      packetId: correction.packetId,
      repoPath: correction.repoPath,
      source: correction.source,
      standing: correction.standing,
      source_authority: correction.standing === 'machine' ? MACHINE_STEER_AUTHORITY : OPERATOR_CORRECTION_AUTHORITY,
      at: correction.at,
    },
    score,
  };
}

export async function correctionsRetriever(input: RetrieverInput): Promise<RetrieverResult> {
  const started = Date.now();
  const repoPaths = scopedRepoPaths(input);
  if (repoPaths.length === 0) return { retriever: 'corrections', rows: [], durationMs: Date.now() - started };

  const tokens = questionTokens(input.question);
  const intent = CORRECTION_INTENT.test(input.question);
  const projectId = input.projectId ?? getActiveProjectScopeForRepoSync(input.repoPath).projectId;
  const rows = readOperatorCorrections({ repoPaths, projectId, limit: SCAN_LIMIT })
    .map((correction) => ({ correction, score: scoreCorrection(correction, tokens, input.question) }))
    .filter(({ score }) => score > 0 || intent)
    // Stable sort keeps the reader's newest-first order within equal scores.
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map(({ correction, score }) => toRow(correction, score));

  return { retriever: 'corrections', rows, durationMs: Date.now() - started };
}
