/**
 * Collide — the Mixture-of-Agents fusion backend.
 *
 * One orchestrator turn becomes a 3-turn collision:
 *   Phase A — every PROPOSER forms an INDEPENDENT, read-only opinion in parallel,
 *             each on its own namespaced side-thread (structural independence).
 *   Phase B — the AGGREGATOR runs on the MAIN, user-visible thread with full
 *             tools: it reads the original intent + every proposal and produces
 *             the synthesized answer AND does the work. Its events stream through
 *             as the sole visible reply — "the upgraded Claude": Claude, sharper,
 *             because Codex collided with it and Claude synthesized.
 *
 * Built config-driven via `makeMoaBackend(config)` (mirrors acp.ts'
 * `makeAcpBackend`): default brain is {claude, codex} → claude, but adding a
 * provider is a config/settings entry, not a rewrite. `collideBackend` reads its
 * config lazily per turn so operator-settings changes apply on the next turn.
 *
 * SAFETY: proposers run with `toolProfile:'propose'` (operator/dispatch server
 * stripped) + `permissionMode:'plan'` (no writes), and `assertProposerEventAllowed`
 * runs LIVE over every proposer event — a proposer that ever tries to write or
 * dispatch is caught at runtime, aborted, and excluded from synthesis. It can
 * never contaminate the aggregator. The #1075 orchestrator≠worker rule.
 *
 * This file imports the leaf backends (`./claude`, `./codex`) DIRECTLY, never the
 * registry — registry.ts imports `collideBackend` from here, so importing it back
 * would cycle. (That's why Step 1 extracted the delegates to leaf files.)
 */

import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';
import { assertCollideEffortPins } from './collide-effort';
import { claudeBackend } from './claude';
import { codexBackend } from './codex';
import { resolveCollideConfig } from './collide-config';
import { assertProposerEventAllowed, ProposerLockoutError } from './proposer-lockout';
import type {
  OrchestratorBackend,
  OrchestratorBackendId,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

/** One participant (proposer or aggregator) in a Collide config. */
export interface MoaParticipant {
  /** Which orchestrator backend plays this role. `'collide'` is not proposable. */
  backend: OrchestratorBackendId;
  model?: string;
  thinkingEffort?: ThinkingEffort;
}

export interface MoaConfig {
  id: OrchestratorBackendId;
  label: string;
  /** Read-only proposers, run in parallel in Phase A. */
  proposers: MoaParticipant[];
  /** The synthesizer + executor, run on the main thread in Phase B. */
  aggregator: MoaParticipant;
}

/** Resolved participant — text + provenance after a proposal turn. */
export interface MoaProposal {
  proposer: string;
  backendId: OrchestratorBackendId;
  text: string;
  /** True when the lockout guard tripped — the proposer tried to act. */
  breach: boolean;
  /** True when the turn hit the subscription weekly cap (degrade signal). */
  capped: boolean;
  /** True when the proposer exceeded the timeout and was aborted + excluded. */
  timedOut: boolean;
}

/**
 * Per-proposer timeout (the hang fix). A proposer that doesn't return within this
 * window is aborted and excluded so Phase A always terminates. Generous — a legit
 * deep proposal reads + reasons; a proposer past this is stuck. Env-overridable.
 */
const PROPOSER_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.O8_COLLIDE_PROPOSER_TIMEOUT_MS || '', 10) || 300_000,
);

/**
 * Heuristic: does an error look like the Claude subscription weekly cap?
 * Only ever triggers GRACEFUL degrade — never a billing change — so a broad,
 * forgiving match is safe. o8 NEVER auto-switches to the metered API (#1066);
 * the cap is surfaced and the operator chooses.
 */
export function looksLikeClaudeCapError(message: string): boolean {
  return /usage limit|rate.?limit|weekly limit|limit reached|reached your|out of (?:usage|credit)|too many requests|\b429\b|quota/i.test(message);
}

/** The clean, operator-facing notice when Collide's aggregator hits the cap. */
export const COLLIDE_CAP_PAUSED =
  'Collide paused — Claude\'s weekly cap is reached. The independent proposals are above. '
  + 'o8 will not auto-switch to the metered API (#1066) — re-run on Codex, or wait for the weekly reset.';

