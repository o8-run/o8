import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { persistCanonicalChatHistoryRecord, withCanonicalChatHistoryLock } from '@/lib/llm/chat-history-store';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { logUsage } from '@/lib/db/usage';
import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';

/**
 * Chats receive a short title after the first exchange, refreshed once as the
 * thread develops. Background inference uses the configured free-model chain
 * when enabled. A pure-code fallback remains available. Provider usage is
 * recorded when reported; a free model name does not prove account billing.
 * Operator renames are sacred: `titleSource: 'operator'` is never overwritten.
 *
 * File fields written alongside `title`:
 *   titleSource        'code' | 'llm' | 'operator'
 *   autoTitledAtCount  message count when the auto title was last generated
 */

// Same free chain the o8-operator rail rides (provider-config.ts). Re-declared
// here so this fs-level module doesn't import from the app router tree.
const FREE_TITLE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
];

const TITLE_TIMEOUT_MS = 8000;
/** First auto-title once the thread has a real exchange. */
const MIN_MESSAGES = 2;
/** One refresh pass once the thread has developed past this. */
const REFRESH_AT = 8;
/** A stored title longer than this with no titleSource is a legacy raw-crop
 *  first message — eligible for an upgrade. */
const LEGACY_RAW_TITLE_LENGTH = 64;

const inFlight = new Set<string>();

interface ThreadMessage { role?: unknown; content?: unknown }

function messageText(message: ThreadMessage): string {
  return typeof message.content === 'string' ? message.content : '';
}

/** Pure-code fallback: first sentence-ish of the first user message, cleaned
 *  of markdown noise, capped at a word boundary. */
export function compactTitleFromMessage(text: string): string | null {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const sentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  const base = sentence.length >= 12 ? sentence : cleaned;
  if (base.length <= 48) return base.replace(/[.!?,;:]+$/, '');
  const cropped = base.slice(0, 48);
  const lastSpace = cropped.lastIndexOf(' ');
  return (lastSpace > 24 ? cropped.slice(0, lastSpace) : cropped).replace(/[.!?,;:]+$/, '');
}

interface AutoTitleDecision {
  run: boolean;
  reason?: 'first' | 'refresh' | 'legacy-upgrade';
}

const PLACEHOLDER_TITLES = new Set(['new conversation', 'untitled conversation']);

/** Pure decision logic — exported for the real-path test. */
export function decideAutoTitle(record: {
  title?: unknown;
  titleSource?: unknown;
  autoTitledAtCount?: unknown;
  messageCount: number;
}): AutoTitleDecision {
  if (record.titleSource === 'operator') return { run: false };
  if (record.messageCount < MIN_MESSAGES) return { run: false };
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const titledAt = typeof record.autoTitledAtCount === 'number' ? record.autoTitledAtCount : 0;
  const isAuto = record.titleSource === 'code' || record.titleSource === 'llm';

  // Clients create threads as "New conversation" before anything is said
  // (o8 next, mobile); that placeholder is no title.
  if (!title || (!record.titleSource && PLACEHOLDER_TITLES.has(title.toLowerCase()))) {
    return { run: true, reason: 'first' };
  }
  // Legacy raw-crop first-message titles (pre-titler threads) upgrade once.
  if (!record.titleSource && title.length > LEGACY_RAW_TITLE_LENGTH) {
    return { run: true, reason: 'legacy-upgrade' };
  }
  // One refresh pass as the thread develops past the auto title's vintage.
  if (isAuto && record.messageCount >= REFRESH_AT && titledAt < REFRESH_AT) {
    return { run: true, reason: 'refresh' };
  }
  return { run: false };
}

interface TitleProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

