/**
 * OpenRouter adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.7 v2).
 *
 * Paid HTTP safety net that sits between the two free CLI tiers and Gemini Flash:
 *
 *   composeClassA():  Haiku CLI → Codex CLI → OpenRouter → Flash → Sonnet CLI → heuristic
 *   classifyQuestion: Haiku CLI → Codex CLI → OpenRouter → Flash → heuristic
 *
 * Why this exact model order (empirically picked, not guessed):
 *   We re-baked-off all 6 candidates with a credited account on 2026-04-30
 *   (phase 1.7.1 rerun — the 3 deepseek/gpt-5.4-nano rows that 402'd in the
 *   original bake-off are now measured). 5 calls each on a 1-fact lookup +
 *   5-fact spec prompt, max_tokens=512, temperature=0. The data:
 *
 *     model                          p50 1f   p95 1f   p50 5f   p95 5f   quality   errors
 *     x-ai/grok-4.1-fast             148 ms   189 ms   124 ms   307 ms   3/3 + 3/3 0
 *     google/gemini-2.5-flash-lite   505 ms   535 ms   471 ms   537 ms   3/3 + 3/3 0
 *     openai/gpt-5.4-nano            479 ms   597 ms   386 ms   491 ms   3/3 + 3/3 0
 *     deepseek/deepseek-chat         148 ms  1455 ms   204 ms   988 ms   3/3 + 3/3 0
 *     deepseek/deepseek-v4-pro      1575 ms  7067 ms  1805 ms  3007 ms   3/3 + 3/3 0
 *     openai/gpt-5-nano              397 ms   458 ms   —        —        3/3 + 0/3 8 (empty content)
 *
 *   Five models tied on quality (6/6 — every one enumerated all 5 facts and
 *   cited every handle on the 5-fact prompt). The tiebreaker is latency p95
 *   sum, where Grok 4.1 Fast wins decisively (496 ms vs runners-up 1072+ ms),
 *   followed by Flash-Lite, then gpt-5.4-nano. gpt-5-nano is dropped — it
 *   returned empty content on 8 of 10 calls (provider-side issue, not noise),
 *   so it's net negative as a fallback. DeepSeek-chat has spiky p95 1.5s
 *   (good but inconsistent); deepseek-v4-pro has 7s p95 1-fact and 5x the
 *   price of Grok — both cost more on the latency budget than they save.
 *
 *   Pricing (per M tokens, OpenRouter list 2026-04-30):
 *     grok-4.1-fast            $0.20 / $0.50
 *     gemini-2.5-flash-lite    $0.10 / $0.40 (cheapest)
 *     gpt-5.4-nano             $0.20 / $1.25
 *     deepseek-chat            $0.32 / $0.89
 *     deepseek-v4-pro          $0.435 / $0.87
 *
 *   We use OpenRouter's `models[]` parameter so a single HTTP request fails
 *   over to the next entry on provider error without an extra round-trip
 *   from our adapter.
 *
 * Why a separate adapter (vs. extending haiku-adapter):
 *   - HTTP, not CLI: no shell probing, no spawn cost. ~1s cold-start.
 *   - The chain is hardcoded — tier 3 between two free CLIs (Haiku, Codex)
 *     and Flash. Keeps each adapter single-responsibility.
 */

import 'server-only';

