/**
 * Managed runs — the `o8 run` primitive.
 *
 * An agent (or the operator) launches a long-running process through `o8 run`,
 * which spawns it inside an o8-owned tmux session (`cortex-run-<id>`) so the
 * operator can attach a LIVE raw-stdout terminal and watch it. This registry
 * tracks those sessions so the ports surface can tag agent-owned ports and the
 * UI can offer a "watch live" chip.
 *
 * The registry persists across server restarts. An optional operator-owned
 * settlement contract also accounts for work outside the owned process tree.
 */

/** running · finished (exited, code may be known) · killed (operator stopped it) · gone (vanished, no code) */
export type ManagedRunStatus = 'running' | 'settling' | 'finished' | 'killed' | 'gone';

export interface ManagedRunSettlementBinding {
  schema: 'o8/managed-run-settlement-binding/v1';
  executionKey: string;
  generation: number;
  branch: string;
  providerSessionId: string | null;
  profileDigest: string;
  receiptId: string;
}

export interface ManagedRunSettlementReceipt {
  receiptId: string;
  bindingDigest: string;
  sequence: number;
  state: 'active' | 'unknown' | 'quiet';
  providerSessionId: string | null;
  cancelledBeforeLaunch: boolean;
  stopRequestId: string | null;
  receivedAt: string;
}

export interface ManagedRunSettlement {
  binding: ManagedRunSettlementBinding;
  bindingDigest: string;
  /** Assigned once by the operator when the provider acknowledges a new session. */
  providerSessionId: string | null;
  receipt: ManagedRunSettlementReceipt | null;
  stopRequestId: string | null;
  stopRequestedAt: string | null;
  wrapperFinished: boolean;
}

/** stream = CLI blocks + mirrors output to its own stdout; detach = fire-and-register. */
export type ManagedRunMode = 'stream' | 'detach';

export type ManagedRunTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface ManagedRunTerminationReceipt {
  schema: 'o8/managed-run-termination/v1';
  reason: 'stream_sigint' | 'operator_stop';
  exitCode: number | null;
  requestedAt: string;
  confirmedAt: string | null;
  confirmedDead: boolean;
  alreadyDead: boolean;
  steps: Array<{
    signal: ManagedRunTerminationSignal;
    groupSignaled: boolean;
    signaledPids: number[];
    sessionAliveAfter: boolean;
    markerPidsAfter: number[];
    errors: string[];
  }>;
  externalSettlement?: 'quiet' | 'unknown';
}

export interface ManagedRunRecord {
  /** short unique id; session is `cortex-run-<id>` */
  id: string;
  /** tmux session name the bottom panel attaches to */
  session: string;
  /** the command line the agent asked to run (display only) */
  command: string;
  /** optional human display title supplied by the launcher */
  title?: string | null;
  /** working directory the command runs in (used to cross-ref lsof ports) */
  cwd: string;
  /** repo slug if known (resolved by the ports route, optional here) */
  repo?: string | null;
  /** packet id when launched from inside a packet worktree */
  packetId?: string | null;
  /** lane id when launched from inside a packet worktree */
  laneId?: string | null;
  /** tmux pane pid — the ports route attributes a port by walking the listening
   *  process's ppid chain up to this pid (o8 owns the session). */
  panePid?: number | null;
  /** POSIX group resolved from the live tmux pane; never trusted without that session. */
  processGroupId?: number | null;
  /** Unique inherited marker used to find descendants that escape the process group. */
  processMarker?: string | null;
  /** Validated wrapper receipt path; absent on older data-directory records. */
  exitReceiptPath?: string;
  /** Internal manifest supervisor binding; never accepted from worker registration bodies. */
  workspaceService?: { worktreePath: string; packetId: string; laneId: string };
  mode: ManagedRunMode;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  status: ManagedRunStatus;
  /** Durable only after the server proved both the tmux session and marked descendants dead. */
  termination?: ManagedRunTerminationReceipt | null;
  /** Host receipts are accepted only from the operator principal. */
  settlement?: ManagedRunSettlement | null;
}
