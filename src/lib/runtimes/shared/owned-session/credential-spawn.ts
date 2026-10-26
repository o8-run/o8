import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { spawnWithWorkAdmission as spawn } from '@/lib/app-update/work-launch-admission';
import { bindDeferredCodexMcpLaunch } from '@/lib/providers/deferred-mcp-arguments';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import { assertControlledLaunchGrantCurrent } from '@/lib/mcp/task-execution-admission';
import { ownedSpawnEnvironment } from './restricted-spawn-env';
import { assertOwnedActionAdmission } from './action-admission';
import type { OwnedSessionRecord } from './types';
import { withChildEnvironment } from '@/lib/providers/child-process';
import { reserveWorkLaunch } from '@/lib/app-update/work-launch-admission';
import { ownedSupervisorClient, type SupervisorReceipt } from '@/lib/runtime/o8d-supervisor';
import { getDataDir } from '@/lib/data-dir-migration';
import { join } from 'node:path';

export function assertLaunchCredentialPolicy(runtimeId: string, expected: string): void {
  if (credentialPolicyFingerprint(runtimeId) !== expected) throw new Error('Credentials or billing changed during launch preparation. Retry the launch.');
}

/** Shared inputs for direct spawn and authenticated supervisor submission. */
type LaunchInput = {
  session: OwnedSessionRecord; runtimeId: string; policy: string; runId: string;
  binary: string; args: string[]; env: Record<string, string>;
  stdinFd?: number; stdoutFd: number; stderrFd: number; mcpConfigPath?: string;
  mcpServers?: readonly { name: string; env?: Record<string, string> | null }[];
  materializationIdentity: Parameters<typeof guardedWorkspaceInvocation>[2];
  assertWorkerO8Current?: () => void;
  onSubmit?: () => void;
};

function withCheckedLaunch<T>(input: LaunchInput, create: (launch: { command: string; args: string[] }, env: ReturnType<typeof ownedSpawnEnvironment>) => T): T {
  return withProviderStoreLock(() => {
    assertLaunchCredentialPolicy(input.runtimeId, input.policy);
    const env = ownedSpawnEnvironment(input.session, input.env);
    const build = (args: string[]) => {
      const invocation = cliInvocation(input.binary, args);
      return process.platform === 'win32'
        ? guardedWorkspaceInvocation(invocation.command, invocation.args, input.materializationIdentity)
        : guardedWorkspaceInvocation('/usr/bin/nice', ['-n', '10', input.binary, ...args], input.materializationIdentity);
    };
    const launch = input.runtimeId === 'codex'
      ? bindDeferredCodexMcpLaunch(env, input.args, input.mcpServers ?? [], build) : build(input.args);
    assertControlledLaunchGrantCurrent(input.session);
    assertOwnedActionAdmission(input.session, input.runId);
    input.assertWorkerO8Current?.();
    input.onSubmit?.();
    return create(launch, env);
  });
}

/**
 * No await between the shared policy check and direct OS process creation.
 *
 * Staged input is delivered through a real pipe, never by handing the child
 * the regular file as fd 0: Claude Code's `--input-format stream-json` reads
 * nothing from a regular-file stdin and exits 0 with no output. A pipe matches
 * the bridge path (`printf %s payload | cli`) on every platform.
 */
export function spawnCredentialCheckedChild(input: LaunchInput): ChildProcess {
  const stdinPayload = input.stdinFd === undefined ? undefined : readFileSync(input.stdinFd);
  const child = withCheckedLaunch(input, (launch, env) => spawn(launch.command, launch.args, {
      windowsHide: true, cwd: input.session.repoPath, detached: true,
      stdio: [stdinPayload === undefined ? 'ignore' : 'pipe', input.stdoutFd, input.stderrFd],
      env,
  }));
  if (stdinPayload !== undefined) writeChildStdin(child, stdinPayload);
  return child;
}

/** Streams the payload then closes stdin so the CLI sees EOF after one turn. */
export function writeChildStdin(child: ChildProcess, payload: Buffer | string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  // A child that exits before reading raises EPIPE here; its exit is recorded
  // through the normal child-exit path, so this must not crash the server.
  stdin.on('error', () => {});
  stdin.end(payload);
}

/** Only native, finite-input Codex uses this opt-in submission boundary. */
export async function spawnCredentialCheckedSupervised(input: LaunchInput & {
  stdoutPath: string; stderrPath: string; stdinPath?: string;
}): Promise<SupervisorReceipt> {
  const lease = reserveWorkLaunch(input.binary);
  lease.started(process.pid);
  let submitted = false;
  let preparationError: unknown;
  try {
    const receipt = await ownedSupervisorClient().spawn(() => { try { return withCheckedLaunch(input, (launch, env) => (
      withChildEnvironment(env, [launch.command, ...launch.args], resolved => {
        lease.started(process.pid);
        submitted = true;
        const workerEnv = { ...resolved };
        for (const name of ['O8D_SUPERVISOR_TOKEN', 'O8D_SUPERVISOR_SOCKET', 'O8_PROCESS_SUPERVISOR']) delete workerEnv[name];
        return { id: input.runId, owner: input.session.surfaceId, ...launch, env: workerEnv,
          cwd: input.session.repoPath, stdoutPath: input.stdoutPath, stderrPath: input.stderrPath,
          admissionPath: join(getDataDir(), 'work-launches', `${lease.id}.json`),
          ...(input.stdinPath ? { stdinPath: input.stdinPath } : {}) };
      }, true, input.session.repoPath)
    )); } catch (error) { preparationError = error; throw error; } });
    // The daemon transferred the admission reader before exec and releases it
    // after output and exit settle, independently of this server's lifetime.
    return receipt;
  } catch (error) {
    if (!submitted) lease.release();
    throw preparationError ?? error;
  }
}
