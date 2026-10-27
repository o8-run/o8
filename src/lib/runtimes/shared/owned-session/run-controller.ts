import { hasRuntimeLaunchDeadline, runtimeLaunchRead, runtimeLaunchStep } from '@/lib/runtime/launch-deadline';
import { createWorkerFailureHandler } from './worker-failure';
import { assertRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import { assertOwnedActionFence, hasOwnedActionFence } from './action-fence';
import { createCapacityRecovery } from './capacity-wait';
import { packetCargoEnvironment } from '@/lib/worktree/cargo-target-cache';
import { createRunArtifactReader } from './run-artifact-reader';
import { controlledProviderSandbox } from './controlled-provider-sandbox';
import { providerCredentialName } from '@/lib/providers/spawn-environment';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { assertLaunchCredentialPolicy, spawnCredentialCheckedChild, spawnCredentialCheckedSupervised } from './credential-spawn';
import { processSupervisorEnabled, type SupervisorReceipt } from '@/lib/runtime/o8d-supervisor';
import { reconcileSupervisedSession } from './supervised-run';
import { revokeControlledGateway } from '@/lib/claude-code/controlled-gateway';
import { mintReadOnlyWorkerToken, revokeReadOnlyWorkerToken } from '@/lib/auth/read-only-worker-token';
import { ownedSpawnEnvironment } from './restricted-spawn-env';
import { withControlledTaskSpawn } from '@/lib/mcp/task-execution-admission';
import { assertOwnedActionAdmission } from './action-admission';
import { withOwnedArtifactAdmission } from './artifact-admission';
import { cleanupWorkerO8Cli } from './worker-o8-cli-cleanup';
import { createFailureRetry } from './failure-retry';
import { assertOwnedSingleAttemptSpawn, assertDurableOwnedSpawn } from './execution-policy';
import type { ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getOrCreateLocalWorkerToken } from '@/lib/auth/worker-token';
import {
  bindPacketWorkerTokenProcess,
  mintPacketWorkerToken,
} from '@/lib/auth/packet-worker-token';
import { recordLaneEvent } from '@/lib/lane/events';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { spawnBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { ensureDispatchBackendReady } from '@/lib/runtimes/shared/dispatch-readiness';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { executionCarrierCommandIdentity, executionCarrierSandboxReadPaths, executionCarrierSpawnPath, resolveExecutionCarrierInvocation } from '@/lib/runtimes/shared/execution-carrier-launch';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import { tmuxSessionName } from '@/lib/terminal/tmux';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { crashSurvivableWorkersEnabled } from './crash-survival';
import { assertOwnedSessionProcessIdentity, captureOwnedRunIdentity, verifyStartedChildIdentity } from './process-identity';
import { emitRuntimeFallbackNotification, notifySupervisorOfCleanExit } from './run-notifications';
import { observeChildExit, readAbnormalStderrTail, silentCleanExitMessage } from './exit-outcome';
import { prepareOwnedLaunchArgs } from './launch-args';
import { WorkerO8CliUnavailableError } from './worker-o8-cli';
import { stageOwnedLaunchFailure } from './launch-failure';
import { detectSandboxDenial, detectRunSandboxDenial, sandboxDenialOperatorMessage } from './sandbox-denial';
import {
  RUNS_DIR,
  compactText,
  deriveRunOutcome,
  ensureDir,
  isOwnedRunAlive,
  nowIso,
  ownedProcessExitPayload,
  pathExists,
} from './helpers';
import { stageMissingCliRun } from './missing-cli';
import { createModelCompatibilityRecovery } from './model-compatibility';
import { prependOwnedRun } from './run-ledger';
import { probeOwnedRunMarker, resolveSpawnedProcessGroupId } from './run-process-proof';
import { assertOwnedWorkspaceSpawnAvailable, type OwnedWorkspaceSpawnGuard } from './workspace-spawn-guard';
import {
  prepareWorkerSandbox,
  SandboxUnavailableError,
  workerSandboxEnabled,
} from './sandbox';
import { resolveReadOnlySandboxPlan } from './work-mode';
import { preparedRuntimeStateSandboxPolicy } from './runtime-state-sandbox';
import type { OwnedSessionIo } from './session-io';
import type {
  OwnedChildExitOutcome,
  OwnedRunMode,
  OwnedRunRecord,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
} from './types';
export interface OwnedRunController {
  readRunArtifacts(run: OwnedRunRecord, includeStdout?: boolean): Promise<{
    stdoutRaw: string;
    stderrRaw: string;
    parsed: ReturnType<OwnedRuntimeAdapter['parseRunLog']>;
  }>;
  readCostLine(run: OwnedRunRecord): Promise<string | undefined>;
  refreshSession(session: OwnedSessionRecord, surfaceLockHeld?: boolean, allowRetry?: boolean): Promise<OwnedSessionRecord>;
  reconcilePreparedRuns(session: OwnedSessionRecord): Promise<OwnedSessionRecord>;
  spawnOwnedRun(
    session: OwnedSessionRecord,
    prompt: string,
    mode: OwnedRunMode,
  ): Promise<OwnedRunRecord>;
}

export function createOwnedRunController({
  root,
  adapter,
  runtimeId,
  humanLabel,
  retryDelayMs,
  stderrNoise,
  io,
  withSurfaceLock,
  workspaceSpawnGuard,
  invalidateFleetCache,
}: {
  root: string;
  adapter: OwnedRuntimeAdapter;
  runtimeId: string;
  humanLabel: string;
  retryDelayMs: number;
  stderrNoise: RegExp[];
  io: OwnedSessionIo;
  withSurfaceLock: <T>(surfaceId: string, fn: () => Promise<T>) => Promise<T>;
  workspaceSpawnGuard: OwnedWorkspaceSpawnGuard;
  invalidateFleetCache: () => void;
}): OwnedRunController {
  const capacityRecovery = createCapacityRecovery({ adapter, io, spawnOwnedRun });
  const readRunArtifacts = createRunArtifactReader(adapter, detectRunSandboxDenial);
  const handleWorkerFailure = createWorkerFailureHandler({ adapter, io, readRunArtifacts, park: capacityRecovery.park });
  const recoverModelCompatibility = createModelCompatibilityRecovery({ adapter, io, withSurfaceLock, readRunArtifacts, spawnOwnedRun });
  const scheduleFailureRetry = createFailureRetry({ adapter, io, withSurfaceLock, readRunArtifacts, spawnOwnedRun,
    notify: (session, from, to, reason) => emitRuntimeFallbackNotification(runtimeId, session, from, to, reason), invalidateFleetCache, retryDelayMs });
  function recordSandboxDenialEvent(
    laneId: string,
    surfaceId: string,
    runId: string,
    denial: NonNullable<OwnedRunRecord['sandboxDenial']>,
  ): void {
    const message = sandboxDenialOperatorMessage(runtimeId, denial);
    recordLaneEvent(laneId, 'sandbox_denied', 'system', {
      runtime: runtimeId,
      surfaceId,
      runId,
      operation: denial.operation,
      resource: denial.resource,
      denialLine: denial.line,
      message,
    });
  }

  function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  async function readOwnedRunStdout(run: OwnedRunRecord): Promise<string> {
    const [stdoutRaw, stderrRaw] = await Promise.all([
      pathExists(run.stdoutPath).then((exists) => (exists ? readFile(run.stdoutPath, 'utf8').catch(() => '') : '')),
      pathExists(run.stderrPath).then((exists) => (exists ? readFile(run.stderrPath, 'utf8').catch(() => '') : '')),
    ]);
    return `${stdoutRaw}\n${stderrRaw}`;
  }

  async function readCostLine(run: OwnedRunRecord): Promise<string | undefined> {
    const raw = await readOwnedRunStdout(run).catch(() => '');
    return raw.split(/\r?\n/)
      .reverse()
      .map((line) => line.trim())
      .find((line) => /\$\d+(?:\.\d+)?/.test(line) || /\bcost\b/i.test(line));
  }

  async function recordDetachedChildExit(
    surfaceId: string,
    runId: string,
    stderrPath: string,
    outcome: OwnedChildExitOutcome,
  ) {
    revokeControlledGateway(surfaceId);
    const stderrTail = await readAbnormalStderrTail(stderrPath, outcome);
    const childExit = stderrTail ? { ...outcome, stderrTail } : outcome;

    let finishedClean = false;
    let exitedRun: OwnedRunRecord | null = null;
    let laneId: string | undefined;
    let sandboxDenial: OwnedRunRecord['sandboxDenial'];
    let artifacts: Awaited<ReturnType<typeof readRunArtifacts>> | null = null;
    await withSurfaceLock(surfaceId, async () => {
      const current = await io.findSession(surfaceId) ?? await io.findArchivedSession(surfaceId);
      if (!current) return;
      laneId = current.laneId;
      const currentRun = current.recentRuns.find((run) => run.id === runId);
      artifacts = currentRun ? await readRunArtifacts({ ...currentRun, childExit }).catch(() => null) : null;
      if (current.recentRuns[0]?.id === runId && artifacts?.parsed.providerFailure?.subtype === 'stdin_delivery_failed' && artifacts.parsed.providerFailure.message) {
        current.latestSummary = artifacts.parsed.providerFailure.message;
      }
      // A worker that exits 0 without writing a byte did no work (for example
      // a CLI that ignored its input). Surface that instead of a silent success
      // unless the runtime's own parser recognized a completed turn.
      const silentCleanExit = Boolean(artifacts) && childExit.classification === 'clean-exit'
        && !artifacts!.parsed.completedTurn
        && !currentRun?.interruptRequestedAt && currentRun?.outcome !== 'interrupted'
        && !artifacts!.stdoutRaw.trim() && !artifacts!.stderrRaw.trim();
      if (silentCleanExit) {
        const message = silentCleanExitMessage(humanLabel);
        artifacts = { ...artifacts!, parsed: { ...artifacts!.parsed, outcome: 'failed', completedTurn: false,
          providerFailure: { subtype: 'empty_output', message } } };
        current.latestSummary = message;
      }
      let dirty = false;
      const finishedAt = nowIso();
      const applyExit = (run: OwnedRunRecord): OwnedRunRecord => {
        if (run.id !== runId) return run;
        dirty = true;
        const nextOutcome = run.outcome === 'interrupted' || run.interruptRequestedAt
          ? 'interrupted'
          : artifacts?.parsed.outcome === 'failed'
            ? 'failed'
          : childExit.classification === 'clean-exit'
            ? 'finished'
            : 'failed';
        if (nextOutcome === 'finished') finishedClean = true;
        const nextRun: OwnedRunRecord = {
          ...run,
          childExit,
          finishedAt: run.finishedAt ?? finishedAt,
          outcome: nextOutcome,
        };
        if (run.sandboxed && childExit.classification !== 'clean-exit') {
          sandboxDenial = detectSandboxDenial(childExit.stderrTail ?? '') ?? undefined;
          if (sandboxDenial) {
            nextRun.sandboxDenial = sandboxDenial;
            current.latestSummary = sandboxDenialOperatorMessage(runtimeId, sandboxDenial);
          }
        }
        exitedRun = nextRun;
        return nextRun;
      };

      current.recentRuns = current.recentRuns.map(applyExit);
      if (current.activeRun?.id === runId) {
        current.activeRun = undefined;
        dirty = true;
      }
      if (finishedClean) current.capacityResumeCount = 0;
      if (!current.threadId && artifacts?.parsed.threadId) current.threadId = artifacts.parsed.threadId;
      if (dirty) await io.saveSession(current);
      await cleanupWorkerO8Cli(root, current, runId).catch(() => {});
    });
    invalidateFleetCache();

    const recordedRun = exitedRun as OwnedRunRecord | null;
    const recoverySession = !finishedClean && adapter.modelCompatibilityFallback ? await io.findSession(surfaceId) : null;
    const recovered = recoverySession ? await recoverModelCompatibility(recoverySession) : false;
    const recordedArtifacts = artifacts as Awaited<ReturnType<typeof readRunArtifacts>> | null;
    if (laneId && recordedRun) {
      const stderr = compactText(recordedArtifacts?.stderrRaw || childExit.stderrTail || '', 4_000);
      try {
        recordLaneEvent(laneId, 'runtime_process_exit', 'system', ownedProcessExitPayload(
          runtimeId, surfaceId, recordedRun, childExit, recordedArtifacts?.parsed, stderr,
        ));
      } catch (error) {
        console.warn(`[owned-store] Failed to record runtime_process_exit for lane ${laneId}:`, error);
      }
      if (sandboxDenial) {
        try {
          recordSandboxDenialEvent(laneId, surfaceId, runId, sandboxDenial);
        } catch (error) {
          console.warn(`[owned-store] Failed to record sandbox_denied for lane ${laneId}:`, error);
        }
      } else if (recordedRun.outcome === 'failed' && !recovered) {
        try {
          await withSurfaceLock(surfaceId, () => handleWorkerFailure(surfaceId, runId));
        } catch (error) {
          console.error(`[owned-store] Worker quota fallback handling failed for lane ${laneId}:`, error);
        }
      }
    }

    if (finishedClean) {
      void notifySupervisorOfCleanExit(surfaceId, runId);
    }
  }

  async function reconcilePreparedRuns(session: OwnedSessionRecord): Promise<OwnedSessionRecord> {
    let dirty = false;
    for (let index = 0; index < session.recentRuns.length; index += 1) {
      const run = session.recentRuns[index];
      if (!run || run.spawnState !== 'prepared') continue;
      if (run.supervisor) continue; // Only the authenticated daemon can reconcile uncertain submissions.
      const markerState = await probeOwnedRunMarker(run.processMarker);
      if (markerState !== 'clear') continue;
      const reconciled: OwnedRunRecord = {
        ...run,
        spawnState: 'reconciled_clear',
        outcome: 'failed',
        finishedAt: run.finishedAt ?? nowIso(),
      };
      session.recentRuns[index] = reconciled;
      if (session.activeRun?.id === run.id) session.activeRun = undefined;
      dirty = true;
    }
    if (dirty) await io.saveSession(session);
    return session;
  }

  async function refreshSession(session: OwnedSessionRecord, surfaceLockHeld = false, allowRetry = true) {
    const supervisedDirty = await reconcileSupervisedSession(session);
    await assertOwnedSessionProcessIdentity(session, runtimeId);
    let dirty = supervisedDirty;

    for (const run of session.recentRuns) {
      // A prepared journal is deliberately preserved until the binding path,
      // under the same surface lock as spawn, reconciles its durable marker.
      if (run.spawnState === 'prepared') continue;
      const { stderrRaw, parsed, sandboxDenial } = await readRunArtifacts(run, false, false);

      if (!session.threadId && parsed.threadId) {
        session.threadId = parsed.threadId;
        dirty = true;
      }

      // A second liveness probe may observe exit after reconciliation saw a
      // live worker. Only the next immutable daemon receipt can finish it.
      if (run.supervisor && !run.childExit) continue;

      const runAlive = await isOwnedRunAlive(run);
      if (runAlive) {
        if (run.outcome !== 'running' && !run.interruptRequestedAt && run.outcome !== 'interrupted') {
          run.outcome = 'running';
          dirty = true;
        }
        continue;
      }

      if (run.sandboxed && !run.sandboxDenial) {
        const denial = sandboxDenial === undefined
          ? (await readRunArtifacts(run, false, false, true)).sandboxDenial
          : sandboxDenial;
        if (denial) {
          run.sandboxDenial = denial;
          session.latestSummary = sandboxDenialOperatorMessage(runtimeId, denial);
          dirty = true;
          if (session.laneId) {
            try {
              recordSandboxDenialEvent(session.laneId, session.surfaceId, run.id, denial);
            } catch (error) {
              console.warn(`[owned-store] Failed to record sandbox_denied for lane ${session.laneId}:`, error);
            }
          }
        }
      }

      const nextOutcome = deriveRunOutcome(run, parsed, stderrRaw, stderrNoise);
      if (session.recentRuns[0]?.id === run.id && parsed.providerFailure?.subtype === 'stdin_delivery_failed' && parsed.providerFailure.message && session.latestSummary !== parsed.providerFailure.message) {
        session.latestSummary = parsed.providerFailure.message;
        dirty = true;
      }
      if (run.outcome !== nextOutcome) {
        run.outcome = nextOutcome;
        dirty = true;
      }
      if (!run.finishedAt) {
        run.finishedAt = nowIso();
        dirty = true;
      }
    }

    if (session.activeRun
      && !session.activeRun.supervisor
      && session.activeRun.spawnState !== 'prepared'
      && !(await isOwnedRunAlive(session.activeRun))) {
      session.activeRun = undefined;
      dirty = true;
    }

    if (dirty) {
      await io.saveSession(session);
    }

    await cleanupWorkerO8Cli(root, session).catch(() => {});
    if (allowRetry && !session.activeRun && session.recentRuns[0]?.outcome === 'failed') {
      const handleFailure = async () => {
        await handleWorkerFailure(session.surfaceId, session.recentRuns[0].id);
        const current = await io.findSession(session.surfaceId);
        if (current) Object.assign(session, current);
      };
      if (surfaceLockHeld) await handleFailure();
      else await withSurfaceLock(session.surfaceId, handleFailure);
    }
    if (session.capacityWait || session.capacityResumeClaim) {
      if (allowRetry) {
        if (surfaceLockHeld) await capacityRecovery.refresh(session);
        else await withSurfaceLock(session.surfaceId, async () => {
          const current = await io.findSession(session.surfaceId);
          if (current) { await capacityRecovery.refresh(current); Object.assign(session, current); }
        });
      }
      return session;
    }
    if (allowRetry && await recoverModelCompatibility(session, surfaceLockHeld)) return session;
    if (allowRetry) scheduleFailureRetry(session);

    return session;
  }

  async function spawnOwnedRun(session: OwnedSessionRecord, prompt: string, mode: OwnedRunMode) {
    return withOwnedArtifactAdmission(root, () => (
      withPacketLifecycleSpawnLock(session.packetId ?? session.workspaceBinding?.packetId ?? null, () => (
        spawnOwnedRunInner(session, prompt, mode)
      ))
    ));
  }

  async function spawnOwnedRunInner(session: OwnedSessionRecord, prompt: string, mode: OwnedRunMode) {
    assertRuntimeEffortPin(runtimeId, session.model, session.effort);
    assertOwnedSingleAttemptSpawn(session, runtimeId, mode);
    await runtimeLaunchStep(session, 'run_directory', () => ensureDir(path.join(session.sessionDir, RUNS_DIR)));

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const stdoutPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.jsonl`);
    const stderrPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.stderr.log`);

    let binary: string;
    try {
      binary = (await runtimeLaunchStep(session, 'binary_resolution', () => runtimeLaunchRead(() => resolveCli({
        runtimeId,
        binaryName: adapter.binaryName,
        envOverride: adapter.binaryEnvOverride,
        extraEnvOverrides: adapter.binaryExtraEnvOverrides,
      })))).path;
    } catch (error) {
      if (!(error instanceof CliNotFoundError)) {
        if (hasRuntimeLaunchDeadline() || session.executionPolicy !== undefined) throw error;
        console.error(`[owned-session] ${runtimeId} CLI resolution failed, falling back to bare "${adapter.binaryName}":`, error);
        binary = adapter.binaryName;
      } else {
        const run = await stageMissingCliRun({
          runtimeId,
          binaryName: adapter.binaryName,
          humanLabel,
          envOverride: adapter.binaryEnvOverride,
          triedPaths: error.triedPaths,
          session,
          runId,
          mode,
          prompt,
          stdoutPath,
          stderrPath,
          finishedAt: nowIso(),
        });
        await io.saveSession(session);
        return run;
      }
    }

    // A read-only packet FORCES the sandbox: `O8_WORKER_SANDBOX` is an opt-in
    // for normal packets and defaults off. See resolveReadOnlySandboxPlan.
    const readOnlySandbox = resolveReadOnlySandboxPlan(session);
    const sandboxEnabled = workerSandboxEnabled() || readOnlySandbox.enforced;
    const credentialPolicy = credentialPolicyFingerprint(runtimeId);
    let preparedLaunch;
    try {
      preparedLaunch = await runtimeLaunchStep(session, 'launch_arguments', () => prepareOwnedLaunchArgs({
        adapter,
        session,
        runId,
        prompt,
        mode,
        sandboxEnabled,
        humanLabel,
        artifactRoot: root,
      }));
    } catch (error) {
      if (!(error instanceof WorkerO8CliUnavailableError)) throw error;
      const held = await stageOwnedLaunchFailure({ session, runId, mode, prompt, stdoutPath, stderrPath, message: error.message });
      await io.saveSession(session);
      return held;
    }
    const { args, stdinPayload, workerMcp, workerO8BinDir, workerO8ReadPaths } = preparedLaunch;
    // Prepare the exact isolated config root before Seatbelt is built.
    const { adapterEnv, runtimeState, carrierLaunch } = await (async () => {
      const adapterEnv: Record<string, string> = adapter.extraSpawnEnv
        ? await runtimeLaunchStep(session, 'runtime_environment', () => adapter.extraSpawnEnv!(session))
        : {};
      const runtimeState = preparedRuntimeStateSandboxPolicy(adapter, session, adapterEnv);

      const carrierLaunch = await runtimeLaunchStep(session, 'execution_carrier', () => resolveExecutionCarrierInvocation({ runtime: runtimeId as OrchestratorRuntime, runtimeConfig: session.runtimeConfig, runtimeBinary: binary, runtimeArgs: args }));
      return { adapterEnv, runtimeState, carrierLaunch };
    })().catch(async error => { await preparedLaunch.workerO8?.cleanupUnstarted(true).catch(() => {}); throw error; });
    let spawnBinary = carrierLaunch.command;
    let spawnArgs = carrierLaunch.args;
    const sandboxEnvExtra: Record<string, string> = {};
    if (sandboxEnabled) {
      try {
        const controlledSandbox = controlledProviderSandbox(session, spawnBinary);
        const prepared = await runtimeLaunchStep(session, 'sandbox_preparation', () => prepareWorkerSandbox({
          ...controlledSandbox,
          runId,
          profileDir: path.join(session.sessionDir, RUNS_DIR),
          cwd: session.repoPath,
          repoPath: session.repoPath,
          binary: spawnBinary,
          args: spawnArgs,
          extraReadPaths: executionCarrierSandboxReadPaths(workerMcp.sandboxReadPaths, carrierLaunch),
          readBackingProjectConfig: runtimeId === 'codex',
          readOwnerInstructions: !controlledSandbox,
          finalAllowReadPaths: [...(controlledSandbox?.finalAllowReadPaths ?? []), ...(workerMcp.configPath ? [workerMcp.configPath] : []), ...workerO8ReadPaths],
          // Read-only: repo stays readable, kernel refuses every write. Deny
          // paths come from the SAME git probe prepareWorkerSandbox uses to
          // grant access, and it throws if that probe resolves nothing.
          enforceReadOnly: readOnlySandbox.enforced,
          finalAllowReadWritePaths: runtimeState.writablePaths,
          finalImmutableWritePaths: [...(runtimeState.immutablePaths ?? []), ...(preparedLaunch.workerO8?.immutablePaths ?? [])],
          finalImmutableAncestorPaths: preparedLaunch.workerO8?.immutableAncestorPaths,
        }));
        spawnBinary = prepared.binary;
        spawnArgs = prepared.args;
        const { apiPort, wsPort } = resolvePortInfo();
        sandboxEnvExtra.O8_API_PORT = String(apiPort);
        sandboxEnvExtra.O8_WS_PORT = String(wsPort);
      } catch (error) {
        await preparedLaunch.workerO8?.cleanupUnstarted(true);
        const why = readOnlySandbox.enforced
          ? 'this is a read-only packet, which requires an OS-enforced sandbox'
          : 'worker sandbox is enabled (O8_WORKER_SANDBOX)';
        const message = error instanceof SandboxUnavailableError
          ? `${humanLabel} dispatch refused: ${why} but it could not be provided — ${error.message}`
          : `${humanLabel} dispatch refused: worker sandbox preparation failed — ${(error as Error).message}`;
        console.error(`[owned-session] ${runtimeId} sandbox prep failed (fail-closed):`, error);
        const failedRun = await stageOwnedLaunchFailure({ session, runId, mode, prompt, stdoutPath, stderrPath, message });
        await io.saveSession(session);
        return failedRun;
      }
    }

    let pid = 0;
    let spawnSubmitted = false;
    let stdinPath: string | undefined;
    let terminalSessionName: string | undefined;
    let detachMode: 'bridge' | 'detached' = 'bridge';
    let detachedChild: ChildProcess | undefined;
    let supervised: SupervisorReceipt | undefined;
    const useSupervisor = processSupervisorEnabled(runtimeId) && session.executionPolicy === undefined && !carrierLaunch.carried;
    let runPersisted = false;
    let pendingDetachedExit: OwnedChildExitOutcome | undefined;

    const bridgeSessionName = tmuxSessionName(runtimeId, runId);
    const workerToken = session.executionPolicy !== undefined ? mintReadOnlyWorkerToken(runId) : session.packetId
      ? mintPacketWorkerToken(session.packetId, { processMarker: runId })
      : getOrCreateLocalWorkerToken();
    const spawnEnv = {
      ...adapterEnv,
      ...packetCargoEnvironment(session),
      // Some coding CLIs trust the inherited PWD instead of asking the OS for
      // the spawned process cwd. Keep both values aligned so a worker cannot
      // silently operate in the o8 server's own checkout.
      PWD: session.repoPath,
      PATH: [workerO8BinDir, executionCarrierSpawnPath(pathWithNodeRuntime(), carrierLaunch)].filter(Boolean).join(path.delimiter),
      NODE_ENV: 'development' as const,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // Workers must never pop an OS browser: dev servers (CRA, storybook)
      // auto-open via BROWSER, and `o8 run` mirrors this env into its pane
      // (report J4FHM2). 'none' is the CRA disable convention; tools that
      // treat BROWSER as a launch binary fail to exec it, same net effect.
      BROWSER: 'none',
      O8_WORKER_TOKEN: workerToken,
      O8_OWNED_RUN_MARKER: runId,
      ...(session.packetId ? { O8_WORKER_PACKET_ID: session.packetId } : {}),
      ...sandboxEnvExtra,
    };
    try {
      if (session.laneId) {
        await runtimeLaunchStep(session, 'backend_gate', () => ensureDispatchBackendReady(runtimeId, mode, { laneId: session.laneId!, packetId: session.packetId }));
      } else {
        await runtimeLaunchStep(session, 'backend_gate', () => ensureDispatchBackendReady(runtimeId, mode));
      }
      const durableSession = await runtimeLaunchStep(session, 'durable_session', () => io.findSession(session.surfaceId));
      assertOwnedActionAdmission(durableSession);
      assertDurableOwnedSpawn(durableSession, session, runtimeId, mode);
      Object.assign(session, durableSession);
      return await withControlledTaskSpawn(session, runtimeId, runId, async () => {
        const spawnDecision = await runtimeLaunchStep(session, 'workspace_spawn_guard', () => assertOwnedWorkspaceSpawnAvailable({
          surfaceId: session.surfaceId, sessionPacketId: session.packetId ?? null, laneId: session.laneId ?? null,
          runtimeId, mode, binding: session.workspaceBinding ?? null, repoPath: session.repoPath,
        }, workspaceSpawnGuard));
        const materializationIdentity = spawnDecision.materializationIdentity ?? null;
        assertOwnedActionAdmission(await runtimeLaunchStep(session, 'spawn_session', () => io.findSession(session.surfaceId)));
        await runtimeLaunchStep(session, 'action_fence', async () => assertOwnedActionFence(session.surfaceId, await io.findSession(session.surfaceId)));
        const bridgeLaunch = guardedWorkspaceInvocation(spawnBinary, spawnArgs, materializationIdentity);
        const cliCmd = [bridgeLaunch.command, ...bridgeLaunch.args].map(quoteShellArg).join(' ');
        const shellCmd = `${stdinPayload ? `printf %s ${quoteShellArg(stdinPayload)} | ` : ''}${cliCmd} | tee '${stdoutPath}' 2>'${stderrPath}'`;

        const preparedRun: OwnedRunRecord = {
          id: runId,
          mode,
          prompt,
          startedAt: nowIso(),
          pid: 0,
          ...(useSupervisor ? { supervisor: { id: runId, owner: session.surfaceId, epoch: '', cursor: 0 } } : {}),
          processIdentityRequired: crashSurvivableWorkersEnabled() && Boolean(session.packetId) && process.platform !== 'win32',
          commandIdentity: process.platform === 'win32' && stdinPayload && !useSupervisor ? process.execPath : executionCarrierCommandIdentity(carrierLaunch, spawnBinary),
          processMarker: runId,
          spawnState: 'prepared',
          stdoutPath,
          stderrPath,
          outcome: 'running',
          sandboxed: sandboxEnabled,
        };
        session.latestPrompt = prompt;
        session.latestSummary = compactText(prompt, 140) || session.latestSummary;
        session.reviewDisposition = 'watching';
        session.reviewDispositionUpdatedAt = nowIso();
        session.activeRun = preparedRun;
        prependOwnedRun(session, preparedRun);
        await runtimeLaunchStep(session, 'prepared_journal', () => io.saveSession(session));

        try {
          assertOwnedActionAdmission(session, runId);
          assertLaunchCredentialPolicy(runtimeId, credentialPolicy);
          const bridgeEnv = ownedSpawnEnvironment(session, spawnEnv, true);
          const hasProviderCredentials = Object.entries(bridgeEnv).some(([name, value]) => value && providerCredentialName(name));
          // Credential-bearing launches require policy validation at OS spawn.
          if (!hasRuntimeLaunchDeadline() && !hasOwnedActionFence() && !useSupervisor && !hasProviderCredentials && !workerMcp.configPath && workerMcp.servers.length === 0 && process.platform !== 'win32' && session.executionPolicy === undefined && !carrierLaunch.carried && !crashSurvivableWorkersEnabled()) {
            try {
              preparedLaunch.workerO8?.assertCurrent();
              spawnSubmitted = true;
              const result = await spawnBridgeTerminalSession({
                sessionName: bridgeSessionName,
                shellCommand: shellCmd,
                cwd: session.repoPath,
                env: bridgeEnv,
                resolvedEnvironment: true,
                packetId: session.packetId ?? undefined,
                laneId: session.laneId ?? undefined,
              });
              terminalSessionName = result.sessionName;
              pid = typeof result.pid === 'number' ? result.pid : 0;
            } catch {
              // bridge spawn failed; fall through to detached spawn
            }
          }

          if (!terminalSessionName) {
            const stdoutFd = openSync(stdoutPath, 'a');
            const stderrFd = openSync(stderrPath, 'a');
            let stdinFd: number | undefined;
            try {
              if (stdinPayload) {
                stdinPath = `${stdoutPath}.stdin`;
                await writeFile(stdinPath, stdinPayload, { mode: 0o600, flag: 'wx' });
                stdinFd = openSync(stdinPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
                if (!fstatSync(stdinFd).isFile()) throw new Error('Owned worker input is not a regular file.');
              }
              const launchInput = {
                session, runtimeId, policy: credentialPolicy, runId,
                binary: spawnBinary, args: spawnArgs, env: spawnEnv,
                stdinFd, stdinPath, stdinBytes: stdinPayload ? Buffer.byteLength(stdinPayload) : undefined, stdoutFd, stderrFd, mcpConfigPath: workerMcp.configPath, mcpServers: workerMcp.servers,
                materializationIdentity,
                assertWorkerO8Current: preparedLaunch.workerO8?.assertCurrent,
                onSubmit: () => { spawnSubmitted = true; },
              };
              if (useSupervisor) {
                supervised = await runtimeLaunchStep(session, 'process_spawn', () => spawnCredentialCheckedSupervised({ ...launchInput, stdoutPath, stderrPath, stdinPath }));
                pid = supervised.pid;
                detachMode = 'detached';
              } else {
                const child = await runtimeLaunchStep(session, 'process_spawn', async () => spawnCredentialCheckedChild(launchInput));
                detachedChild = child;
                observeChildExit(child, (childExit) => {
                  if (!runPersisted) {
                    pendingDetachedExit = childExit;
                    return;
                  }
                  void recordDetachedChildExit(session.surfaceId, runId, stderrPath, childExit).catch((err) => {
                    console.warn(`[owned-store] ${runtimeId} child-exit recording failed for ${runId}:`, err);
                  });
                });
                child.unref();
                pid = child.pid ?? 0;
                detachMode = 'detached';
              }
            } finally {
              if (stdinFd !== undefined) closeSync(stdinFd);
              closeSync(stdoutFd);
              closeSync(stderrFd);
            }
          }
        } catch (error) {
          // A synchronous failure can still follow an ambiguous bridge response,
          // so settle only when the durable marker scan proves no process exists.
          await reconcilePreparedRuns(session);
          throw error;
        }

        const processGroupId = process.platform !== 'win32' && detachMode === 'detached' && pid > 0
          ? pid
          : await runtimeLaunchStep(session, 'process_group', () => resolveSpawnedProcessGroupId(pid));
        const run: OwnedRunRecord = {
          ...preparedRun,
          pid,
          processGroupId,
          spawnState: 'started',
          tmuxSession: terminalSessionName,
          detachMode,
          stdinPath,
          ...(supervised ? { supervisor: { id: runId, owner: session.surfaceId, epoch: supervised.epoch, cursor: 0 },
            processIdentity: supervised.identity, processIdentitySource: 'platform' as const, processIdentityRequired: true } : {}),
        };
        if (!supervised) await runtimeLaunchStep(session, 'process_identity', () => captureOwnedRunIdentity(session, runtimeId, run));

        if (session.packetId && session.executionPolicy === undefined) {
          try {
            bindPacketWorkerTokenProcess(workerToken, {
              pid,
              processGroupId,
              processMarker: runId,
            });
          } catch (error) {
            console.warn(
              `[owned-session] ${runtimeId} worker credential process binding failed closed for lease mutations: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        session.activeRun = run;
        session.recentRuns = session.recentRuns.map((candidate) => candidate.id === run.id ? run : candidate);
        await runtimeLaunchStep(session, 'started_journal', () => io.saveSession(session));
        runPersisted = true;
        if (detachedChild && pendingDetachedExit) {
          void recordDetachedChildExit(session.surfaceId, run.id, run.stderrPath, pendingDetachedExit).catch((err) => {
            console.warn(`[owned-store] ${runtimeId} child-exit recording failed for ${run.id}:`, err);
          });
        }
        await verifyStartedChildIdentity(() => runtimeLaunchStep(session, 'identity_proof',
          () => assertOwnedSessionProcessIdentity(session, runtimeId)), run, detachedChild, runPersisted);
        return run;
      });
    } catch (error) {
      if (session.executionPolicy !== undefined) revokeReadOnlyWorkerToken(runId);
      if (pid === 0) await preparedLaunch.workerO8?.cleanupUnstarted(!spawnSubmitted);
      if (error instanceof WorkerO8CliUnavailableError) {
        const held = await stageOwnedLaunchFailure({ session, runId, mode, prompt, stdoutPath, stderrPath, message: error.message });
        await io.saveSession(session);
        await cleanupWorkerO8Cli(root, session, runId).catch(() => {});
        return held;
      }
      throw error;
    }
  }

  return {
    readRunArtifacts,
    readCostLine,
    refreshSession,
    reconcilePreparedRuns,
    spawnOwnedRun,
  };
}
