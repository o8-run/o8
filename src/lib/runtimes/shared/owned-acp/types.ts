import type { AcpClient, AcpInboundRequest, AcpInitializeResult, AcpRawNotification } from '@/lib/acp/client';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type {
  OwnedRunOutcome,
  OwnedSessionStore,
  OwnedTailEntry,
} from '@/lib/runtimes/shared/owned-session/types';

export interface OwnedAcpRunRecord {
  id: string;
  mode: 'launch' | 'resume';
  prompt: string;
  memoryRevision?: string;
  startedAt: string;
  finishedAt?: string;
  outcome: OwnedRunOutcome;
  stdoutPath: string;
  stderrPath: string;
  pid?: number;
  commandIdentity?: string;
  finishReason?: string;
  interruptRequestedAt?: string;
}

export interface OwnedAcpSessionRecord {
  surfaceId: string;
  launchMutationId?: string;
  laneId?: string;
  packetId?: string;
  sessionDir: string;
  cwd: string;
  repoPath: string;
  repoSlug?: string;
  branch?: string;
  head?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  remoteSessionId?: string;
  /** Compatibility with the shared one-process-per-turn store's persisted field. */
  threadId?: string;
  initialPrompt?: string;
  promptMemoryRevision?: string;
  latestPrompt: string;
  latestSummary: string;
  model?: string;
  effort?: ThinkingEffort;
  reviewDisposition?: 'watching' | 'resolved';
  reviewDispositionUpdatedAt?: string;
  activeRun?: OwnedAcpRunRecord;
  recentRuns: OwnedAcpRunRecord[];
  rpcPid?: number;
  commandIdentity?: string;
  serverVersion?: string;
  supportsResume?: boolean;
  /** Packet ownership ended without process-exit proof; keep recovery data but hide active discovery. */
  detachedAt?: string;
  detachedReason?: string;
}

export interface OwnedAcpLaunchResolution {
  command: string;
  args: string[];
  env?: Record<string, string>;
  commandIdentity?: string;
  version?: string;
}

export interface OwnedAcpRuntimeAdapter {
  runtimeId: string;
  surfaceIdPrefix: string;
  sessionIdPrefix: string;
  rootEnvVar: string;
  rootDefault: string;
  binaryName: string;
  humanLabel: string;
  squadShortName: string;
  defaultModel?: string;
  turnTimeoutMs?: number;
  resolveLaunch(session: OwnedAcpSessionRecord): Promise<OwnedAcpLaunchResolution>;
  validateInitialize?(result: AcpInitializeResult): { version?: string };
  supportsResume?(result: AcpInitializeResult): boolean;
  configureSession?(input: {
    client: AcpClient;
    sessionId: string;
    model?: string;
    resumed: boolean;
  }): Promise<void> | void;
  handleRequest?(request: AcpInboundRequest): unknown | Promise<unknown>;
  shouldPersistNotification?(notification: AcpRawNotification): boolean;
  notificationSummary?(notification: AcpRawNotification): string | null;
  parseRunLog(raw: string, run: OwnedAcpRunRecord): {
    entries: OwnedTailEntry[];
    completedTurn: boolean;
    finishReason?: string;
  };
}

export type OwnedAcpSessionStore = OwnedSessionStore;
