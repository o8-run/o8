/**
 * Read-only work mode for owned worker sessions.
 *
 * `WorkerLaunchContext.workMode` is resolved from the PERSISTED packet at the
 * launch chokepoint (`launchRuntimeSurface`) and pinned onto the owned
 * session's `runtimeConfig`, so it survives restart, retry, and rerun the same
 * way the model/carrier pins do. Adapters read it to harden argv; the spawn
 * chokepoint reads it to harden the OS sandbox.
 */

export const READ_ONLY_WORK_MODE = 'read-only';

/** Credential-free runtimeConfig fragment pinned at launch. */
export function workModeRuntimeConfig(workMode?: string | null): Record<string, string> {
  return workMode === READ_ONLY_WORK_MODE ? { workMode: READ_ONLY_WORK_MODE } : {};
}

/** Is this owned session pinned to a read-only packet? */
export function isReadOnlyRuntimeConfig(runtimeConfig?: Record<string, string>): boolean {
  return runtimeConfig?.workMode === READ_ONLY_WORK_MODE;
}

/**
 * How a spawn must treat a read-only session's OS sandbox.
 *
 * `enforced` is deliberately independent of `O8_WORKER_SANDBOX`: that gate is
 * the operator's switch for hardening NORMAL packets (on by default on macOS). A
 * read-only packet is a governance promise, so its sandbox is mandatory —
 * without it the argv tool deny leaves Bash, and Bash can write the worktree.
 * The spawn chokepoint ORs this with that gate and stays FAIL-CLOSED: if
 * the sandbox cannot be built the run is refused, never downgraded.
 *
 * This module deliberately does NOT resolve the write-deny paths itself. The
 * git metadata dirs a read-only run must be denied are exactly the ones
 * `prepareWorkerSandbox` already probes in order to GRANT git access, so that
 * single probe owns both sides — see its `enforceReadOnly` input. A second
 * probe here could disagree with the grant and deny a narrower set.
 */
export interface ReadOnlySandboxPlan {
  enforced: boolean;
}

const WRITE_PACKET_PLAN: ReadOnlySandboxPlan = { enforced: false };
const READ_ONLY_PACKET_PLAN: ReadOnlySandboxPlan = { enforced: true };

/** Resolve the read-only sandbox plan for a session about to spawn. */
export function resolveReadOnlySandboxPlan(session: {
  runtimeConfig?: Record<string, string>;
}): ReadOnlySandboxPlan {
  return isReadOnlyRuntimeConfig(session.runtimeConfig) ? READ_ONLY_PACKET_PLAN : WRITE_PACKET_PLAN;
}