import {
  assertUnderBrainDailyCap,
  recordBrainOpenRouterSpend,
  type OpenRouterUsage,
} from '@/lib/cortex/qa/llm/brain-spend';
import { managedTextModelOptions, O8_MANAGED_TEXT_MODEL, openRouterTextModels, resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';

// ── Public API ───────────────────────────────────────────────────────────────

export interface CallOpenRouterOptions {
  /** Override the primary model. Defaults to OPENROUTER_PRIMARY_MODEL. */
  model?: string;
  /** Override the in-call fallback list. Defaults to OPENROUTER_FALLBACK_MODELS. */
  fallbackModels?: string[];
  /** HTTP timeout. Default 10s — Grok 4.1 Fast 5-fact p50 was 5.7s in the
   *  bake-off, so 8s would cut ~30% of long answers; 10s gives runway. */
  timeoutMs?: number;
  /** Require the entitled managed route and fail closed when it is unavailable. */
  managedOnly?: boolean;
  /** Output budget for longer tool-free text responses. Defaults to 512. */
  maxTokens?: number;
}

/**
 * Primary Brain model: the managed text model. It completed all six tasks of
 * the orchestrator evaluation and runs with reasoning off for these short calls.
 * The earlier primary, gemini-2.5-flash-lite, stays first in the in-call
 * fallback chain for direct OpenRouter keys.
 */
export const OPENROUTER_PRIMARY_MODEL = O8_MANAGED_TEXT_MODEL;

/**
 * In-call fallback chain. OpenRouter's `models[]` parameter auto-fails over
 * to the next entry on provider error, so our adapter doesn't pay for the
 * extra round-trip. (Verified live: a deprecated primary fails over to
 * models[0] inside one request.)
 *
 *   1. google/gemini-2.5-flash-lite — the previous primary, $0.10/$0.40
 *   2. openai/gpt-5.4-nano — bake-off p95 sum 1088 ms, $0.20/$1.25
 *   3. x-ai/grok-4.3       — grok-4.1-fast's successor; pricier ($1.25/$2.50)
 *                            but classifier/composer calls are small enough
 *                            that a last-resort fallback at 6x is still <1¢.
 */
export const OPENROUTER_FALLBACK_MODELS = ['google/gemini-2.5-flash-lite', 'openai/gpt-5.4-nano', 'x-ai/grok-4.3'];

// ── Circuit breaker ──────────────────────────────────────────────────────────
//
// Deterministic hard failures (401 bad key, 402 insufficient credits) don't
// fix themselves between questions — before this breaker existed, a drained
// credit balance meant EVERY ask paid a doomed HTTP round-trip and silently
// demoted the whole pipeline to the slow CLI tiers (live-observed 2026-06-11:
// a 402 was burning ~0.5s per question for weeks). After
// CIRCUIT_TRIP_THRESHOLD consecutive hard failures the tier is skipped
// outright for CIRCUIT_OPEN_MS; any success closes it again.

const CIRCUIT_TRIP_THRESHOLD = 2;
const CIRCUIT_OPEN_MS = 10 * 60_000;

let consecutiveHardFailures = 0;
let circuitOpenUntil = 0;

function isHardFailureStatus(status: number): boolean {
  return status === 401 || status === 402;
}

function recordHardFailure(status: number, detail: string): void {
  consecutiveHardFailures += 1;
  if (consecutiveHardFailures >= CIRCUIT_TRIP_THRESHOLD && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    console.warn(
      `[qa][openrouter] circuit OPEN for ${CIRCUIT_OPEN_MS / 60_000}min after ${consecutiveHardFailures} consecutive HTTP ${status} failures: ${detail.slice(0, 160)}`,
    );
  }
}

function recordSuccess(): void {
  if (circuitOpenUntil > 0) {
    console.info('[qa][openrouter] circuit CLOSED (call succeeded)');
  }
  consecutiveHardFailures = 0;
  circuitOpenUntil = 0;
}

/** Test-only: reset breaker state. */
export function resetOpenRouterCircuit(): void {
  consecutiveHardFailures = 0;
  circuitOpenUntil = 0;
  warmupStarted = false;
}

/** True while the breaker is open (tier should be skipped). */
export function isOpenRouterCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

/**
 * Call OpenRouter chat completions with `prompt` as a single user message.
 *
 * Throws on:
 *   - OPENROUTER_API_KEY missing (caller should fall through to next tier)
 *   - Circuit breaker open (repeated 401/402 — caller falls through)
 *   - HTTP timeout
 *   - Non-2xx response
 *   - Empty content
 *
 * Caller is responsible for the fallback chain (Haiku CLI ran before us;
 * Gemini Flash / heuristic come after).
 */
export async function callOpenRouter(
  prompt: string,
  opts: CallOpenRouterOptions = {},
): Promise<string> {
  if (isOpenRouterCircuitOpen()) {
    throw new Error(
      `[qa][openrouter] circuit open (repeated auth/credit failures) — skipping tier until ${new Date(circuitOpenUntil).toISOString()}`,
    );
  }

  // Resolve the route (#monetization Step 2): plan-token proxy first, then
  // liveness-gated local for free users, then the user's own OpenRouter key.
  // Null = no route → the caller falls through to the next CLI tier, exactly
  // as a missing key did before.
  const route = await resolveOpenRouterRoute({ managedOnly: opts.managedOnly });
  if (!route) {
    throw new Error(opts.managedOnly
      ? '[qa][managed] managed inference unavailable (no valid plan token)'
      : '[qa][openrouter] no route (no proxy token, local endpoint, or BYO key)');
  }

  // Keep boot offline. Only a real request headed directly to OpenRouter pays
  // the one-time connection warm-up; local and managed-proxy routes never
  // contact openrouter.ai from this machine.
  if (route.via === 'direct') await warmupOpenRouter();

  // The daily spend cap is the DESKTOP guardrail on the USER's own key/credits.
  // In proxy mode the user isn't spending their own OpenRouter $ (we are) and
  // the proxy enforces its own per-account cap. In local mode the call is free.
  if (route.via === 'direct') await assertUnderBrainDailyCap();

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const primary = route.model ?? opts.model ?? openRouterTextModels(route.via)[0];
  const fallbacks = route.model ? [] : opts.fallbackModels ?? OPENROUTER_FALLBACK_MODELS;

  // OpenRouter accepts `model` (primary) + `models[]` (in-call fallback).
  // Including the primary in `models[]` is harmless but redundant; we keep
  // them separate so the response's actual-served model is unambiguous.
  const body = {
    model: primary,
    ...(fallbacks.length > 0 ? { models: fallbacks } : {}),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: Math.min(Math.max(opts.maxTokens ?? 512, 1), 4096),
    ...managedTextModelOptions(primary),
    // Ask OpenRouter to return the call's cost in the response so the spend
    // ledger records exact figures instead of pricing-table estimates.
    ...(route.via === 'local' ? {} : { usage: { include: true } }),
  };

  let res: Response;
  try {
    res = await fetch(route.url, {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[qa][openrouter] fetch failed: ${message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (route.via !== 'local' && isHardFailureStatus(res.status)) {
      recordHardFailure(res.status, errText);
    }
    const prefix = opts.managedOnly ? '[qa][managed]' : '[qa][openrouter]';
    throw new Error(`${prefix} HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: OpenRouterUsage;
  };

  const text = json.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) {
    throw new Error('[qa][openrouter] empty response content');
  }

  recordSuccess();
  // Only the user's OWN spend is recorded to the desktop ledger; proxy spend is
  // metered server-side (the proxy_usage ledger), not on this machine.
  if (route.via === 'direct') {
    recordBrainOpenRouterSpend(json.model ?? primary, json.usage ?? {});
  }
  return text;
}

/**
 * Resolve which model OpenRouter actually served. Useful for the
 * "[qa][composer-A] resolved via openrouter:<model>" log line.
 *
 * Falls back to the primary model name when the response shape is unexpected.
 */
export function describeOpenRouterModel(servedModel: string | undefined): string {
  return servedModel?.trim() ? servedModel : OPENROUTER_PRIMARY_MODEL;
}

// ── Cold-start pool warm-up (#1123) ──────────────────────────────────────────
//
// The first real call to `callOpenRouter` pays ~1.7s for DNS + TLS + HTTP/2
// connection setup before the request lands on a warm undici pool. Subsequent
// calls hit the pool and run in ~200-700ms. We pre-pay that one-time cost
// lazily by firing a tiny unauthenticated GET against `/api/v1/models`
// immediately before the first real direct request.
//
// The probe is best-effort: it never throws and cannot block application boot.
// The first direct request awaits it; later calls reuse the warmed pool.

let warmupStarted = false;

/**
 * Warm the undici connection pool to openrouter.ai. Idempotent — safe to call
 * many times; only the first call fires a request.
 */
export async function warmupOpenRouter(): Promise<void> {
  if (warmupStarted) return;
  warmupStarted = true;
  const startedAt = Date.now();
  try {
    // GET /api/v1/models is unauthenticated and returns a small JSON catalog.
    // Discard the body — we only care about establishing the TLS session.
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    // Drain the body so the connection returns to the pool keep-alive idle
    // state instead of being torn down.
    await res.arrayBuffer().catch(() => undefined);
    console.info(`[qa][openrouter] warm-up ${res.status} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    // A failed probe must not suppress the real user-initiated call.
    console.info(`[qa][openrouter] warm-up skipped (${Date.now() - startedAt}ms): ${err instanceof Error ? err.message : err}`);
  }
}
