import { resolveProviderKey } from '@/lib/providers/key-store';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { withOptionalAuth, type AuthContext } from '@/lib/auth/middleware';
import { getCurrentPeriodCost } from '@/lib/db/usage';
import { getEntitlementSync } from '@/lib/entitlement/store';
import {
  parseAnthropicStopMetadata,
  resolveAnthropicTaskBudget,
  type AnthropicStopMetadata,
  type ResolvedAnthropicTaskBudget,
} from '@/lib/llm/anthropic-task-budget';
import { getWorkspaceContext, buildSystemPrompt } from '@/lib/llm/context';
import { getPersonalizedChatFtuxPayload } from '@/lib/llm/personalized-chat-ftux';
import { anthropicPricingForModel } from '@/lib/llm/pricing';
import { LLM_REPO_PATH_HEADER } from '@/lib/llm/repo-scope';
import { resolvePromptCachingEnabledSync } from '@/lib/operator/defaults';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';
import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  computeCost,
  isSupportedProvider,
  OPERATOR_OPENROUTER_MODELS,
  OPERATOR_GEMINI_MODEL,
  OPERATOR_GEMINI_ROLLBACK_MODEL,
  PROVIDERS,
  resolveApiKey,
  type Message,
} from './provider-config';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import { requireDesktopAccount } from '@/lib/auth/desktop-account';
import { getChatGPTPlanService } from '@/lib/chatgpt-plan/service';
import { ChatGPTPlanError } from '@/lib/chatgpt-plan/types';
import { createProviderToolStream, type AnthropicUsageTotals } from './provider-stream';
import { createGoogleToolResponseStream } from './google-native-tools';
import { streamOpenRouterFallback } from './operator-fallback';
import { toolsForOpenAI } from '@/lib/llm/tools';
import { isOpenRouterEnabled } from '@/lib/providers/openrouter-connection';
import { applyNativeApiEffort, nativeApiEffortError } from './effort-contract';

const UPSTREAM_TIMEOUT_MS = 30_000;
const TOKENS_PER_MILLION = 1_000_000;
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

