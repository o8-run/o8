import { resolveProviderKey } from '@/lib/providers/key-store';
import 'server-only';
import { composeConnectedBrain } from './compose-connected';

import {
  buildCitationHandle,
  buildCitationLookup,
  rowAuthority,
  rowDisplayTitle,
  rowFullText,
  translateCitations,
  type CitationLookup,
} from '@/lib/cortex/qa/citations';
import {
  buildFlashComposePrompt,
  buildSonnetComposeSystem,
  buildSonnetComposeUser,
  type ComposeOptions,
} from '@/lib/prompts/v1';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { isByokRequired } from '@/lib/cortex/qa/llm/byok-keys';
import { callOpenRouter, OPENROUTER_PRIMARY_MODEL } from '@/lib/cortex/qa/llm/openrouter-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import type { TypedRow } from '@/lib/cortex/qa/types';
import { getOperatorDefaultsSync, type ClassAComposer } from '@/lib/operator/defaults';
import { usesManagedBrainInferenceSync } from '@/lib/operator/brain-routing';
import { createRoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import { flushBrainQuotaAlerts, noteBrainQuotaError } from './brain-quota-alert';

export type SseEmit = (name: string, payload: unknown) => void;

export const MANAGED_BRAIN_UNAVAILABLE_MESSAGE = 'Managed Brain inference is unavailable or its allowance is reached. Select Subscription in Brain settings to use a connected CLI.';

/** A managed-only request failed. Callers must surface it and never cache it. */
export class ManagedBrainUnavailableError extends Error {
  readonly code = 'managed_brain_unavailable';

  constructor() {
    super(MANAGED_BRAIN_UNAVAILABLE_MESSAGE);
    this.name = 'ManagedBrainUnavailableError';
  }
}

/**
 * Class A compose chain (rewired in #915 path-to-70 phase 1.7 v2):
 *   1. Haiku CLI   — Claude Max subscription, no per-token cost. Primary.
 *   2. Codex CLI   — ChatGPT Plus / Codex subscription, also free. Two CLIs
 *                     beat one for users with either sub. ~15s vs ~14s Haiku.
 *   3. OpenRouter  — gemini-2.5-flash-lite primary (grok-4.1-fast DEPRECATED
 *                     by xAI 2026-06-11) w/ gpt-5.4-nano + grok-4.3 in-call
 *                     fallback. Paid HTTP, ~1-3s, daily-capped in brain-spend.ts.
 *   4. Flash       — Google AI key. Demoted because of recent 503 churn.
 *   5. Sonnet CLI  — slow (5-12s) but reliable when everything else 503s.
 *   6. Heuristic   — final fallback when every LLM is unavailable.
 *
 * Each tier returns a raw answer string (or null on failure). After we get
 * an answer, we translate bracket citations → CITATION markers, emit tokens
 * and verified citations, then `done`. The path that resolved is logged so
 * we can track tier health in production.
 */
export async function composeClassA(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  options: ComposeOptions = {},
): Promise<void> {
  if (await composeConnectedBrain(question, repoPath, topRows, emit, options)) return;
  flushBrainQuotaAlerts(emit);
  const lookup = buildCitationLookup(topRows);
  const rowsJson = JSON.stringify(
    topRows.slice(0, 15).map((r) => ({
      handle: buildCitationHandle(r),
      // Prefer the full row content over the FTS snippet — snippets are
      // truncated to ~8 tokens around the BM25 match (e.g. "A CI «regression»
      // «gate» requires that no «eval»…") and strip the very numbers/values
      // the question is asking about. Falling back to the snippet only when
      // no fuller text is available.
      content: rowFullText(r) || r.citation.excerpt || '',
      // Source-of-truth hierarchy (#915 follow-up). Composer prompt rules
      // tell the model to prefer higher-authority rows when facts conflict.
      // Default 0.5 for non-fact rows or legacy facts pre-v18 backfill.
      source_authority: rowAuthority(r),
    })),
  );
  // #1122 — when ANY directive (seed-* or spec-ingest:*) is at the head of
  // the topRows list, flip the composer's "prefer FACT-" rule to
  // "prefer the directive". `unionMerge` already pins directives ABOVE facts
  // for Class A; this prompt change makes the composer respect that ordering
  // when picking lead citations.
  const leadKind = topRows[0]?.citation.kind;
  const specIngestPresent = leadKind === 'directive';
  const composePrompt = buildFlashComposePrompt(question, rowsJson, {
    specIngestPresent,
    terse: options.terse,
  });
  // O8_EVAL_MODE=1 is the ship-gate / smoke path. We use Sonnet 4.6 via
  // OpenRouter (~$0.026/run) because false negatives cost more in re-
  // investigation than the bill. Production user chat (non-eval-mode)
  // routes through Haiku CLI tier 1 — free for Claude Max users.
  const evalMode = process.env.O8_EVAL_MODE === '1' || process.env.O8_EVAL_MODE === 'true';
  const routingSnapshot = (() => {
    try {
      return getOperatorDefaultsSync();
    } catch {
      return null;
    }
  })();

  let brainCliOn = false;
  let codexCliOn = true;
  try {
    const routing = await import('@/lib/operator/brain-routing');
    brainCliOn = routing.resolveBrainUseClaudeCliSync();
    codexCliOn = routing.resolveBrainUseCodexCliSync();
  } catch {
    brainCliOn = false;
    codexCliOn = true;
  }

  // #971: in production, the user-selected `classAComposer` setting picks
  // which CLI tier leads. Eval mode is never affected (smoke gate is fixed).
  const configuredClassAMode: ClassAComposer = evalMode
    ? 'auto'
    : routingSnapshot?.values.classAComposer ?? 'auto';
  const classAMode = configuredClassAMode;
  const sonnetCliFirst = classAMode === 'sonnet-cli' && brainCliOn;
  let triedSonnetCli = false;
  const attemptedRoutes: string[] = [];
  if (!brainCliOn && (configuredClassAMode === 'haiku-cli' || configuredClassAMode === 'sonnet-cli')) {
    attemptedRoutes.push(`${configuredClassAMode} (Brain CLI disabled or unavailable)`);
  }
  const recordBrainResolution = (input: {
    backend: string;
    runtime: 'codex' | 'claude-code' | null;
    model: string | null;
    effort?: ReturnType<typeof getOperatorDefaultsSync>['values']['brainCodexEffort'] | null;
    label: string;
    status?: 'selected' | 'fallback' | 'failed';
  }) => {
    if (evalMode) return;
    const earlierRoutes = attemptedRoutes.slice(0, -1);
    const composerSource = routingSnapshot?.sources?.classAComposer ?? 'default';
    recordRoleRoutingReceiptSafely({
      role: 'brain',
      repoPath: repoPath ?? null,
      contextType: 'brain-compose',
      requested: createRoleRouteChoice({
        backend: configuredClassAMode,
        runtime: null,
        model: null,
        effort: null,
      }),
      effective: input.status === 'failed'
        ? null
        : createRoleRouteChoice({
          backend: input.backend,
          runtime: input.runtime,
          model: input.model,
          effort: input.effort ?? null,
        }),
      sources: {
        backend: composerSource,
        runtime: input.runtime ? 'derived' : 'request-time',
        model: input.runtime === 'codex'
          ? routingSnapshot?.sources?.brainCodexModel ?? 'default'
          : input.model ? 'derived' : 'request-time',
        effort: input.runtime === 'codex'
          ? routingSnapshot?.sources?.brainCodexEffort ?? 'default'
          : 'request-time',
      },
      reason: `Brain composition resolved through ${input.label}.`,
      fallbackReason: earlierRoutes.length > 0
        ? `Earlier routes were unavailable or failed: ${earlierRoutes.join(' → ')}.`
        : null,
      status: input.status ?? (earlierRoutes.length > 0 ? 'fallback' : 'selected'),
    });
  };

  // Entitled auto mode is deliberately fail-closed. It must not spend a CLI
  // subscription, a BYOK key, or a local provider after the managed service
  // returns a cap or availability error.
  if (usesManagedBrainInferenceSync()) {
    attemptedRoutes.push('managed-inference');
    const managedAnswer = await tryComposeOpenRouter(composePrompt, undefined, true);
    if (managedAnswer) {
      recordBrainResolution({ backend: 'managed-inference', runtime: null, model: null, label: 'managed inference' });
      emitClassAAnswer(managedAnswer, lookup, emit, options);
      return;
    }
    recordBrainResolution({
      backend: 'managed-inference',
      runtime: null,
      model: null,
      label: 'managed inference unavailable',
      status: 'failed',
    });
    throw new ManagedBrainUnavailableError();
  }

  // Eval-mode tier 0: Sonnet 4.6 via the REPL adapter (subscription-billed,
  // #1124) — best reasoning + synthesis, never hedges when rows answer the
  // question. Routed through `tryComposeSonnet` (the adapter) instead of
  // `tryComposeOpenRouter('anthropic/...')` so eval doesn't burn paid
  // OpenRouter credits on the Anthropic models.
  if (evalMode && brainCliOn) {
    attemptedRoutes.push('sonnet-repl');
    const sonnetAnswer = await tryComposeSonnet(question, repoPath, topRows, options);
    flushBrainQuotaAlerts(emit);
    if (sonnetAnswer) {
      console.info('[qa][composer-A] resolved via sonnet-repl (eval tier 0)');
      recordBrainResolution({ backend: 'claude', runtime: 'claude-code', model: 'sonnet', label: 'Sonnet CLI' });
      emitClassAAnswer(sonnetAnswer, lookup, emit, options);
      return;
    }
    // Eval-mode tier 0b: Haiku 4.5 via the REPL adapter as cheap fallback.
    attemptedRoutes.push('haiku-repl');
    const haikuAnswer = await tryComposeHaiku(composePrompt);
    flushBrainQuotaAlerts(emit);
    if (haikuAnswer) {
      console.info('[qa][composer-A] resolved via haiku-repl (eval tier 0b)');
      recordBrainResolution({ backend: 'claude', runtime: 'claude-code', model: 'haiku', label: 'Haiku CLI' });
      emitClassAAnswer(haikuAnswer, lookup, emit, options);
      return;
    }
  }

  if (evalMode && codexCliOn) {
    attemptedRoutes.push('codex-cli');
    const codexAnswer = await tryComposeCodex(composePrompt);
    flushBrainQuotaAlerts(emit);
    if (codexAnswer) {
      console.info('[qa][composer-A] resolved via codex-cli (eval subscription tier)');
      recordBrainResolution({
        backend: 'codex',
        runtime: 'codex',
        model: routingSnapshot?.values.brainCodexModel ?? null,
        effort: routingSnapshot?.values.brainCodexEffort ?? null,
        label: 'Codex CLI',
      });
      emitClassAAnswer(codexAnswer, lookup, emit, options);
      return;
    }
  }

  // 'fastest' mode (2026-06-11): lead with the HTTP tiers — OpenRouter
  // flash-lite answers a Class A compose in ~1-3s for fractions of a cent
  // (daily-capped in brain-spend.ts) where the CLI tiers pay a process
  // bootstrap. On failure fall through into the normal subscription chain
  // below, so the knob never reduces availability.
  if (classAMode === 'fastest') {
    attemptedRoutes.push('inference-route');
    const fastAnswer = await tryComposeOpenRouter(composePrompt);
    if (fastAnswer) {
      console.info(`[qa][composer-A] resolved via openrouter:${OPENROUTER_PRIMARY_MODEL} (mode=fastest)`);
      recordBrainResolution({ backend: 'inference-route', runtime: null, model: null, label: 'managed, local, or BYOK inference route' });
      emitClassAAnswer(fastAnswer, lookup, emit, options);
      return;
    }
    attemptedRoutes.push('flash');
    const fastFlash = await tryComposeFlash(composePrompt);
    if (fastFlash) {
      console.info('[qa][composer-A] resolved via flash (mode=fastest)');
      recordBrainResolution({ backend: 'direct-inference', runtime: null, model: 'gemini-2.5-flash', label: 'direct Flash inference' });
      emitClassAAnswer(fastFlash, lookup, emit, options);
      return;
    }
    // Fall through to the standard chain (Haiku/Codex/Sonnet/heuristic).
  }

  // #971 sonnet-cli mode: lead with Sonnet CLI before Haiku/Codex tiers.
  // Falls through to OpenRouter/Flash/heuristic on failure (Haiku + Codex
  // stay skipped because the user explicitly opted in to Sonnet quality).
  if (sonnetCliFirst) {
    attemptedRoutes.push('sonnet-cli');
    const sonnetAnswer = await tryComposeSonnet(question, repoPath, topRows, options);
    flushBrainQuotaAlerts(emit);
    triedSonnetCli = true;
    if (sonnetAnswer) {
      console.info('[qa][composer-A] resolved via sonnet-cli (mode=sonnet-cli)');
      recordBrainResolution({ backend: 'claude', runtime: 'claude-code', model: 'sonnet', label: 'Sonnet CLI' });
      emitClassAAnswer(sonnetAnswer, lookup, emit, options);
      return;
    }
  }

  // Tier ordering depends on the Brain's own `brainUseClaudeCli` setting
  // (epic #1044; decoupled from the orchestrator toggle 2026-06-22 — a
  // Codex-orchestrator user still gets warm Haiku as tier 1):
  //   - OFF → Codex is effective tier 1, Haiku is skipped (adapter throws).
  //   - ON  → Haiku tier 1, Codex tier 2 (legacy order).
  // Tier 1 (brainUseClaudeCli ON): Haiku CLI. Skipped in eval mode, sonnet-cli
  // mode, or when the setting is OFF.
  if (!evalMode && !sonnetCliFirst && brainCliOn) {
    attemptedRoutes.push('haiku-cli');
    const haikuAnswer = await tryComposeHaiku(composePrompt);
    flushBrainQuotaAlerts(emit);
    if (haikuAnswer) {
      console.info('[qa][composer-A] resolved via haiku-cli (tier 1)');
      recordBrainResolution({ backend: 'claude', runtime: 'claude-code', model: 'haiku', label: 'Haiku CLI' });
      emitClassAAnswer(haikuAnswer, lookup, emit, options);
      return;
    }
  }

  // Tier 1 (brainUseClaudeCli OFF) / Tier 2 (ON): Codex CLI.
  if (!evalMode && !sonnetCliFirst && codexCliOn) {
    attemptedRoutes.push('codex-cli');
    const codexAnswer = await tryComposeCodex(composePrompt);
    flushBrainQuotaAlerts(emit);
    if (codexAnswer) {
      console.info(`[qa][composer-A] resolved via codex-cli (${brainCliOn ? 'tier 2' : 'tier 1 default'})`);
      recordBrainResolution({
        backend: 'codex',
        runtime: 'codex',
        model: routingSnapshot?.values.brainCodexModel ?? null,
        effort: routingSnapshot?.values.brainCodexEffort ?? null,
        label: 'Codex CLI',
      });
      emitClassAAnswer(codexAnswer, lookup, emit, options);
      return;
    }
  }

  // Tier 3: OpenRouter (flash-lite primary w/ gpt-5.4-nano + grok-4.3 fallback).
  attemptedRoutes.push('inference-route');
  const openrouterAnswer = await tryComposeOpenRouter(composePrompt);
  if (openrouterAnswer) {
    console.info(`[qa][composer-A] resolved via openrouter:${OPENROUTER_PRIMARY_MODEL}`);
    recordBrainResolution({ backend: 'inference-route', runtime: null, model: null, label: 'managed, local, or BYOK inference route' });
    emitClassAAnswer(openrouterAnswer, lookup, emit, options);
    return;
  }

  // Tier 4: Flash.
  attemptedRoutes.push('flash');
  const flashAnswer = await tryComposeFlash(composePrompt);
  if (flashAnswer) {
    console.info('[qa][composer-A] resolved via flash');
    recordBrainResolution({ backend: 'direct-inference', runtime: null, model: 'gemini-2.5-flash', label: 'direct Flash inference' });
    emitClassAAnswer(flashAnswer, lookup, emit, options);
    return;
  }

  // Tier 5: Sonnet CLI (callSonnet's CLI tier — slow but reliable). Skipped
  // in eval mode or when sonnet-cli mode already tried it above (#971).
  if (!evalMode && brainCliOn && !triedSonnetCli) {
    attemptedRoutes.push('sonnet-cli');
    const sonnetAnswer = await tryComposeSonnet(question, repoPath, topRows, options);
    flushBrainQuotaAlerts(emit);
    if (sonnetAnswer) {
      console.info('[qa][composer-A] resolved via sonnet-cli');
      recordBrainResolution({ backend: 'claude', runtime: 'claude-code', model: 'sonnet', label: 'Sonnet CLI' });
      emitClassAAnswer(sonnetAnswer, lookup, emit, options);
      return;
    }
  }

  // Tier 6: heuristic.
  attemptedRoutes.push('deterministic-heuristic');
  console.info('[qa][composer-A] resolved via heuristic');
  recordBrainResolution({ backend: 'deterministic-heuristic', runtime: null, model: null, label: 'deterministic heuristic' });
  emit('token', { text: 'I don\'t have that information yet.' });
  emit('done', {});
}

/** Tier 1: Haiku CLI. Free for Claude Max users — primary tier. */
async function tryComposeHaiku(prompt: string): Promise<string | null> {
  try {
    // 30s — Haiku CLI bootstrap is ~6-8s, then synthesis over 30 retrieval
    // rows runs another 10-15s on big multi-row prompts. The previous 12s
    // ceiling killed every smoke composer call before generation completed,
    // forcing a fall-through to grok-4.1-fast which over-rejects the Flash
    // "no info" escape. 30s gives Haiku the room to actually answer; the
    // OpenRouter / Flash tiers below still catch true failures.
    const text = await callHaiku(prompt, { timeoutMs: 30_000 });
    return text.trim() ? text : null;
  } catch (err) {
    noteBrainQuotaError(err, 'anthropic');
    console.warn('[qa][composer-A] Haiku CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 2: Codex CLI. Free for ChatGPT Plus / Codex sub users. */
async function tryComposeCodex(prompt: string): Promise<string | null> {
  try {
    // 30s — Codex bootstrap is ~15s for trivial prompts (verified live with gpt-5.5).
    // The larger ceiling matches the slower bootstrap path; OpenRouter (~1s)
    // is the fast-path fallback below.
    const text = await callCodex(prompt, { timeoutMs: 30_000 });
    return text.trim() ? text : null;
  } catch (err) {
    noteBrainQuotaError(err, 'openai');
    console.warn('[qa][composer-A] Codex CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 3: OpenRouter — flash-lite primary with gpt-5.4-nano + grok-4.3 in-call fallback.
 * Optional `model` override routes to a specific model instead of the primary
 * (used by the eval-mode Haiku-4.5 tier).
 *
 * BYOK gate (#960): when O8_BYOK_REQUIRED=1 and no stored user key exists,
 * this tier is skipped so non-BYOK users don't accidentally burn the
 * founder's OpenRouter credits. Without the flag the existing behaviour is
 * preserved (smoke + dev env always resolve via process.env). */
async function tryComposeOpenRouter(prompt: string, model?: string, managedOnly = false): Promise<string | null> {
  // O8_BYOK_REQUIRED=1 + no stored key → skip tier
  if (!managedOnly && await isByokRequired()) {
    console.info('[qa][composer-A] OpenRouter tier skipped (O8_BYOK_REQUIRED and no stored key)');
    return null;
  }
  try {
    // 25s — was 10s, but ownership questions in eval mode hit grok-4.1-fast
    // with the full 30-row payload (post-slice-fix) and timed out at 10s
    // (caused 35% → 2% ownership crash). p95 for multi-row prompts is past
    // 10s; 25s gives headroom for worst case.
    const text = await callOpenRouter(prompt, { timeoutMs: 25_000, model, managedOnly });
    return text.trim() ? text : null;
  } catch (err) {
    console.warn('[qa][composer-A] OpenRouter failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 3: Flash. Returns answer text or null on any failure. */
async function tryComposeFlash(prompt: string): Promise<string | null> {
  const apiKey =
    resolveProviderKey('GEMINI_API_KEY');
  if (!apiKey) return null;

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[qa][composer-A] Flash error ${res.status}: ${errText.slice(0, 200)} — trying Sonnet CLI`);
      return null;
    }

    const json = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim() ? text : null;
  } catch (err) {
    console.warn('[qa][composer-A] Flash threw:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Tier 5: Sonnet CLI via callSonnet (non-streaming).
 *
 * Reuses Class B's prompt shape (system + user) since Sonnet works best
 * with the structured rows JSON. We only fall here when Haiku CLI,
 * Codex CLI, OpenRouter, and Flash all failed, so the slower latency is
 * acceptable.
 *
 * Returns null when callSonnet itself errors OR when the resolved tier is
 * Flash (we already tried Flash in tier 4 — no point looping back).
 */
async function tryComposeSonnet(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  options: ComposeOptions = {},
): Promise<string | null> {
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
      // 300s — Sonnet CLI bootstrap can take 60-90s and synthesis over the
      // 30-row composer payload runs another 30-60s. The previous default
      // (60s) killed the call before the model even started generating,
      // forcing fall-through to paid OpenRouter even when the user has a
      // free Claude Max sub. 300s lets the CLI actually finish when it's
      // someone's free tier.
      timeoutMs: 300_000,
    });
    if (result.tier === 'flash') {
      // callSonnet degraded back to Flash; we already tried Flash in tier 4.
      return null;
    }
    return result.text.trim() ? result.text : null;
  } catch (err) {
    noteBrainQuotaError(err, 'anthropic');
    console.warn('[qa][composer-A] Sonnet CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Translate bracket citations, emit token + citations + done. Shared by all
 * three LLM tiers so the SSE shape stays identical regardless of which
 * provider answered.
 */
function emitClassAAnswer(
  rawAnswer: string,
  lookup: CitationLookup,
  emit: SseEmit,
  options: ComposeOptions = {},
): void {
  const { translatedAnswer, verifiedRows } = translateCitations(rawAnswer, lookup);
  const citationRows = options.terse ? verifiedRows.slice(0, 2) : verifiedRows;
  const answer = options.terse ? limitCitationMarkers(translatedAnswer, citationRows) : translatedAnswer;
  emit('token', { text: answer });
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
  emit('done', {});
}

export function limitCitationMarkers(answer: string, allowedRows: TypedRow[]): string {
  const allowed = new Set(
    allowedRows.map((row) => `${row.citation.kind}-${row.citation.rowId}`),
  );
  return answer
    .replace(/\[CITATION:([^\]\n]+)\]/g, (marker, id: string) => (
      allowed.has(id) ? marker : ''
    ))
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
