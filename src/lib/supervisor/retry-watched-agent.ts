import type { SupervisorCallbacks, SupervisorRelaunchResult, WatchedAgent } from './agent-supervisor-types';

/** Count and announce only accepted launches; a hold ends automatic supervision. */
export async function retryWatchedAgent(
  watched: WatchedAgent,
  callbacks: SupervisorCallbacks,
  state: {
    /** False when another process unregistered the watch; the lane must not be relaunched. */
    persist(agent: WatchedAgent): boolean;
    /** False when another process unregistered the watch during an await. */
    held(agent: WatchedAgent): boolean;
    replace(surfaceId: string): void;
    scheduleCleanup(): void;
  },
): Promise<void> {
  // Reserve this transition before awaiting launch, including against completion pushes.
  watched.completionReported = true;
  watched.lastEventAt = Date.now();
  if (!state.persist(watched)) return;
  let result: SupervisorRelaunchResult;
  try {
    result = await callbacks.relaunchAgent(
      watched.prompt, watched.repoPath,
      `${watched.name} (retry ${watched.retryCount + 1})`, watched.surfaceId,
    );
  } catch {
    // An uncertain launch is not permission to retry again or expose raw provider output.
    result = { status: 'held', reason: 'Automatic retry held: launch acceptance could not be confirmed. Check the lane before retrying.' };
  }
  watched.lastEventAt = Date.now();
  // The operator stopped the lane while the relaunch was in flight. A stop means stop: end the
  // session the relaunch just started instead of watching it or reporting a retry.
  if (!state.held(watched)) {
    if (result.status === 'launched') await callbacks.interruptAgent(result.surfaceId).catch(() => {});
    return;
  }
  if (result.status === 'held') {
    watched.lastStatus = 'failed';
    state.persist(watched);
    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId, name: watched.name,
      status: 'awaiting_input', detail: result.reason,
    });
    state.scheduleCleanup();
    return;
  }
  watched.retryCount += 1;
  state.persist(watched);
  callbacks.broadcastAgentUpdate({
    surfaceId: watched.surfaceId, name: watched.name, status: 'retrying',
    detail: `Agent "${watched.name}" failed; retry ${watched.retryCount} was accepted.`,
  });
  callbacks.onAgentRetry?.(watched.surfaceId, result.surfaceId);
  state.replace(result.surfaceId);
}