/** Human label per backend id (proposer card headers + aggregator framing). */
const BACKEND_LABELS: Partial<Record<OrchestratorBackendId, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
};
function labelFor(id: OrchestratorBackendId): string {
  return BACKEND_LABELS[id] ?? id;
}

/**
 * Backends that may play a Collide role. Resolved WITHOUT the registry (avoids
 * the moa ↔ registry cycle). `collide` itself is excluded — a MoA can't propose
 * with another MoA (and would recurse).
 */
const PROPOSABLE: Partial<Record<OrchestratorBackendId, OrchestratorBackend>> = {
  claude: claudeBackend,
  codex: codexBackend,
};

export interface MoaDeps {
  /** Resolve a backend id → instance. Injectable for tests. */
  resolveBackend: (id: OrchestratorBackendId) => OrchestratorBackend;
  /** Per-proposer timeout override (tests inject a tiny value). */
  proposerTimeoutMs?: number;
}

const defaultDeps: MoaDeps = {
  resolveBackend(id) {
    const backend = PROPOSABLE[id];
    if (!backend) {
      throw new Error(
        `Collide: backend '${id}' cannot be a proposer/aggregator (proposable: ${Object.keys(PROPOSABLE).join(', ')}).`,
      );
    }
    return backend;
  },
};

/** The proposer's private side-thread id — structural independence from the
 *  main thread and from the other proposers. Indexed by POSITION (not backend
 *  id) so two same-backend proposers (reachable via O8_COLLIDE_PROPOSERS) get
 *  distinct threads instead of racing one shared session. */
function proposeThreadId(mainThreadId: string | null | undefined, index: number, backendId: OrchestratorBackendId): string {
  return `${mainThreadId ?? 'default'}::collide-propose::${index}-${backendId}`;
}

/**
 * The aggregator's input: the original request + every independent proposal,
 * framed as "you already made a first pass; second opinions arrived — synthesize
 * and do the work." Pure + exported so the engine test can assert both proposals
 * are present.
 */
export function buildAggregatorMessage(
  message: string,
  proposals: MoaProposal[],
  aggregatorBackendId: OrchestratorBackendId,
): string {
  const sections = proposals.map((p) => {
    const isSelf = p.backendId === aggregatorBackendId;
    const head = p.breach
      ? `${p.proposer} (excluded — attempted to act; read-only lockout tripped)`
      : isSelf
        ? `Your own first independent pass (${p.proposer})`
        : `Independent second opinion (${p.proposer})`;
    const body = p.breach ? '(excluded for safety)' : (p.text || '(no proposal produced)');
    return `### ${head}\n${body}`;
  });

  return [
    'You already made a first independent pass at the request below, and one or more independent '
      + 'second opinions have arrived. Synthesize the strongest possible answer and DO THE WORK — don\'t '
      + 'blend mechanically: take what is right from each, fix what is weak, resolve disagreements with '
      + 'your own judgment. The user sees only your synthesized result, so make it whole.',
    '',
    '## Original request',
    message,
    '',
    '## Independent proposals (read-only — none of these touched the repo)',
    sections.join('\n\n'),
    '',
    '## Now',
    'Produce the synthesized answer and carry out the work.',
  ].join('\n');
}

/** Chain a child AbortController to a parent signal (selective per-proposer abort). */
function childSignal(parent?: AbortSignal): { signal: AbortSignal; abort: () => void; dispose: () => void } {
  const controller = new AbortController();
  if (!parent) return { signal: controller.signal, abort: () => controller.abort(), dispose: () => {} };
  if (parent.aborted) {
    controller.abort();
    return { signal: controller.signal, abort: () => controller.abort(), dispose: () => {} };
  }
  const onAbort = () => controller.abort();
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parent.removeEventListener('abort', onAbort),
  };
}

