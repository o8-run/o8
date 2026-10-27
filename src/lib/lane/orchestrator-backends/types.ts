/**
 * Orchestrator backend contract.
 *
 * An "orchestrator backend" is a runtime that, given a user message + the o8
 * operator MCP config, drives one orchestrator turn and emits an
 * `OrchestratorEvent` stream. Codex and Claude are the first two backends;
 * openclaw is added next, Hermes after.
 *
 * The backend is NOT the worker runtime. Workers (Codex packets in isolated
 * worktrees) are dispatched by the orchestrator through the o8 operator MCP,
 * regardless of which backend orchestrates — that is the whole point of the
 * orchestrator-runtime ≠ worker-runtime rule (issue #1075).
 *
 * See `registry.ts` for the registry + the Codex/Claude delegate backends.
 */

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { OrchestratorCrashSurvivalMeta } from '@/lib/lane/orchestrator-crash-survival';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';

/**
 * The set of orchestrator backends. `hermes` drives Hermes via the generic ACP
 * backend; `acp` is the generic escape hatch for any other ACP agent. `collide`
 * is the Mixture-of-Agents fusion brain (moa.ts) — a backend whose proposers +
 * aggregator are themselves backends; it is a BRAIN only, never a worker runtime.
 * `fable` is a Claude-only variant (fable.ts) that forces the `claude-fable-5`
 * model, strips Claude's native read/write tools (the token lever) via the
 * `'fable'` ToolProfile, and injects the operator's BYO `ANTHROPIC_API_KEY`.
 * `o8` is the FREE conversational backend (o8.ts) — it streams the Vercel AI
 * Gateway free model so the operator can exercise the full orchestrator UI with
 * no subscription draw; it has no tools and never dispatches (v1).
 * `pi` is the bundled Pi SDK session on the managed model route (pi.ts), with
 * the same built-in o8 servers as the Claude orchestrator.
 */
export type OrchestratorBackendId = 'codex' | 'claude' | 'openclaw' | 'hermes' | 'acp' | 'collide' | 'fable' | 'o8' | 'opencode' | 'pi' | 'muse';

/**
 * The single runtime validation point for the backend-id union. Callers that
 * accept an untrusted `backend` value (ws-server, the chat-history routes,
 * mobile thread history) narrow through this instead of re-inlining the literal
 * comparison — so adding a backend is one edit here (union + guard), not N.
 */
export function isOrchestratorBackendId(value: unknown): value is OrchestratorBackendId {
  return value === 'codex' || value === 'claude' || value === 'openclaw' || value === 'hermes'
    || value === 'acp' || value === 'collide' || value === 'fable' || value === 'o8'
    || value === 'opencode' || value === 'pi' || value === 'muse';
}

export type OrchestratorSessionStatus = 'ready' | 'busy' | 'dead';

export interface OrchestratorTurnOptions {
  /** Operator-authored text, kept separate from model-facing wrappers for Codex app history. */
  rawMessage?: string;
  /** Full access keeps the built-in command workspace boundary; outside-workspace explicitly lifts it. Plan is read-only. */
  permissionMode?: import('@/lib/orchestrator/permission-mode').OrchestratorPermissionMode;
  /** Set on a review turn: its metered calls are recorded as reviewer usage on this lane and packet (#3742). */
  reviewUsage?: { reviewTurnId: string; laneId: string; packetId: string | null; surface: string };
  /** Start a new conversation instead of resuming the thread's; each review turn reads its diff fresh (#3742). */
  freshSession?: boolean;
  /** Per-turn fan-out policy shared by every composer surface. */
  orchestrationMode?: OrchestratorExecutionMode;
  /**
   * MCP tool profile for the turn. `'full'` (default) gives the backend its full
   * server surface; `'propose'` strips the operator (dispatch) server so the run
   * is a read-only proposer that cannot hand off work — Collide's #1075 lockout.
   * Pairs with `permissionMode: 'plan'` (execute lockout) for a proposer turn.
   */
  toolProfile?: ToolProfile;
  thinkingEffort?: ThinkingEffort;
  serviceTier?: import('@/lib/orchestrator/service-tier').OrchestratorServiceTier;
  model?: string;
  /** For a Collide turn, the composer backend selected before routing to `collide`. */
  collideBaseBackend?: OrchestratorBackendId;
  /** UI/history thread id (thoughts-*), used to isolate backend session identity. */
  threadId?: string | null;
  /**
   * openclaw agent id for the turn — openclaw backend only, ignored by codex /
   * claude. Omitted → the backend's default agent. See docs/internals/openclaw-integration.md.
   */
  agent?: string;
  /** Aborts the in-flight turn — the backend SIGTERMs its subprocess. */
  signal?: AbortSignal;
  /**
   * Composer image attachments (data URIs). The Claude backend converts
   * them to base64 image content blocks on stdin; Codex passes stored image
   * files with --image.
   */
  attachments?: Array<{ dataUri: string; name?: string }>;
  crashSurvival?: OrchestratorCrashSurvivalMeta;
}

/** Lightweight view of a backend's per-repo session. */
export interface OrchestratorSessionInfo {
  sessionName: string;
  status: OrchestratorSessionStatus;
}

export interface OrchestratorBackend {
  readonly id: OrchestratorBackendId;
  /** Human-readable label, used in logs. */
  readonly label: string;
  /** Present only for native live input. A normal sendTurn may interrupt or restart work. */
  readonly liveSteer?: (repoPath: string, message: string, options: Pick<OrchestratorTurnOptions, 'threadId' | 'permissionMode' | 'model' | 'thinkingEffort' | 'toolProfile' | 'attachments' | 'orchestrationMode'> & { beforeAdmit: () => void; clientUserMessageId?: string }) => Promise<{ accepted: boolean }>;
  /**
   * Look up the repo's session WITHOUT creating one — null if none exists.
   * `agent` selects the openclaw agent (openclaw backend only).
   * `threadId` scopes built-in Claude/Codex sessions to one persisted chat.
   */
  peekSession(repoPath: string, agent?: string, threadId?: string | null): OrchestratorSessionInfo | null;
  /**
   * Ensure a session exists for the repo, creating/recovering as needed.
   * `agent` selects the openclaw agent (openclaw backend only).
   * `threadId` scopes built-in Claude/Codex sessions to one persisted chat.
   */
  ensureSession(repoPath: string, agent?: string, threadId?: string | null): OrchestratorSessionInfo;
  /**
   * Run one orchestrator turn. Ensures the session, spawns the backend, and
   * streams `OrchestratorEvent`s to `onEvent`. Resolves when the turn ends.
   */
  sendTurn(
    repoPath: string,
    message: string,
    onEvent: (event: OrchestratorEvent) => void,
    options?: OrchestratorTurnOptions,
  ): Promise<void>;
}
