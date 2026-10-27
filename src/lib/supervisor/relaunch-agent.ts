import { currentRecoveryRun, recoveryInterrupted } from '@/lib/runtimes/shared/owned-session/automatic-recovery';
import { packetAutomaticRecoveryHoldReason } from '@/lib/lane/packet-stop-hold';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readAbnormalStderrTail } from '@/lib/runtimes/shared/owned-session/exit-outcome';
import { codexAuthRecoveryMessage } from '@/lib/runtimes/shared/codex-auth-failure';
import { CODEX_AUTH_RECOVERY_LANE_LABEL } from '@/lib/lane/current-auth-exit';

import { isClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import { findLaneBySession, getLane, updateLane } from '@/lib/lane/registry';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { RuntimeLaunchRequest } from '@/lib/runtime/actions';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { createOwnedSessionIo } from '@/lib/runtimes/shared/owned-session/session-io';
import { fetchRuntimeLaunch } from '@/lib/ws-server/next-fetch';
import type { SupervisorRelaunchResult } from './agent-supervisor-types';

/** Retry from durable launch facts, never the current operator defaults. */
export async function relaunchSupervisedAgent(
  prompt: string,
  repoPath: string,
  taskName: string,
  retryOfSurfaceId?: string,
): Promise<SupervisorRelaunchResult> {
  const lane = retryOfSurfaceId ? findLaneBySession(retryOfSurfaceId) : null;
  if (!lane || !retryOfSurfaceId) {
    return { status: 'held', reason: 'Automatic retry held: the original active lane is unavailable.' };
  }
  const packetHold = lane.packetId && packetAutomaticRecoveryHoldReason(lane.packetId);
  if (packetHold) return { status: 'held', reason: `Automatic retry held: ${packetHold}.` };
  if (!['running', 'recovering'].includes(lane.status)) {
    return { status: 'held', reason: 'Automatic retry held: the lane is no longer running or recovering.' };
  }
  const hold = (reason: string, direct = false, eventLabel = 'supervisor_retry_held'): SupervisorRelaunchResult => {
    const note = direct ? reason : `Automatic retry held: ${reason}. Use an explicit governed retry.`;
    const current = getLane(lane.id);
    if (current?.sessionKey === retryOfSurfaceId && current.status === lane.status
      && current.runtime === lane.runtime && current.worktreePath === lane.worktreePath) {
      updateLane(lane.id, {
        status: 'awaiting_input',
        outcomeNote: note,
        lastEventLabel: eventLabel,
        lastEventAt: new Date().toISOString(),
      }, 'system', { reason: eventLabel, note });
    }
    return { status: 'held', reason: note };
  };
  const runtime = lane.runtime;
  if ((runtime !== 'codex' && runtime !== 'claude-code')
    || !retryOfSurfaceId.startsWith(`${runtime}-owned:`)) {
    return hold('the original runtime and session identity disagree');
  }
  if (!lane.worktreePath || !existsSync(lane.worktreePath)
    || realpathSync(lane.worktreePath) === realpathSync(lane.repoPath)
    || realpathSync(repoPath) !== realpathSync(lane.repoPath)) {
    return hold('the original isolated worktree is unavailable');
  }
  const root = ownedRoots().find((entry) => entry.marker === `${runtime}-owned:`);
  if (!root) return hold('the original runtime storage is unavailable');
  const io = createOwnedSessionIo({
    root: root.root, surfacePrefix: root.marker, invalidateFleetCache: () => {},
  });
  const session = await io.findSession(retryOfSurfaceId).catch(() => null);
  if (session?.executionPolicy !== undefined) return hold('this worker has a single-attempt execution limit');
  if (!session || session.laneId !== lane.id || session.packetId !== (lane.packetId ?? undefined)
    || session.cwd !== lane.worktreePath || session.activeRun) {
    return hold('the original stopped session cannot be verified');
  }
  const generation = currentRecoveryRun(session);
  if (!generation || recoveryInterrupted(session)) return hold('the current run was interrupted or is unavailable');
  if (runtime === 'codex') {
    const failedRun = session.recentRuns.find((run) => run.outcome === 'failed');
    const stderr = failedRun?.childExit?.stderrTail
      ?? (failedRun?.childExit
        ? await readAbnormalStderrTail(failedRun.stderrPath, failedRun.childExit, 4_000)
        : undefined);
    const authMessage = codexAuthRecoveryMessage(stderr ?? '');
    if (authMessage) return hold(authMessage, true, CODEX_AUTH_RECOVERY_LANE_LABEL);
  }
  const model = session.model?.trim();
  if (!model || !isThinkingEffort(session.effort)) {
    return hold('the saved model or reasoning effort is missing');
  }
  const carrier = session.runtimeConfig?.modelSource;
  if (runtime === 'claude-code' && !isClaudeCodeModelSource(carrier)) {
    return hold('the saved execution carrier is missing');
  }
  // A fresh session would reset its spend counter. Never grant the same packet
  // another full budget without an explicit remaining-budget decision.
  if (carrier === 'openrouter') return hold('metered retries need a remaining-budget decision');

  // An operator stop or rebind during the asynchronous read wins over retry.
  const current = getLane(lane.id);
  if (!current || current.sessionKey !== retryOfSurfaceId || current.runtime !== runtime
    || current.status !== lane.status || current.worktreePath !== lane.worktreePath) {
    return { status: 'held', reason: 'Automatic retry held: the lane changed while reading launch state.' };
  }
  const clientMutationId = randomUUID();
  const launchBody: RuntimeLaunchRequest & { clientMutationId: string } = {
    runtime, prompt, taskName, model, effort: session.effort,
    automaticRecoverySurfaceId: retryOfSurfaceId, automaticRecoveryRunId: generation.id,
    ...(runtime === 'claude-code' && isClaudeCodeModelSource(carrier)
      ? { claudeCodeModel: model, claudeCodeCarrier: carrier } : {}),
    workMode: session.runtimeConfig?.workMode === 'read-only' ? 'read-only' : undefined,
    repoPath: lane.worktreePath, cwd: lane.worktreePath, projectRepoPath: lane.repoPath,
    branchName: lane.branch, baseBranch: lane.baseBranch,
    isolate: false, skipSetup: true, existingLaneId: lane.id,
    packetId: lane.packetId ?? undefined, clientMutationId,
  };
  const result = await fetchRuntimeLaunch(launchBody);
  return result.surfaceId
    ? { status: 'launched', surfaceId: result.surfaceId }
    : hold('the launch did not return an accepted session');
}