function jsonError(message: string, status: number, code?: string) {
  return new Response(
    JSON.stringify({ error: message, ...(code ? { code } : {}) }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

// ── o8 Operator abuse limiter ────────────────────────────────────────────────
// The operator rail is unmetered for every plan (Q ruling 2026-07-12:
// "founders don't have any usage… but we should have rate limits for abuse").
// This is an anti-runaway guard for the single-operator desktop, not
// multi-tenant fairness: generous enough that no human conversation ever
// trips it, tight enough that a looping script can't torch the OpenRouter
// key's free-tier standing or the founder Gemini key. In-memory by design —
// a process restart resetting the window is fine for an abuse guard.
const OPERATOR_LIMIT_PER_MINUTE = 20;
const OPERATOR_LIMIT_PER_DAY = 500;
const operatorCallTimestamps: number[] = [];

function checkOperatorAbuseLimit(): Response | null {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60_000;
  while (operatorCallTimestamps.length > 0 && operatorCallTimestamps[0] < dayAgo) {
    operatorCallTimestamps.shift();
  }
  const minuteAgo = now - 60_000;
  const lastMinute = operatorCallTimestamps.filter((t) => t >= minuteAgo).length;
  if (lastMinute >= OPERATOR_LIMIT_PER_MINUTE) {
    return jsonError('o8 model rate limit: too many requests this minute. Wait a moment and try again.', 429);
  }
  if (operatorCallTimestamps.length >= OPERATOR_LIMIT_PER_DAY) {
    return jsonError('o8 model rate limit: daily request cap reached. Resets over the next 24 hours.', 429);
  }
  operatorCallTimestamps.push(now);
  return null;
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function asFiniteTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function computeUsageCost(
  provider: string,
  model: string,
  usage: AnthropicUsageTotals,
) {
  if (provider !== 'anthropic') {
    return computeCost(model, usage.inputTokens, usage.outputTokens);
  }

  const pricing = anthropicPricingForModel(model);
  if (!pricing) {
    return computeCost(model, usage.inputTokens, usage.outputTokens);
  }

  return (
    usage.inputTokens * pricing.input
    + usage.outputTokens * pricing.output
    + usage.cacheReadTokens * pricing.input * ANTHROPIC_CACHE_READ_MULTIPLIER
    + usage.cacheWriteTokens * pricing.input * ANTHROPIC_CACHE_WRITE_MULTIPLIER
  ) / TOKENS_PER_MILLION;
}

function parseRequestedThinkingEffort(value: unknown): ThinkingEffort | null {
  return isThinkingEffort(value) ? value : null;
}

function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.includes('claude-opus-4-8')
    || normalizedModel.includes('claude-opus-4-7')
    || normalizedModel.includes('claude-opus-4-6')
    || normalizedModel.includes('claude-sonnet-5')
    || normalizedModel.includes('claude-sonnet-4-6')
    || normalizedModel.includes('claude-mythos-preview');
}

/**
 * Map an explicit ThinkingEffort tier (low/medium/high/max/xhigh) to an Anthropic
 * `budget_tokens` value. `adaptive` returns null because the model self-regulates.
 */
function thinkingBudgetForEffort(effort: ThinkingEffort | null): number | null {
  switch (effort) {
    case 'low':
      return 4_000;
    case 'medium':
      return 10_000;
    case 'high':
      return 24_000;
    case 'max':
      return 48_000;
    case 'xhigh':
      return 60_000;
    case 'adaptive':
    default:
      return null;
  }
}

function applyAnthropicThinkingConfig(
  upstreamBody: Record<string, unknown>,
  model: string,
  requestedThinkingEffort: ThinkingEffort | null,
) {
  if (requestedThinkingEffort === 'adaptive') {
    delete upstreamBody.thinking;
    return;
  }
  if (requestedThinkingEffort !== null) {
    // Explicit effort tier — buildBody already wired the matching budget_tokens via
    // ProviderBuildOptions; nothing further to do here.
    return;
  }
  if (!supportsAnthropicAdaptiveThinking(model)) {
    return;
  }
  const maxTokens = typeof upstreamBody.max_tokens === 'number' && Number.isFinite(upstreamBody.max_tokens)
    ? upstreamBody.max_tokens
    : 0;
  upstreamBody.max_tokens = Math.max(maxTokens, 16_384);
  upstreamBody.thinking = {
    type: 'adaptive',
    display: 'summarized',
  };
}

function parseAnthropicStreamUsage(line: string) {
  if (!line.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(line.slice(6).trim()) as {
      usage?: Record<string, unknown>;
      message?: { usage?: Record<string, unknown> };
    };
    const usage = payload.message?.usage ?? payload.usage;
    if (!usage) return null;
    return {
      cacheReadTokens: asFiniteTokenCount(usage.cache_read_input_tokens),
      cacheWriteTokens: asFiniteTokenCount(usage.cache_creation_input_tokens),
    };
  } catch {
    return null;
  }
}

function withAnthropicPromptCaching(body: Record<string, unknown>, provider: string) {
  if (provider !== 'anthropic') {
    return body;
  }
  if (!resolvePromptCachingEnabledSync()) {
    return body;
  }

  const nextBody = { ...body };
  if (typeof nextBody.system === 'string' && nextBody.system.trim()) {
    nextBody.system = [{
      type: 'text',
      text: nextBody.system,
      cache_control: { type: 'ephemeral' as const },
    }];
  }
  return nextBody;
}

function mergeAnthropicStopState(
  current: AnthropicStopMetadata | null,
  next: AnthropicStopMetadata | null,
): AnthropicStopMetadata | null {
  if (!current) return next;
  if (!next) return current;

  return {
    stopReason: next.stopReason ?? current.stopReason,
    ...(next.stopSequence !== undefined
      ? { stopSequence: next.stopSequence }
      : current.stopSequence !== undefined
        ? { stopSequence: current.stopSequence }
        : {}),
  };
}

function buildUsageEvent(
  provider: string,
  model: string,
  usage: AnthropicUsageTotals,
  options?: {
    stopMetadata?: AnthropicStopMetadata | null;
    taskBudget?: ResolvedAnthropicTaskBudget | null;
  },
) {
  const event: Record<string, unknown> = {
    type: 'usage',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: provider === 'chatgpt' ? null : computeUsageCost(provider, model, usage),
    ...(provider === 'chatgpt' ? { route: 'chatgpt-plan', billing: 'subscription', allowanceUse: 'unknown', meter: 'provider-tokens' } : {}),
  };

  if (provider === 'anthropic') {
    event.cacheReadTokens = usage.cacheReadTokens;
    event.cacheWriteTokens = usage.cacheWriteTokens;
    event.usage = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
    };
    if (options?.stopMetadata?.stopReason) {
      event.stopReason = options.stopMetadata.stopReason;
    }
    if (options?.stopMetadata?.stopSequence !== undefined) {
      event.stopSequence = options.stopMetadata.stopSequence;
    }
    if (options?.taskBudget) {
      event.taskBudget = options.taskBudget.taskBudget;
      event.taskBudgetSource = options.taskBudget.source;
      if (options.taskBudget.phase) {
        event.taskPhase = options.taskBudget.phase;
      }
    }
  }

  return event;
}

export const POST = withOptionalAuth(async (request: NextRequest, auth: AuthContext | null) => {
  const body = await request.json().catch(() => null);
  if (!body?.model || !body?.provider || !Array.isArray(body?.messages)) {
    return jsonError('model, provider, and messages are required', 400);
  }

  const {
    model,
    provider,
    messages: rawMessages,
    disableTools,
    repoPath: rawRepoPath,
    approvalGrant: rawApprovalGrant,
    thinkingEffort: rawThinkingEffort,
  } = body as {
    model: string;
    provider: string;
    messages: Message[];
    disableTools?: boolean;
    repoPath?: string;
    approvalGrant?: string;
    thinkingEffort?: ThinkingEffort;
  };
  const requestedThinkingEffort = parseRequestedThinkingEffort(rawThinkingEffort);
  const planTextOnly = body.planTextOnly === true;
  if (body.planTextOnly !== undefined && (!planTextOnly || provider !== 'chatgpt' || disableTools !== true || rawApprovalGrant != null
    || typeof body.planAccountId !== 'string' || !Number.isSafeInteger(body.planGeneration) || typeof body.planDesktopEpoch !== 'string'
    || rawMessages.some((message) => !message || !['user', 'assistant'].includes(message.role)))) {
    return jsonError('Plan text chats require a bound ChatGPT connection, user/assistant text, and disabled tools.', 400);
  }

  if (!isSupportedProvider(provider)) {
    return jsonError(`Unsupported provider: ${provider}`, 400);
  }
  const effortError = nativeApiEffortError(provider, model, rawThinkingEffort);
  if (effortError) return jsonError('The requested effort has no supported mapping for this provider and model. Omit effort or choose a supported combination.', 400, effortError);

  let planOwner: string | null = null;
  let planSelection: { accountId: string; generation: number; desktopEpoch: string } | undefined;
  if (provider === 'chatgpt') {
    try {
      if (typeof model !== 'string' || rawMessages.some((message) => !message || typeof message.content !== 'string' || !['user', 'assistant', 'system', 'developer'].includes(message.role))) throw new ChatGPTPlanError('invalid_request', 'ChatGPT plan requests require text messages and an available model.', 400);
      planOwner = await requireDesktopAccount(request);
      planSelection = await getChatGPTPlanService().selection(planOwner);
      if (body.planAccountId !== undefined && body.planAccountId !== planSelection.accountId) throw new ChatGPTPlanError('plan_selection_changed', 'Choose the original ChatGPT account before resuming this approval.', 409);
      if (body.planGeneration !== undefined && body.planGeneration !== planSelection.generation) throw new ChatGPTPlanError('plan_selection_changed', 'The connection changed. Start a new turn.', 409);
      if (body.planDesktopEpoch !== undefined && body.planDesktopEpoch !== planSelection.desktopEpoch) throw new ChatGPTPlanError('o8_session_changed', 'The desktop session changed. Start a new turn.', 409);
    } catch (error) { return jsonError(error instanceof Error ? error.message : 'Sign in to o8.', error instanceof ChatGPTPlanError ? error.status : 403, error instanceof ChatGPTPlanError ? error.code : undefined); }
  }

  const anthropicTaskBudgetResult = provider === 'anthropic'
    ? resolveAnthropicTaskBudget(body as Record<string, unknown>)
    : { value: null as ResolvedAnthropicTaskBudget | null };
  if (anthropicTaskBudgetResult.error) {
    return jsonError(anthropicTaskBudgetResult.error, 400);
  }
  const anthropicTaskBudget = anthropicTaskBudgetResult.value;

  const approvalGrant = typeof rawApprovalGrant === 'string' ? rawApprovalGrant : null;
  const tabId = request.headers.get('x-tab-id')?.trim() || '';
  const bodyRepoPath = typeof rawRepoPath === 'string' ? rawRepoPath.trim() : '';
  if (rawRepoPath != null && typeof rawRepoPath !== 'string') {
    return jsonError('repoPath must be a string', 400);
  }
  const headerRepoPath = request.headers.get(LLM_REPO_PATH_HEADER)?.trim() || '';
  const requestedRepoPath = bodyRepoPath || headerRepoPath;
  if (planTextOnly && requestedRepoPath) return jsonError('Plan text chats do not accept repository context.', 400);
  let effectiveRepoRoot = process.cwd();
  // Whether effectiveRepoRoot is a REAL registered repo vs the process.cwd()
  // fallback. Tool writes must never target cwd (the app's own dir) — gate on
  // this before attaching any file tools (2026-07-14 adversarial review).
  let repoResolved = false;
  if (requestedRepoPath) {
    const resolvedRepo = await resolveRepoPathFromRegistry(requestedRepoPath);
    if (!resolvedRepo.ok) {
      return jsonError(resolvedRepo.message, resolvedRepo.status);
    }
    effectiveRepoRoot = resolvedRepo.repoRoot;
    repoResolved = true;
  }
  const nonSystemMessages = rawMessages.filter((message) => message.role !== 'system');
  const priorSystemMessages = rawMessages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean);
  const assistantMessageCount = nonSystemMessages.filter((message) => message.role === 'assistant').length;
  const userMessageCount = nonSystemMessages.filter((message) => message.role === 'user').length;
  const isFreshChatTurn = assistantMessageCount === 0 && userMessageCount <= 1;

  let systemPrompt = planTextOnly
    ? 'You are ChatGPT in o8. Answer using only the conversation supplied by the user. This is a text-only chat without tools or workspace context.'
    : buildSystemPrompt(getWorkspaceContext(effectiveRepoRoot));

  const lastUserMsg = [...nonSystemMessages].reverse().find((message) => message.role === 'user');

  if (isFreshChatTurn && !planTextOnly) {
    try {
      const ftux = await getPersonalizedChatFtuxPayload({
        userName: auth?.user.name,
        scopedRepoRoot: effectiveRepoRoot,
      });
      if (ftux.systemContext.trim()) {
        systemPrompt += `\n\n${ftux.systemContext}`;
      }
    } catch (error) {
      console.warn('[llm-proxy] Failed to load fresh-chat FTUX context:', error);
    }
  }

  if (priorSystemMessages.length > 0) {
    systemPrompt += `\n\n${priorSystemMessages.join('\n\n')}`;
  }

  const messages: Message[] = [{ role: 'system', content: systemPrompt }, ...nonSystemMessages];

  // The paid-plan budget gate is skipped while "View as Free" (#1517) is active,
  // so the effective-free experience isn't metered against a paid budget. The
  // getEntitlementSync().plan read applies the view-as min-clamp; the auth.user
  // short-circuit keeps it off the hot path for genuine free users.
  if (provider !== 'chatgpt' && auth?.user && auth.user.plan !== 'free' && getEntitlementSync().plan !== 'free') {
    const spent = getCurrentPeriodCost(auth.user.id);
    const budget = auth.user.tokenBudgetUsd;
    if (budget != null && spent >= budget) {
      return jsonError('Monthly token budget exceeded. Upgrade your plan or add a BYOK key.', 402);
    }
  }

  // o8 Operator — the branded zero-setup model, plan-gated (Q ruling
  // 2026-07-12): with a local Gemini key, founders/paid auto-ride Gemini Flash
  // ("High"); otherwise every plan rides the OpenAI-compatible chain: the managed
  // text model, then the $0 model, so o8 ALWAYS has a model. The tier
  // arrives as thinkingEffort but is SERVER-ENFORCED: a free client asking for
  // high still gets the free chain (fail-closed). Founders draw no metered
  // usage; the abuse limiter below guards the rail against runaway loops.
  // Text only (#3408): the composer's o8 choice runs on the built-in Pi agent,
  // and this rail is its fallback where Pi cannot start. It never attaches tools.
  if (provider === 'operator') {
    const abuseError = checkOperatorAbuseLimit();
    if (abuseError) return abuseError;

    const geminiKey = resolveProviderKey('GEMINI_API_KEY');
    const openRouterKey = isOpenRouterEnabled() ? resolveProviderKey('OPENROUTER_API_KEY') ?? null : null;
    // Resolve the same OpenAI-compatible route the Brain uses: managed proxy,
    // local runtime, or an encrypted stored BYOK key. Credentials stay inside
    // the resolver-provided headers, so this route never needs to unwrap them.
    const inferenceRoute = await resolveOpenRouterRoute({ provisionInstallAllowance: true }).catch(() => null);
    const operatorEndpoint = inferenceRoute ? { url: inferenceRoute.url, headers: inferenceRoute.headers } : null;
    const localOperatorModel = inferenceRoute?.via === 'local' ? inferenceRoute.model?.trim() || null : null;
    const paidPlan = getEntitlementSync().plan !== 'free';
    // Absent tier = auto: founders default High (Gemini), free defaults Low.
    const wantsLow = requestedThinkingEffort === 'low';
    let geminiQuotaExhausted = false;

    if (paidPlan && !wantsLow && geminiKey) {
      // Primary then rollback, BOTH through Gemini (Q ruling 2026-07-13):
      // the primary is a preview id Google can re-point or retire, so any
      // failure on it — not just quota — gets one retry on the proven
      // rollback model before the free chain is even considered.
      let lastGeminiResponse: Response | null = null;
      for (const geminiModel of [OPERATOR_GEMINI_MODEL, OPERATOR_GEMINI_ROLLBACK_MODEL]) {
        const geminiResponse = await createGoogleToolResponseStream({
          apiKey: geminiKey,
          auth,
          disableTools: true,
          lastUserContent: lastUserMsg?.content,
          messages,
          model: geminiModel,
          scopedRepoRoot: null,
          tabId,
        });
        if (geminiResponse.ok) return geminiResponse;
        lastGeminiResponse = geminiResponse;
      }
      const status = lastGeminiResponse?.status ?? 503;
      if (status !== 429 && status !== 503 && status !== 402) {
        return lastGeminiResponse ?? jsonError('o8 Operator unavailable.', 503);
      }
      // Quota/exhaustion on the whole Gemini rail — drop into the free chain.
      geminiQuotaExhausted = true;
    }

    // OpenAI-compatible chain — the resolved endpoint wins over the legacy env
    // fallback. Local runtimes receive their configured model exactly once;
    // OpenRouter and the managed proxy retain the two-model fallback chain.
    if (operatorEndpoint || openRouterKey) {
      let lastFailure: Response | null = null;
      const operatorModels = localOperatorModel ? [localOperatorModel] : OPERATOR_OPENROUTER_MODELS;
      for (const freeModel of operatorModels) {
        const response = await streamOpenRouterFallback({
          apiKey: openRouterKey ?? '',
          endpoint: operatorEndpoint,
          messages,
          model: freeModel,
          auth,
          // Degradation banner only for a founder whose Gemini quota died —
          // the free plan rides this chain by design, no banner.
          notice: geminiQuotaExhausted
            ? {
              originalModel: OPERATOR_GEMINI_MODEL,
              originalModelLabel: 'Gemini 3 Flash',
              reason: 'Gemini quota exhausted — using the free chain',
            }
            : null,
        });
        if (response.ok) return response;
        lastFailure = response;
      }
      if (!geminiKey) {
        return lastFailure ?? jsonError('The o8 model is temporarily unavailable — every free model failed to respond. Try again in a moment.', 503);
      }
    }

    // Last resort so o8 always answers when any key exists — a free install
    // with only a Google key beats a dead composer. Rides the ROLLBACK model
    // (stable id, proven record) so this path never depends on a preview id.
    if (geminiKey) {
      return createGoogleToolResponseStream({
        apiKey: geminiKey,
        auth,
        disableTools: true,
        lastUserContent: lastUserMsg?.content,
        messages,
        model: OPERATOR_GEMINI_ROLLBACK_MODEL,
        scopedRepoRoot: null,
        tabId,
      });
    }

    // No managed proxy (not signed in as a founder) and no local key. The o8
    // model needs an inference source — never leak env-var names to the user
    // (report BCJBBJ showed a raw "set OPENROUTER_API_KEY…" dev string).
    return jsonError(
      'The free o8 model needs a connection: sign in with your Pro · Lifetime account to use o8-managed inference, or add your own model key in Settings → Keys.',
      503,
    );
  }

  const apiKey = provider === 'chatgpt' ? null : resolveApiKey(provider);
  if (!apiKey && provider !== 'chatgpt') {
    const envKey = provider === 'google' ? 'GOOGLE_AI_API_KEY' : PROVIDERS[provider].envKey;
    return jsonError(`No API key configured for ${provider}. Set ${envKey} in your environment.`, 400);
  }

  if (provider === 'google') {
    return createGoogleToolResponseStream({
      apiKey: apiKey!,
      auth,
      disableTools,
      lastUserContent: lastUserMsg?.content,
      messages,
      model,
      scopedRepoRoot: effectiveRepoRoot,
      tabId,
    });
  }

  const config = PROVIDERS[provider];
  const headers = provider === 'chatgpt' ? {} : config.buildHeaders(apiKey!);
  const cacheBreakpointEnabled = provider === 'anthropic' ? resolvePromptCachingEnabledSync() : false;
  const explicitThinkingBudget = provider === 'anthropic'
    ? thinkingBudgetForEffort(requestedThinkingEffort)
    : null;
  const buildUpstreamBody = (requestMessages: Message[]) => {
    const upstreamBody = withAnthropicPromptCaching(
      config.buildBody(model, requestMessages, {
        cacheBreakpoint: cacheBreakpointEnabled,
        thinkingBudgetTokens: explicitThinkingBudget ?? undefined,
      }) as Record<string, unknown>,
      provider,
    );
    if (provider === 'anthropic') {
      applyAnthropicThinkingConfig(upstreamBody, model, requestedThinkingEffort);
    }
    applyNativeApiEffort(upstreamBody, provider, requestedThinkingEffort);
    if (provider === 'anthropic' && anthropicTaskBudget) {
      upstreamBody.task_budget = anthropicTaskBudget.taskBudget;
      console.info(
        `[llm-proxy] Anthropic task_budget=${anthropicTaskBudget.taskBudget}`
        + `${anthropicTaskBudget.phase ? ` phase=${anthropicTaskBudget.phase}` : ''}`
        + ` source=${anthropicTaskBudget.source}`,
      );
    }
    if (disableTools || (provider === 'chatgpt' && !repoResolved)) {
      delete upstreamBody.tools;
    }
    return upstreamBody;
  };
  const requestUpstream = async (requestMessages: Message[]) => {
    if (provider === 'chatgpt') {
      const owner = await requireDesktopAccount(request);
      if (owner !== planOwner) throw new ChatGPTPlanError('account_mismatch', 'The o8 account changed during this request.', 403);
      return getChatGPTPlanService().infer(owner, model, buildUpstreamBody(requestMessages), request.signal, planSelection);
    }
    return fetchWithTimeout(config.url, headers, JSON.stringify(buildUpstreamBody(requestMessages)));
  };

  let upstream: globalThis.Response;
  try {
    upstream = await requestUpstream(messages);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Proxy request failed', error instanceof ChatGPTPlanError ? error.status : 502, error instanceof ChatGPTPlanError ? error.code : undefined);
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => 'Unknown error');
    return jsonError(`${provider} API error (${upstream.status}): ${errText.slice(0, 500)}`, upstream.status);
  }

  return createProviderToolStream({ provider, model, config, auth, upstream, messages, rawMessages, effectiveRepoRoot, tabId, approvalGrant, anthropicTaskBudget,
    fetchUpstream: (requestMessages) => requestUpstream(requestMessages),
    buildUsageEvent, parseAnthropicStreamUsage, mergeAnthropicStopState, signal: request.signal, planOwner, planSelection,
    ...(provider === 'chatgpt' ? { allowedTools: disableTools || !repoResolved ? [] : toolsForOpenAI().map((tool) => tool.function.name) } : {}),
    ...(planOwner && planSelection ? { toolAdmission: async <T>(action: () => Promise<T>) => {
      const owner = await requireDesktopAccount(request);
      if (owner !== planOwner) throw new ChatGPTPlanError('account_mismatch', 'The o8 account changed.', 403);
      return getChatGPTPlanService().toolAdmission(owner, planSelection!, action);
    } } : {}),
  });
});
