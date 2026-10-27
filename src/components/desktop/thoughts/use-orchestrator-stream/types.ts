import type { TaskArtifactActionStamp } from '@/lib/task-artifacts/types';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileTranscriptEntry, MobileTranscriptToolLaunchLink } from '@/lib/mobile/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { ComposerWireMode } from '@/lib/orchestrator/composer-wire';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';
import type { OrchestratorPermissionMode, OrchestratorStreamStatus } from './shared';

export interface ActiveTurnState {
  startedAt: number;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  latestToolLabel: string | null;
  launches: MobileTranscriptToolLaunchLink[];
}

export interface OrchestratorSendHandle {
  clientMessageId: string;
  userMessageId: string;
  threadId: string;
  backend: OrchestratorBackendId | null;
  transcriptBeforeSend: MobileTranscriptEntry[];
  admission?: Promise<import('./image-send-admission').ImageSendAdmission>;
}

export interface OrchestratorSendOptions {
  /** Explicit voice attachment must not change the orchestrator on quota failure. */
  pinBackend?: boolean;
  /** Interactive task artifact action riding this turn (#1699); the realtime server marks it delivered. */
  taskArtifactAction?: TaskArtifactActionStamp;
  permissionMode?: OrchestratorPermissionMode;
  backend?: OrchestratorBackendId;
  thinkingEffort?: ThinkingEffort;
  serviceTier?: import('@/lib/orchestrator/service-tier').OrchestratorServiceTier;
  model?: string;
  /** Model-facing text. The positional message remains operator-authored text. */
  wireMessage?: string;
  displayMessage?: string;
  localEntriesAfterUser?: MobileTranscriptEntry[];
  orchestrationMode?: OrchestratorExecutionMode;
  /** Composer mode captured when Send was pressed, before backend overrides. */
  pickedMode?: ComposerWireMode;
  collide?: boolean;
  /** Explicit consent to seed a cold cross-backend continuation. */
  handoffMode?: 'handoff';
  attachments?: Array<{ dataUri: string; name?: string }>;
  /** A required durable action that must finish before this turn reaches the worker. */
  beforeSend?: (signal: AbortSignal) => Promise<boolean>;
  /**
   * Resolves settings which must be current when this turn is constructed.
   * The composer uses this for persisted operator defaults, which can change
   * while a tab remains mounted.
   */
  resolveTurnOptions?: (signal: AbortSignal) => Promise<Pick<OrchestratorSendOptions, 'backend' | 'model'>>;
}

export interface OrchestratorStreamOptions {
  /** Hidden tabs retain the stream while throttling text paints. */
  visible?: boolean;
  projectId?: string | null;
  seededPlanText?: string | null;
  hasHistory?: boolean;
  threadId?: string | null;
  /**
   * Called when the hook synchronously mints a threadId inside `send()`
   * because the parent hasn't supplied one yet (first-message-on-empty-tab
   * path). The parent MUST update its own threadId state in response so the
   * next render keeps both sides aligned. Without this, ws-server's
   * `isThreadBacked` guard skips assistant-message persistence and the reply
   * silently drops on reload. See bug investigation 2026-05-27.
   */
  onThreadIdMint?: (threadId: string) => void;
  /** Requests a same-thread history refresh when server turn truth says a
   * settled assistant message is missing from the visible transcript. */
  onSettledAssistantMissing?: (assistantMessageId: string) => void;
}

export interface OrchestratorStreamResult {
  voiceTerminals: Record<string, { outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed'; text: string }>;
  messages: MobileTranscriptEntry[];
  planText: string | null;
  status: OrchestratorStreamStatus;
  busyState: ThoughtsOrchestratorBusyState;
  tokenCount: number;
  runningTotal: number;
  estimateNextTurnTokens: (message: string) => number;
  send: (message: string, options?: OrchestratorSendOptions) => OrchestratorSendHandle | null;
  interrupt: () => void;
  undoSend: (handle: OrchestratorSendHandle) => void;
  appendLocalEntries: (entries: MobileTranscriptEntry[]) => void;
  replaceTranscript: (entries: MobileTranscriptEntry[]) => void;
  fetchTelemetrySnapshot: () => Promise<{
    totalTokens: number | null;
    estimatedCostUsd: number | null;
    model: string | null;
  }>;
  compactNow: (options?: { keepTailCount?: number; source?: 'manual' | 'handoff' }) => Promise<{
    applied: boolean;
    transcript: MobileTranscriptEntry[];
    resumePrelude: string | null;
    tokensAfter: number;
  } | null>;
  reset: () => void;
  retryPendingSend: (clientMessageId: string) => void;
  connected: boolean;
}

export interface ActiveTurnState {
  startedAt: number;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  latestToolLabel: string | null;
  launches: MobileTranscriptToolLaunchLink[];
}
