import type { RuntimeId } from '@/lib/runtimes';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';
import type { PacketSpendCap } from '@/lib/orchestrator/metered-spend';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';

export interface RuntimeLaunchRequest {
  /** Recall epoch bound before assembling this launch prompt. */
  promptMemoryRevision?: string;
  controlledTask?: import('@/lib/mcp/task-execution-store').ControlledTaskBinding;
  executionPolicy?: 'single-attempt';
  controlledProvider?: import('@/lib/runtimes/shared/owned-session/controlled-provider').ControlledOpenRouterPolicy;
  automaticRecoverySurfaceId?: string;
  automaticRecoveryRunId?: string;
  runtime: RuntimeId;
  prompt: string;
  model?: string;
  claudeCodeModel?: string;
  claudeCodeCarrier?: ClaudeCodeModelSource;
  executionCarrier?: ExecutionCarrierId;
  /** Requested reasoning effort; concrete pins must pass runtime admission unchanged. */
  effort?: ThinkingEffort;
  clientMutationId?: string;
  cwd?: string;
  repoPath?: string;
  /** Canonical repo root for project context when cwd/repoPath points at an isolated worktree. */
  projectRepoPath?: string;
  taskName?: string;
  /**
   * Pre-assigned lane branch the worktree must check out before the agent
   * spawns. Without this, prepareLaunchWorktree falls back to the legacy
   * `worktree/<agent>/<slug>` placeholder branch and the agent has to
   * self-correct via `git checkout -b <lane.branch>`. Weaker models miss
   * the prompt hint and silently commit on the wrong branch — the lane
   * merge then sees an empty diff. Dispatch passes `lane.branch` here.
   */
  branchName?: string;
  baseBranch?: string;
  isolate?: boolean;
  isolation?: 'main' | 'branch';
  skipSetup?: boolean;
  // When set, the caller already owns a lane for this launch (eg. packet
  // dispatch going through the lane command bus). launchRuntimeSurface will
  // skip its implicit lane creation and leave binding to the caller.
  existingLaneId?: string;
  // When the launch is bound to a packet, include its id so supervisor inbox
  // items surfaced during pre-launch (eg. rebase conflicts) can deep-link
  // back to the packet card. Leave undefined for scratch runs that aren't
  // tied to a packet. Also drives the worktree directory naming (one slot
  // per packet, instead of a shared taskName-derived slot).
  packetId?: string;
  spendCap?: PacketSpendCap;
  /**
   * Optional caller hint. The durable packet launch context wins when it is
   * stricter, so a caller can never widen a read-only packet by omitting it.
   */
  workMode?: WorkerWorkMode;
  /** Scheduler-owned storage reservation reused by the managed-worktree boundary. */
  storageAdmissionReservationId?: string;
}