/** Run one proposer turn read-only; buffer its text; the guard runs LIVE. */
async function runProposal(
  deps: MoaDeps,
  participant: MoaParticipant,
  index: number,
  repoPath: string,
  message: string,
  mainThreadId: string | null,
  parentSignal: AbortSignal | undefined,
): Promise<MoaProposal> {
  const backend = deps.resolveBackend(participant.backend);
  const proposerLabel = labelFor(participant.backend);
  const child = childSignal(parentSignal);
  let text = '';
  let breach: ProposerLockoutError | null = null;
  let lastError: string | null = null;
  let timedOut = false;

  const runTurn = (async () => {
    try {
      await backend.sendTurn(
        repoPath,
        message,
        (event) => {
          if (breach) return; // already tripped — ignore the rest of this turn
          try {
            // LIVE lockout — a proposer that tries to write/dispatch is caught here.
            assertProposerEventAllowed(event, proposerLabel);
          } catch (err) {
            breach = err instanceof ProposerLockoutError ? err : new ProposerLockoutError('unknown', 'write', proposerLabel);
            console.error(`[collide] LOCKOUT BREACH — ${proposerLabel} attempted to act; aborting proposer. ${breach.message}`);
            child.abort(); // SIGTERM the proposer subprocess
            return;
          }
          if (event.type === 'text') text += event.text;
          else if (event.type === 'error') lastError = event.error;
          // proposer thinking / read-only tool calls are consumed, never surfaced
          // as the visible answer (only the aggregator streams).
        },
        {
          permissionMode: 'plan',
          toolProfile: 'propose',
          model: participant.model,
          thinkingEffort: participant.thinkingEffort,
          threadId: proposeThreadId(mainThreadId, index, participant.backend),
          signal: child.signal,
        },
      );
    } catch (err) {
      if (!breach) lastError = err instanceof Error ? err.message : String(err);
    }
  })();

  // GUARANTEE termination (the 17-min hang fix): a proposer that doesn't return
  // within the bounded window is aborted and excluded. The race resolves on the
  // timeout even if sendTurn never settles, so Phase A's Promise.all can NEVER
  // hang forever. Collide aggregates with whatever DID return (or degrades to
  // the single-Claude path when all proposers are excluded).
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = deps.proposerTimeoutMs ?? PROPOSER_TIMEOUT_MS;
  const timeoutRace = new Promise<void>((res) => {
    timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[collide] proposer ${proposerLabel} exceeded ${timeoutMs}ms — aborting; aggregating without it.`);
      child.abort();
      res();
    }, timeoutMs);
  });

  await Promise.race([runTurn, timeoutRace]);
  if (timer) clearTimeout(timer);
  child.dispose();

  const capped = !breach && !timedOut && lastError !== null && looksLikeClaudeCapError(lastError);
  let finalText = text.trim();
  if (!finalText && !breach) {
    finalText = timedOut
      ? `(${proposerLabel} timed out — excluded; Collide aggregated without it)`
      // Cap-degrade ladder rung (a): a capped proposer is dropped → Collide Lite.
      : capped
        ? `(skipped — ${proposerLabel}'s weekly cap reached; Collide ran Lite this turn)`
        : lastError
          ? `(${proposerLabel} proposal unavailable: ${lastError})`
          : '';
  }

  return { proposer: proposerLabel, backendId: participant.backend, text: finalText, breach: breach !== null, capped, timedOut };
}

/**
 * Build a MoA backend from a config (or a per-turn config thunk). `deps` is
 * injectable so the engine test can drive mock proposers + a mock aggregator.
 */
export function makeMoaBackend(
  configOrThunk: MoaConfig | ((options?: OrchestratorTurnOptions) => MoaConfig),
  deps: MoaDeps = defaultDeps,
): OrchestratorBackend {
  const resolveConfig = typeof configOrThunk === 'function' ? configOrThunk : () => configOrThunk;
  const staticId = typeof configOrThunk === 'function' ? 'collide' : configOrThunk.id;
  const staticLabel = typeof configOrThunk === 'function' ? 'Collide' : configOrThunk.label;

  return {
    id: staticId,
    label: staticLabel,
    peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
      // The aggregator owns the main, visible thread — mirror its session.
      const agg = deps.resolveBackend(resolveConfig().aggregator.backend);
      return agg.peekSession(repoPath, undefined, threadId);
    },
    ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
      const agg = deps.resolveBackend(resolveConfig().aggregator.backend);
      return agg.ensureSession(repoPath, undefined, threadId);
    },
    async sendTurn(repoPath, message, onEvent, options?: OrchestratorTurnOptions): Promise<void> {
      const config = resolveConfig(options);
      const mainThreadId = options?.threadId ?? null;
      const signal = options?.signal;
      // Only an explicit turn/configuration pin overrides the runtime default.
      // Adaptive is an explicit reset, including when configuration has a pin.
      const aggregatorChoice = { ...config.aggregator, model: options?.model ?? config.aggregator.model,
        thinkingEffort: options?.thinkingEffort ?? config.aggregator.thinkingEffort };
      try {
        await assertCollideEffortPins(options?.orchestrationMode === 'single' ? [] : config.proposers, aggregatorChoice);
      } catch (error) {
        onEvent({ type: 'error', error: error instanceof Error ? error.message : String(error),
          ...(error instanceof EffortPinRejectionError ? { code: error.code } : {}) });
        onEvent({ type: 'done', sessionId: null, cost: null });
        return;
      }

      // Collide is a composition backend, not a Solo runtime. If an existing
      // setting points at Collide while the composer chooses Solo, run only its
      // configured aggregator and skip the proposal fan-out entirely.
      if (options?.orchestrationMode === 'single') {
        const aggregator = deps.resolveBackend(config.aggregator.backend);
        await aggregator.sendTurn(repoPath, message, onEvent, {
          ...options,
          permissionMode: options.permissionMode ?? 'full',
          model: aggregatorChoice.model,
          thinkingEffort: aggregatorChoice.thinkingEffort,
          threadId: mainThreadId,
          signal,
          toolProfile: 'solo',
        });
        return;
      }

      // ── Phase A — parallel independent proposals (read-only) ─────────────────
      // Warm-pool note: the Claude proposer routes through orchestrator-session.ts
      // (RESIDENT process — warm after the first turn). The Codex proposer routes
      // through codex-orchestrator-session.ts, which is COLD by design (`codex
      // exec` is batch, no resident-process path short of Codex's proto mode) —
      // warming it is a separate follow-up. So a Collide turn warms the Claude
      // proposer + the Claude aggregator; the Codex proposer stays at the
      // exec-resume floor.
      onEvent({ type: 'collide_phase', phase: 'proposing', proposers: config.proposers.map((p) => labelFor(p.backend)) });

      const proposals = await Promise.all(
        config.proposers.map(async (participant, index) => {
          const proposal = await runProposal(deps, participant, index, repoPath, message, mainThreadId, signal);
          // Faint pre-roll card — buffered, not streamed. On a breach the text is
          // REDACTED AT SOURCE: a proposer that tried to act doesn't get its
          // pre-breach buffered text across the wire at all (the render layer also
          // hides it, but it must never leave the server). The marker stays so the
          // tripped proposer is visibly excluded rather than silently dropped.
          onEvent({
            type: 'collide_proposal',
            proposer: proposal.proposer,
            text: proposal.breach ? '' : proposal.text,
            breach: proposal.breach,
          });
          return proposal;
        }),
      );

      // ── Phase B — aggregate + execute on the MAIN thread (the visible answer) ─
      onEvent({ type: 'collide_phase', phase: 'synthesizing' });
      const aggregator = deps.resolveBackend(config.aggregator.backend);
      const aggregatorMessage = buildAggregatorMessage(message, proposals, config.aggregator.backend);

      // Aggregator honors the composer chips: permissionMode (Full/Read-only) and
      // the composer model/effort override the config defaults. toolProfile stays
      // 'full' — the aggregator keeps dispatch as an escape hatch (policy A).
      //
      // Cap-degrade ladder: a cap error from the aggregator is rewritten to the
      // clean "Collide paused" notice. There is NO auto-metered fallback — the
      // aggregator runs through the subscription-billed backend (assertNoPrintFlag
      // blocks -p), so o8 structurally cannot switch to metered API (#1066). The
      // operator chooses: re-run on Codex, or wait for the weekly reset.
      await aggregator.sendTurn(
        repoPath,
        aggregatorMessage,
        (event) => {
          if (event.type === 'error' && looksLikeClaudeCapError(event.error)) {
            onEvent({ type: 'error', error: COLLIDE_CAP_PAUSED });
            return;
          }
          onEvent(event);
        },
        {
          permissionMode: options?.permissionMode ?? 'full',
          model: aggregatorChoice.model,
          thinkingEffort: aggregatorChoice.thinkingEffort,
          threadId: mainThreadId,
          signal,
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
        },
      );
    },
  };
}

/** The shipping Collide backend — config resolved lazily per turn from settings. */
export const collideBackend: OrchestratorBackend = makeMoaBackend((options) => resolveCollideConfig(options?.collideBaseBackend, options?.model));
