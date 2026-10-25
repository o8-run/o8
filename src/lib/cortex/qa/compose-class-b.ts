import { KnowledgeSourcesChangedError } from '@/lib/cortex/knowledge/answer-validity';
import 'server-only';
import { composeConnectedBrain } from './compose-connected';

import {
  buildCitationLookup,
  rowDisplayTitle,
  translateCitations,
  type CitationLookup,
} from '@/lib/cortex/qa/citations';
import { composeClassA, limitCitationMarkers, ManagedBrainUnavailableError, type SseEmit } from '@/lib/cortex/qa/compose-class-a';
import {
  buildSonnetComposeSystem,
  buildSonnetComposeUser,
  type ComposeOptions,
} from '@/lib/prompts/v1';
import { detectContradictions } from '@/lib/cortex/qa/contradictions';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callOpenRouter } from '@/lib/cortex/qa/llm/openrouter-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import type { TypedRow } from '@/lib/cortex/qa/types';
import { resolveBrainUseClaudeCliSync, resolveBrainUseCodexCliSync, usesManagedBrainInferenceSync } from '@/lib/operator/brain-routing';
import { createRoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import { isRuntimeQuotaLimitError } from '@/lib/orchestrator/cross-house-policy';
import { flushBrainQuotaAlerts, noteBrainQuotaError } from './brain-quota-alert';

export async function composeClassB(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  options: ComposeOptions = {},
): Promise<void> {
  if (await composeConnectedBrain(question, repoPath, topRows, emit, options)) return;
  const lookup = buildCitationLookup(topRows);
  // O8_EVAL_MODE=1 routes Class B through OpenRouter (non-streaming) instead
  // of Sonnet CLI. ~14-16s saved per multi-fact case during eval iteration.
  // Eval doesn't care about TTFT — only final answer correctness. Production
  // path (Sonnet CLI streaming) is unchanged.
  const evalMode = process.env.O8_EVAL_MODE === '1' || process.env.O8_EVAL_MODE === 'true';

  if (usesManagedBrainInferenceSync()) {
    return composeClassBViaManaged(question, repoPath, topRows, emit, lookup, options);
  }

  const claudeCliAllowed = resolveBrainUseClaudeCliSync();
  const codexCliAllowed = resolveBrainUseCodexCliSync();

  if (!claudeCliAllowed) {
    return codexCliAllowed
      ? composeClassBViaCodex(question, repoPath, topRows, emit, lookup, options)
      : composeClassA(question, repoPath, topRows, emit, options);
  }

  if (evalMode) {
    return composeClassBViaSonnetAdapter(
      question,
      repoPath,
      topRows,
      emit,
      lookup,
      codexCliAllowed,
      options,
    );
  }

  try {
    const result = await callSonnet({
      system: buildSonnetComposeSystem(options),
      messages: [
        {
          role: 'user',
          content: buildSonnetComposeUser(question, repoPath, topRows),
        },
      ],
      stream: true,
      // 300s — production Class B is the Sonnet CLI path users on Claude Max
      // get for free. Bootstrap + multi-row synthesis can hit 90-180s; the
      // prior 60s default killed the call before generation finished and
      // forced fall-through to paid OpenRouter. With 300s the free CLI tier
      // actually delivers.
      timeoutMs: 300_000,
    });
    if (result.tier === 'flash' && codexCliAllowed) {
      return composeClassBViaCodex(question, repoPath, topRows, emit, lookup, options);
    }

    // Consume the token stream, emitting each token and accumulating for
    // citation post-processing. Works for all three tiers (cli/api/flash).
    let fullText = '';
    for await (const token of result.tokens) {
      if (!token) continue;
      fullText += token;
      if (!options.terse) emit('token', { text: token });
    }
    if (isRuntimeQuotaLimitError(fullText)) {
      throw new Error(`Claude subscription unavailable: ${fullText.trim()}`);
    }

    // Post-process: translate bracket citations → verified CITATION markers.
    let finalAnswer = '';
    if (fullText.trim()) {
      const { translatedAnswer: translated, verifiedRows } = translateCitations(fullText, lookup);
      const citationRows = options.terse ? verifiedRows.slice(0, 2) : verifiedRows;
      finalAnswer = options.terse ? limitCitationMarkers(translated, citationRows) : translated;
      if (options.terse) emit('token', { text: finalAnswer });
      for (const row of citationRows) {
        emit('citation', {
          kind: row.citation.kind,
          rowId: `${row.citation.kind}-${row.citation.rowId}`,
          table: row.citation.table,
          title: rowDisplayTitle(row),
          excerpt: row.citation.excerpt,
          url: row.citation.url, sourcePath: row.citation.sourcePath,
        });
      }
    } else {
      // Nothing streamed — emit a default message.
      emit('token', { text: 'I don\'t have that information yet — try indexing more directives or PRs.' });
    }

    // Contradiction pass — runs after the answer streams (non-blocking to TTFT).
    const contradictions = await detectContradictions({ rows: topRows, answer: finalAnswer });
    for (const c of contradictions) {
      emit('contradiction', c);
    }

    emit('done', {});
  } catch (err) {
    if (err instanceof KnowledgeSourcesChangedError) throw err;
    noteBrainQuotaError(err, 'anthropic');
    flushBrainQuotaAlerts(emit);
    const message = err instanceof Error ? err.message : 'composer-B error';
    console.warn('[qa][composer-B] error:', message);
    if (codexCliAllowed) {
      return composeClassBViaCodex(question, repoPath, topRows, emit, lookup, options);
    }
    return composeClassA(question, repoPath, topRows, emit, options);
  }
}

/** Entitled auto mode has one payer: the managed inference route. */
async function composeClassBViaManaged(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  lookup: CitationLookup,
  options: ComposeOptions,
): Promise<void> {
  try {
    const system = buildSonnetComposeSystem(options);
    const user = buildSonnetComposeUser(question, repoPath, topRows);
    const fullText = await callOpenRouter(`<system>\n${system}\n</system>\n\n${user}`, {
      timeoutMs: 300_000,
      managedOnly: true,
    });
    recordManagedBrainReceipt(repoPath, 'selected', 'Managed inference answered the Brain reasoning request.');
    const { translatedAnswer: translated, verifiedRows } = translateCitations(fullText, lookup);
    const citationRows = options.terse ? verifiedRows.slice(0, 2) : verifiedRows;
    const finalAnswer = options.terse ? limitCitationMarkers(translated, citationRows) : translated;
    emit('token', { text: finalAnswer || 'I don\'t have that information yet.' });
    for (const row of citationRows) {
      emit('citation', {
        kind: row.citation.kind,
        rowId: `${row.citation.kind}-${row.citation.rowId}`,
        table: row.citation.table,
        title: rowDisplayTitle(row),
        excerpt: row.citation.excerpt,
        url: row.citation.url, sourcePath: row.citation.sourcePath,
      });
    }
    if (finalAnswer.trim()) {
      const contradictions = await detectContradictions({ rows: topRows, answer: finalAnswer });
      for (const contradiction of contradictions) emit('contradiction', contradiction);
    }
    emit('done', {});
  } catch (err) {
    if (err instanceof KnowledgeSourcesChangedError) throw err;
    console.warn('[qa][composer-B] managed inference failed:', err instanceof Error ? err.message : err);
    recordManagedBrainReceipt(repoPath, 'failed', 'Managed inference was unavailable or its allowance was reached.');
    throw new ManagedBrainUnavailableError();
  }
}

function recordManagedBrainReceipt(
  repoPath: string | undefined,
  status: 'selected' | 'failed',
  reason: string,
): void {
  recordRoleRoutingReceiptSafely({
    role: 'brain',
    repoPath: repoPath ?? null,
    contextType: 'brain-compose',
    requested: createRoleRouteChoice({ backend: 'auto', runtime: null, model: null, effort: null }),
    effective: status === 'selected'
      ? createRoleRouteChoice({ backend: 'managed-inference', runtime: null, model: null, effort: null })
      : null,
    sources: {
      backend: 'derived',
      runtime: 'request-time',
      model: 'request-time',
      effort: 'request-time',
    },
    reason,
    status,
  });
}

async function composeClassBViaCodex(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  lookup: CitationLookup,
  options: ComposeOptions,
): Promise<void> {
  try {
    const system = buildSonnetComposeSystem(options);
    const user = buildSonnetComposeUser(question, repoPath, topRows);
    const fullText = await callCodex(`<system>\n${system}\n</system>\n\n${user}`, {
      timeoutMs: 300_000,
    });
    if (isRuntimeQuotaLimitError(fullText)) {
      throw new Error(`Codex subscription unavailable: ${fullText.trim()}`);
    }
    console.info('[qa][composer-B] resolved via codex-cli');

    const { translatedAnswer: translated, verifiedRows } = translateCitations(fullText, lookup);
    const citationRows = options.terse ? verifiedRows.slice(0, 2) : verifiedRows;
    const finalAnswer = options.terse ? limitCitationMarkers(translated, citationRows) : translated;
    emit('token', { text: finalAnswer || 'I don\'t have that information yet.' });
    for (const row of citationRows) {
      emit('citation', {
        kind: row.citation.kind,
        rowId: `${row.citation.kind}-${row.citation.rowId}`,
        table: row.citation.table,
        title: rowDisplayTitle(row),
        excerpt: row.citation.excerpt,
        url: row.citation.url, sourcePath: row.citation.sourcePath,
      });
    }

    if (finalAnswer.trim()) {
      const contradictions = await detectContradictions({ rows: topRows, answer: finalAnswer });
      for (const contradiction of contradictions) emit('contradiction', contradiction);
    }
    emit('done', {});
  } catch (err) {
    if (err instanceof KnowledgeSourcesChangedError) throw err;
    noteBrainQuotaError(err, 'openai');
    flushBrainQuotaAlerts(emit);
    console.warn('[qa][composer-B] Codex CLI failed:', err instanceof Error ? err.message : err);
    return composeClassA(question, repoPath, topRows, emit, options);
  }
}

/**
 * Eval-mode Class B path. Routes the Sonnet system+user prompt through the
 * REPL one-shot adapter (subscription-billed, #1124) instead of either Sonnet
 * CLI streaming or paid OpenRouter `anthropic/claude-sonnet-5`. Same
 * adapter the production Class B path uses (`callSonnet`) — just non-streaming
 * because eval cares about final answer correctness, not TTFT.
 *
 * (Renamed from `composeClassBViaOpenRouter` 2026-06-11 — the implementation
 * stopped touching OpenRouter for the Anthropic models long ago and the old
 * name actively misled the tier-chain audit.)
 */
async function composeClassBViaSonnetAdapter(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  lookup: CitationLookup,
  codexCliAllowed: boolean,
  options: ComposeOptions = {},
): Promise<void> {
  try {
    const result = await callSonnet({
      system: buildSonnetComposeSystem(options),
      messages: [
        {
          role: 'user',
          content: buildSonnetComposeUser(question, repoPath, topRows),
        },
      ],
      stream: false,
      // Eval mode tolerates the full Sonnet REPL bootstrap; the runner caps
      // overall wall time per case.
      timeoutMs: 300_000,
    });
    if (result.tier === 'flash') {
      return codexCliAllowed
        ? composeClassBViaCodex(question, repoPath, topRows, emit, lookup, options)
        : composeClassA(question, repoPath, topRows, emit, options);
    }
    const fullText = result.text;
    if (isRuntimeQuotaLimitError(fullText)) {
      throw new Error(`Claude subscription unavailable: ${fullText.trim()}`);
    }

    let finalAnswer = '';
    if (fullText.trim()) {
      const { translatedAnswer: translated, verifiedRows } = translateCitations(fullText, lookup);
      const citationRows = options.terse ? verifiedRows.slice(0, 2) : verifiedRows;
      finalAnswer = options.terse ? limitCitationMarkers(translated, citationRows) : translated;
      emit('token', { text: options.terse ? finalAnswer : fullText });
      for (const row of citationRows) {
        emit('citation', {
          kind: row.citation.kind,
          rowId: `${row.citation.kind}-${row.citation.rowId}`,
          table: row.citation.table,
          title: rowDisplayTitle(row),
          excerpt: row.citation.excerpt,
          url: row.citation.url, sourcePath: row.citation.sourcePath,
        });
      }
    } else {
      emit('token', { text: 'I don\'t have that information yet — try indexing more directives or PRs.' });
    }

    if (finalAnswer.trim()) {
      try {
        const contradictions = await detectContradictions({ rows: topRows, answer: finalAnswer });
        for (const c of contradictions) {
          emit('contradiction', c);
        }
      } catch {
        // Contradiction pass is best-effort.
      }
    }

    emit('done', {});
  } catch (err) {
    if (err instanceof KnowledgeSourcesChangedError) throw err;
    noteBrainQuotaError(err, 'anthropic');
    flushBrainQuotaAlerts(emit);
    const message = err instanceof Error ? err.message : 'composer-B-eval error';
    console.warn('[qa][composer-B-eval] error:', message);
    if (codexCliAllowed) {
      return composeClassBViaCodex(question, repoPath, topRows, emit, lookup, options);
    }
    return composeClassA(question, repoPath, topRows, emit, options);
  }
}