function measured(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function recordTitleAttempt(input: {
  tabId: string;
  runId: string;
  model: string;
  attempt: number;
  outcome: 'success' | 'http-error' | 'invalid-response' | 'transport-error';
  usage?: TitleProviderUsage;
}): void {
  const usage = input.usage;
  const inputAvailable = measured(usage?.prompt_tokens);
  const outputAvailable = measured(usage?.completion_tokens);
  const costAvailable = measured(usage?.cost);
  try {
    logUsage({
      userId: null,
      provider: 'openrouter',
      model: input.model,
      inputTokens: inputAvailable ? usage?.prompt_tokens ?? 0 : 0,
      outputTokens: outputAvailable ? usage?.completion_tokens ?? 0 : 0,
      costUsd: costAvailable ? usage?.cost ?? 0 : 0,
      sessionKey: `chat-title:${input.tabId}`,
      runId: input.runId,
      agentName: 'chat-auto-title',
      role: 'other',
      requestType: 'completion',
      attempt: input.attempt,
      metadata: {
        trigger: 'chat-history-save',
        outcome: input.outcome,
        inputTokenUsage: inputAvailable ? 'provider-reported' : 'unavailable',
        outputTokenUsage: outputAvailable ? 'provider-reported' : 'unavailable',
        costUsage: costAvailable ? 'provider-reported' : 'unavailable',
        reportedInputTokens: inputAvailable ? usage?.prompt_tokens : null,
        reportedOutputTokens: outputAvailable ? usage?.completion_tokens : null,
        reportedCostUsd: costAvailable ? usage?.cost : null,
      },
    });
  } catch (error) {
    console.warn('[thread-auto-title] usage receipt failed:', error instanceof Error ? error.message : error);
  }
}

async function llmTitle(firstUser: string, lastAssistant: string, tabId: string): Promise<string | null> {
  // Free title models only; the resolver honours a disabled OpenRouter connection (#3583).
  const apiKey = (await resolveOpenRouterKey())?.trim();
  if (!apiKey) return null;
  const runId = randomUUID();
  const prompt = [
    'Name this coding-assistant chat thread.',
    'Reply with ONLY the title: 3 to 6 words, plain text, no quotes, no trailing punctuation.',
    'Capture the actual task or topic, not pleasantries.',
    '',
    `First message: ${firstUser.slice(0, 500)}`,
    lastAssistant ? `Latest reply excerpt: ${lastAssistant.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');

  for (const [index, model] of FREE_TITLE_MODELS.entries()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    let outcome: 'success' | 'http-error' | 'invalid-response' | 'transport-error' = 'transport-error';
    let usage: TitleProviderUsage | undefined;
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 24,
          temperature: 0.2,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        outcome = 'http-error';
        continue;
      }
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: TitleProviderUsage };
      usage = payload.usage;
      const raw = payload.choices?.[0]?.message?.content?.trim() ?? '';
      // Strip wrapping quotes + reasoning-model preamble leakage; keep one line.
      const line = raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
      const cleaned = line.replace(/^["'`]+|["'`.]+$/g, '').trim();
      if (cleaned && cleaned.length >= 3 && cleaned.length <= 72) {
        outcome = 'success';
        return cleaned;
      }
      outcome = 'invalid-response';
    } catch {
      // timeout / network — try the next free model
    } finally {
      clearTimeout(timer);
      recordTitleAttempt({ tabId, runId, model, attempt: index + 1, outcome, usage });
    }
  }
  return null;
}

/**
 * Fire-and-forget: reads the thread file, decides, generates, writes back.
 * Re-reads before write so a concurrent operator rename always wins.
 */
export function maybeQueueThreadAutoTitle(filePath: string): void {
  if (inFlight.has(filePath)) return;
  inFlight.add(filePath);
  void (async () => {
    try {
      if (!existsSync(filePath)) return;
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      const messages = Array.isArray(data.messages) ? data.messages as ThreadMessage[] : [];
      const decision = decideAutoTitle({
        title: data.title,
        titleSource: data.titleSource,
        autoTitledAtCount: data.autoTitledAtCount,
        messageCount: messages.length,
      });
      if (!decision.run) return;

      const firstUser = messageText(messages.find((m) => m.role === 'user') ?? {});
      if (!firstUser.trim()) return;
      const lastAssistant = messageText([...messages].reverse().find((m) => m.role === 'assistant') ?? {});

      const tabId = filePath.split('/').pop()?.replace(/\.json$/, '');
      if (!tabId) return;
      const inferenceEnabled = getOperatorDefaultsSync().values.autoTitleInferenceEnabled;
      const generated = inferenceEnabled ? await llmTitle(firstUser, lastAssistant, tabId) : null;
      const fallback = compactTitleFromMessage(firstUser);
      const nextTitle = generated ?? fallback;
      if (!nextTitle) return;
      // An LLM miss must not clobber an existing title with a same-quality
      // code crop — only fill code titles into blank/legacy slots once.
      if (!generated && decision.reason === 'refresh') return;

      // The server's turn writer and the Next routes save this file from
      // separate processes; re-read and write under the shared file lock.
      const titled = withCanonicalChatHistoryLock(tabId, () => {
        const fresh = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
        if (fresh.titleSource === 'operator') return false;
        fresh.title = nextTitle;
        fresh.titleSource = generated ? 'llm' : 'code';
        fresh.autoTitledAtCount = messages.length;
        persistCanonicalChatHistoryRecord(
          tabId,
          fresh as { messages: unknown[]; [key: string]: unknown },
        );
        return true;
      });
      if (!titled) return;
      console.log(`[thread-auto-title] ${decision.reason}: "${nextTitle}" (${generated ? 'llm' : 'code'})`);
    } catch {
      // best-effort — never break the persist path
    } finally {
      inFlight.delete(filePath);
    }
  })();
}
