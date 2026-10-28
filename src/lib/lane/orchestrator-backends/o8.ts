/**
 * o8 orchestrator backend: the composer's "o8" choice (#3408).
 *
 * o8 runs on its built-in agent, the bundled Pi orchestrator (`pi.ts`), on the
 * managed model: persistent sessions, the o8 command set, and governed file and
 * command tools. Repo writes and commands keep per-call inbox approval (Pi's
 * default approval, never lane rules), and a plan-mode turn is read-only.
 *
 * Where the built-in agent cannot start (Windows, or Node older than 22.19) the
 * turn falls back to a text-only reply from the same managed route through
 * `/api/v2/proxy/llm`, and the reply first says why. That fallback has no tools.
 * It holds no server session: a "session" there is a deterministic
 * per-repo+thread name used to route WS broadcasts, and prior turns are rebuilt
 * from the persisted thread transcript on every send.
 *
 * The fallback fetch targets the ws-server → Next origin (`buildNextUrl`,
 * honoring NEXT_ORIGIN for the dev-bridge) and carries the ws-token bearer so
 * the gate authorizes by token — the loopback heuristic alone intermittently 401'd.
 */

import { unmappedEffortError } from './unmapped-effort';
import { resolveBackendTurnModel } from '@/lib/orchestrator/turn-model-selection';
import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import { readFile } from 'node:fs/promises';
import { readOrchestratorThreadMessages, safeOrchestratorHistoryPath } from '@/lib/mobile/orchestrator-thread-history';
import { requirePiNode, requirePiPlatform } from '@/lib/pi/sdk/platform';
import { buildNextUrl } from '@/lib/ws-server/next-fetch';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { piBackend } from './pi';
import type {
  OrchestratorBackend,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

/**
 * Conversational framing sent as the system message (the proxy folds any
 * `role: 'system'` message into its system context). Tier-specific per the
 * prompt lab A/B (2026-07-12, scratchpad prompt-lab/): the recursive
 * two-angle pass fixed the free model's hallucination trap outright (3.5 →
 * 8.7) at zero latency cost, but the skills-fused principles layer only
 * helps the STRONGER founders model — on the small model it nudged answers
 * back toward overclaiming, and on Gemini the recursive pass alone caused
 * confident fabricated NEGATIVES until the principles layer grounded it.
 * So: Low (free rail) = base + recursive; High (founders rail) = base +
 * recursive + principles. Don't merge them.
 */
const O8_PROMPT_BASE = [
  'Answer concisely and helpfully.',
  'o8\'s built-in agent cannot run on this machine, so you are text only: you cannot dispatch',
  'agents, run tools or o8 commands, edit files, or drive the repo. If the operator asks for real',
  'repo work, say plainly that this reply is text only and that they can switch the composer',
  'to Claude or Codex to dispatch actual agents. Never claim you dispatched or ran anything.',
].join(' ');

const O8_PROMPT_RECURSIVE = [
  'Before answering anything non-trivial, make two silent passes from two different angles:',
  'first as a builder (what is the direct answer / solution?), then as a skeptic (what did',
  'the first pass miss, assume, or get wrong? what would break it?). Reconcile the two',
  'passes into one answer. For any question about o8 itself, do a final accuracy pass:',
  'every feature you name must come from the concepts you were given — if it isn\'t there,',
  'say you\'re not certain instead of inventing it. Keep all of this reasoning silent;',
  'deliver only the reconciled answer, concise and confident.',
].join(' ');

const O8_PROMPT_PRINCIPLES = [
  'Working principles: Lead with the answer — the first sentence should resolve the',
  'question, detail after. Simplicity first — recommend the minimum change that solves the',
  'problem, never speculative flexibility. Be surgical — when suggesting changes, touch',
  'only what the request requires. Verify the real path — a suggestion isn\'t done until',
  'you\'ve explained how the user confirms it actually worked. Say plainly what you don\'t',
  'know or can\'t do; never fake certainty or invent capabilities.',
].join(' ');

// Grounding block — the recursive accuracy pass needs real concepts to check
// feature claims against, or it has nothing to be honest WITH.
const O8_CONCEPTS = [
  'o8 concepts: the operator dispatches MISSIONS which become PACKETS (units of agent',
  'work) running in isolated git worktrees called LANES; every diff is REVIEWED by the',
  'operator before APPROVE-AND-MERGE lands it on main. The composer\'s model picker',
  'chooses which AI drives the orchestrator.',
].join(' ');

// Tuned-v2 slot (model shootout rounds 2–2b, scripts/eval-o8-model.mjs +
// scratchpad/o8-model-eval.md): grounding + tool discipline + answer style.
// Measured on the High envelope only — markdown restraint alone lifted domain
// answers from 0-5/6 to 5-6/6 across every model tested, and the current
// founders model (gemini-2.5-flash) went 1.56 → 2.00 with this appended. The
// tool sections are written conditionally ("if attached") so they are inert on
// today's tools-free rail and ready for a tool-capable surface. High tier only:
// the prompt-lab A/B showed extra instruction layers push the small free model
// back toward overclaiming.
const O8_PROMPT_TUNED_SLOT = `Stay in the o8 role. Never describe yourself as a generic AI assistant or claim capabilities the current surface does not provide.

Grounding:
1. Claim only what the conversation, supplied o8 context, or tool results support. Never fill gaps with plausible-sounding repo details.
2. The shipping chat rail has no tools. If no tool schemas are attached, stay conversational and direct the operator to Claude or Codex for repo actions.
3. An attached tool schema switches that request into tool-capable mode. Honor direct instructions to use a matching attached tool; do not mention the conversational-only boundary in that mode. Only the named tools exist, and their presence is not permission to invent any other action.
4. If ask_brain is attached, consult it before repo-specific or o8-behavior claims. Skip it for small talk, general programming knowledge, and facts already established in the supplied context. If evidence is unavailable, say "I'm not sure" and name what would verify it.
5. When ask_brain is attached for a repo-specific question, the first response must be that tool call. Never answer such a question from general memory instead.

Tool discipline:
1. Answer directly when the request is small talk, general knowledge, or fully answered by supplied context.
2. Call an attached tool when fresh repo evidence is required or the user explicitly asks for an action that tool supports. If a tool is required, emit the call immediately without narrating it first.
3. Follow the requested tool sequence. Match schemas exactly: correct types and nesting, no invented fields, and no stringified numbers. If every schema-required field is supplied, call the tool; do not ask for fields the schema does not define.
4. After a tool result, use it. Do not repeat the same lookup or ignore returned evidence.
5. Never imply a tool ran when it did not, and never claim an action succeeded without a confirming result.

Answer style:
- Default to plain prose in 2-5 sentences and at most about 120 words unless the operator asks for depth.
- Do not use markdown headings, tables, or decorative formatting unless asked. Use bullets only when a real list materially improves clarity.
- Lead with the answer, omit throat-clearing, and do not restate the request.
- A strict requested output format overrides every style preference. Return only that format, with no preface or afterword.`;

/**
 * Rail tier for a text-only fallback turn: Low on every plan. High runs only
 * with a member's own key (#2864), so the composer stopped offering it (#2999)
 * and this turn requests Low explicitly rather than letting the proxy infer
 * High from a paid plan (#3660).
 */
const O8_FALLBACK_TIER = 'low';

// Brand identity guard (#1575, live-hit 2026-07-17): a founder asked the free
// model who it was — first answer stayed "the o8 model", the summary two
// paragraphs later leaked "(Claude)". The identity line alone doesn't stop the
// leak; the anonymity has to be explicit.
const O8_IDENTITY_GUARD =
  'You are "the o8 model" for the entire conversation, including summaries and asides — never name, hint at, or compare against the underlying model or provider that powers you.';

export function o8SystemPrompt(tier: 'low' | 'high'): string {
  const identity = 'You are o8 — the model inside the o8 control plane, answering in text only.';
  const parts = tier === 'high'
    ? [identity, O8_IDENTITY_GUARD, O8_PROMPT_BASE, O8_PROMPT_RECURSIVE, O8_PROMPT_PRINCIPLES]
    : [identity, O8_IDENTITY_GUARD, O8_PROMPT_BASE, O8_PROMPT_RECURSIVE];
  const envelope = `${parts.join(' ')}\n\n${O8_CONCEPTS}`;
  return tier === 'high' ? `${envelope}\n\n${O8_PROMPT_TUNED_SLOT}` : envelope;
}

type ProxyMessage = { role: 'system' | 'user' | 'assistant'; content: string };

// Inactivity ceiling for the proxy turn. This backend is a raw fetch — there is
// no child process whose exit can terminalize a dead turn, so a proxy that
// accepts the request and then hangs (or never returns headers) used to wedge
// the turn FOREVER: no error, no done, a busy latch that survived the night
// (2026-07-15 incident — a 6-hour "Working" timer). Five minutes of zero bytes
// still terminalizes a dead stream.
const O8_TURN_INACTIVITY_TIMEOUT_MS = 300_000;

/** Deterministic-name registry so `peekSession` mirrors an ensured session. */
const ensured = new Set<string>();

function o8SessionName(repoPath: string, threadId?: string | null): string {
  return sessionNameForRepo('o8-free-orchestrator', repoPath, threadId);
}

/** Why o8's built-in agent cannot start on this machine, or null when it can. */
export function o8BuiltInAgentBlocker(): string | null {
  try {
    requirePiPlatform();
  } catch {
    return 'o8\'s built-in agent runs on macOS and Linux, and Windows support is not available yet';
  }
  try {
    requirePiNode();
  } catch {
    return 'o8\'s built-in agent needs Node 22.19 or newer';
  }
  return null;
}

/** The receipt names the o8 model the turn was sent with, the same id ws-server persists for the turn. */
function o8ReceiptModel(options: OrchestratorTurnOptions): string {
  return resolveBackendTurnModel('o8', options.model)!;
}

async function sendTextOnlyTurn(
  sessionName: string,
  blocker: string,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: OrchestratorTurnOptions,
): Promise<void> {
  const done = () => onEvent({ type: 'done', sessionId: sessionName, cost: 0 });

  // ws-server appends the user message to the thread transcript BEFORE calling
  // the backend, so the reconstructed history's last entry IS this turn. Use it
  // as-is; fall back to the raw message param only for non-thread-backed turns
  // (empty history) — never both, so the current turn is never doubled.
  const prior = readOrchestratorThreadMessages(options.threadId);
  const history: ProxyMessage[] =
    prior.length > 0 && prior[prior.length - 1].role === 'user'
      ? prior
      : [...prior, { role: 'user', content: message }];
  const tier = O8_FALLBACK_TIER;
  onEvent({ type: 'turn_receipt', leadModel: o8ReceiptModel(options), effort: 'adaptive', effortSource: 'runtime-default', serviceTier: tier });
  // Say why before anything streams, so a text-only answer is never mistaken for the agent.
  onEvent({ type: 'text', text: `${blocker}, so this reply is text only, without o8 commands, file edits or tools.\n\n` });
  const messages: ProxyMessage[] = [{ role: 'system', content: o8SystemPrompt(tier) }, ...history];

  // Inactivity watchdog: every await below (the fetch AND each stream read) is
  // otherwise unbounded. The watchdog aborts the request after
  // O8_TURN_INACTIVITY_TIMEOUT_MS of silence; any received byte re-arms it. A
  // user abort forwards through the same controller but stays distinguishable
  // via options.signal so it keeps its silent-stop semantics.
  const controller = new AbortController();
  let watchdogFired = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const armWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      controller.abort();
    }, O8_TURN_INACTIVITY_TIMEOUT_MS);
  };
  const disarmWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  };
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const watchdogError = () => {
    onEvent({
      type: 'error',
      error: `The o8 model went silent for ${Math.round(O8_TURN_INACTIVITY_TIMEOUT_MS / 60_000)} minutes — the turn was stopped so the chat doesn't hang. Re-send to retry.`,
    });
  };

  let response: Response;
  armWatchdog();
  try {
    response = await fetch(buildNextUrl('/api/v2/proxy/llm'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Belt-and-suspenders auth (the ws-server → Next pattern, see
        // lib/ws-server/next-fetch.ts). This backend runs in the ws-server and
        // called the GATED proxy over loopback with NO bearer, relying purely on
        // the middleware's loopback-socket heuristic — which intermittently
        // failed, returning the gate's own `{error:'Unauthorized'}` and killing
        // every free turn ("o8 model unavailable: Unauthorized", root of
        // the 6-hour-timer + Q's 2026-07-15 screenshot). The ws-token authorizes
        // via the token path regardless of loopback detection.
        Authorization: `Bearer ${getOrCreateWsToken()}`,
      },
      body: JSON.stringify({
        model: 'o8-operator',
        provider: 'operator',
        messages,
        // Text only. The proxy never attaches tools to the operator rail either.
        disableTools: true,
        // Always explicit: an absent effort lets the proxy pick High for a paid plan.
        thinkingEffort: tier,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Reaching the proxy failed (or a user abort landed before the response). A
    // clean stop is not an error line; a watchdog abort and anything else
    // surface as one so the turn always terminalizes visibly.
    disarmWatchdog();
    if (watchdogFired) {
      watchdogError();
    } else if (!options.signal?.aborted) {
      onEvent({
        type: 'error',
        error: `The o8 model couldn't reach the model service: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    done();
    return;
  }

  // Non-2xx from the proxy is a JSON error body (`{ error }`), not an SSE stream.
  if (!response.ok || !response.body) {
    let detail = `HTTP ${response.status}`;
    try {
      // Keep the watchdog ARMED across the error-body read. A proxy that sends
      // error headers (502/503) and then hangs the body would otherwise wedge
      // here forever — response.json() is an unbounded await too (adversarial
      // review 2026-07-15). A watchdog abort rejects the read; we fall back to
      // the status-code detail. Disarm only after the read settles.
      armWatchdog();
      const payload = await response.json() as { error?: unknown };
      if (typeof payload?.error === 'string' && payload.error.trim()) detail = payload.error;
    } catch {
      // Non-JSON body, or the watchdog aborted a hung body — keep status detail.
    } finally {
      disarmWatchdog();
    }
    onEvent({ type: 'error', error: `The o8 model is unavailable: ${detail}` });
    done();
    return;
  }

  // SSE frames: `data: {json}\n\n`, terminated by `data: [DONE]`. We map
  // `content`→text, `thinking`→thinking and `error`→error; `usage` /
  // `fallback` / `sources` carry no transcript payload and are skipped.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      armWatchdog();
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]' || data.trim() === '') continue;
        let parsed: { type?: string; text?: unknown; message?: unknown };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.type === 'content' && typeof parsed.text === 'string') {
          if (parsed.text) onEvent({ type: 'text', text: parsed.text });
        } else if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
          if (parsed.text) onEvent({ type: 'thinking', text: parsed.text });
        } else if (parsed.type === 'error') {
          onEvent({
            type: 'error',
            error: typeof parsed.message === 'string' && parsed.message.trim()
              ? parsed.message
              : 'The o8 model hit an error.',
          });
        }
      }
    }
    disarmWatchdog();
    done();
  } catch (err) {
    // A user interrupt aborts the read — a clean stop, no error line. A
    // watchdog abort or any other failure surfaces as a system line. Either way
    // emit the terminal `done` so the client "Working" latch releases (mirrors
    // openclaw's error→done order).
    disarmWatchdog();
    if (watchdogFired) {
      watchdogError();
    } else if (!options.signal?.aborted) {
      onEvent({
        type: 'error',
        error: `The o8 model hit an error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    done();
  }
}

type O8Pi = OrchestratorBackend & { hasSession?(repoPath: string, threadId?: string | null): Promise<boolean> };

/** Trusted seams for tests. Production uses the registered Pi backend and this machine's support. */
export interface O8BackendDeps {
  pi?: O8Pi;
  blocker?: () => string | null;
}

/**
 * An o8 thread that began on the text-only rail (or before #3408) has no Pi
 * session, and ws-server sends no handoff because the backend id is unchanged.
 * Its first Pi turn carries the earlier turns as the same cold-continuation
 * packet a backend switch uses, so the model sees what the operator sees. A
 * packet too large for one Pi prompt is rebuilt with the handoff's compaction.
 */
async function carriedThreadPrelude(pi: O8Pi, repoPath: string, message: string,
  options: OrchestratorTurnOptions): Promise<{ prelude: string } | { lost: true } | null> {
  const threadId = options.threadId;
  if (!threadId?.startsWith('thoughts-') || !pi.hasSession || await pi.hasSession(repoPath, threadId)) return null;
  const [{ backendSwitchRequiresExplicitHandoff, renderBackendSwitchHandoffPrelude }, { buildHandoffPacket, HandoffPacketError },
    { PI_PROMPT_MAX_BYTES }] = await Promise.all([import('@/lib/orchestrator/backend-switch-carry'),
    import('@/lib/orchestrator/handoff-packet'), import('@/lib/pi/sdk/session')]);
  // A real backend switch already gets ws-server's handoff prelude.
  if (backendSwitchRequiresExplicitHandoff({ threadId, toBackend: 'o8' })) return null;
  // ws-server persisted this turn's message before calling the backend; the turn itself carries it.
  const record = await readFile(safeOrchestratorHistoryPath(threadId), 'utf8')
    .then(raw => JSON.parse(raw) as { messages?: Array<{ id?: unknown; role?: unknown }> }).catch(() => null);
  const current = record?.messages?.findLast(entry => entry.role === 'user')?.id;
  const fits = (prelude: string) => Buffer.byteLength(`${prelude}\n\n${message}`) <= PI_PROMPT_MAX_BYTES;
  try {
    for (const narrativeMode of ['auto', 'compact'] as const) {
      const packet = await buildHandoffPacket({ threadId, to: { backend: 'o8', model: options.model ?? null },
        excludeMessageId: typeof current === 'string' ? current : undefined, narrativeMode });
      const prelude = renderBackendSwitchHandoffPrelude(packet);
      if (fits(prelude)) return { prelude };
    }
  } catch (error) {
    // A new thread has no earlier assistant turn, or no persisted record, to carry.
    if (error instanceof HandoffPacketError && (error.code === 'handoff_thread_empty' || error.code === 'handoff_thread_not_found')) {
      return null;
    }
    console.warn('[o8] Earlier turns could not be carried into Pi:', error);
  }
  return { lost: true };
}

export function createO8Backend(deps: O8BackendDeps = {}): OrchestratorBackend {
  const pi = deps.pi ?? piBackend;
  const blocker = deps.blocker ?? o8BuiltInAgentBlocker;
  return {
    id: 'o8',
    label: 'o8',
    get liveSteer() { return blocker() ? undefined : pi.liveSteer; },
    peekSession(repoPath, agent, threadId): OrchestratorSessionInfo | null {
      if (!blocker()) return pi.peekSession(repoPath, agent, threadId);
      const sessionName = o8SessionName(repoPath, threadId);
      return ensured.has(sessionName) ? { sessionName, status: 'ready' } : null;
    },
    ensureSession(repoPath, agent, threadId): OrchestratorSessionInfo {
      if (!blocker()) return pi.ensureSession(repoPath, agent, threadId);
      const sessionName = o8SessionName(repoPath, threadId);
      ensured.add(sessionName);
      return { sessionName, status: 'ready' };
    },
    sendTurn(repoPath, message, onEvent, options) {
      const effortError = unmappedEffortError(options?.thinkingEffort);
      if (effortError) {
        onEvent(effortError); onEvent({ type: 'done', sessionId: null, cost: null });
        return Promise.resolve();
      }
      const reason = blocker();
      // The composer's access mode reaches Pi: Full access writes and runs without asking, Plan only is read-only.
      if (!reason) {
        const carried = carriedThreadPrelude(pi, repoPath, message, options ?? {}).catch((error: unknown) => {
          console.warn('[o8] Earlier turns could not be carried into Pi:', error);
          return { lost: true as const };
        });
        return carried.then((carry) => {
          // Never let the agent look like it remembers what it was not given.
          if (carry && 'lost' in carry) {
            onEvent({ type: 'text', text: 'Earlier turns in this thread could not be carried into o8\'s built-in agent, so it starts without them.\n\n' });
          }
          return pi.sendTurn(repoPath, carry && 'prelude' in carry ? `${carry.prelude}\n\n${message}` : message,
            event => onEvent(event.type === 'turn_receipt' ? { ...event, leadModel: o8ReceiptModel(options ?? {}) } : event), options);
        });
      }
      const sessionName = o8SessionName(repoPath, options?.threadId);
      ensured.add(sessionName);
      return sendTextOnlyTurn(sessionName, reason, message, onEvent, options ?? {});
    },
  };
}

export const o8Backend = createO8Backend();
