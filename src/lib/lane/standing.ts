import { steerPacket } from '@/lib/orchestrator/operator-mission-service/steer';
import { drainQueuedPacketSteers, hasQueuedPacketSteers } from '@/lib/orchestrator/operator-mission-service/steer-queue';
import 'server-only';

import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import { runCompletionVerification } from '@/lib/supervisor/completion-verification';
import { randomUUID } from 'node:crypto';
import { getRuntime } from '@/lib/runtimes';
import { resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import { listOwnedSessionLifecycles } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { assertRuntimeDispatchable } from '@/lib/runtimes/shared/auth-detect';
import { resolveDefaultBranch } from '@/lib/repos/registry';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { THINKING_EFFORTS, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { createPacketReceiptForClosedPacket } from '@/lib/receipts/packet-receipt';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';
import { withStandingLaneMutation as exclusive } from './standing-lock';
import { dispatch } from './commands';
import { getLane, listLanes, setLaneStatus, updateLane } from './registry';
import { laneGit } from './lane-git';
import { resolvePacketCreationBase } from './packet-creation-base';
import { readStandingLane, saveStandingLane, holdStandingLane, type StandingLaneState, type StandingTask } from './standing-store';
import { settleStandingTaskProcesses } from './standing-settlement';
import { assertManagedWorkspaceMaterialization } from '@/lib/workspace/managed-materialization-identity';
import { readPinnedWorkspaceFile } from '@/lib/worktree/materialization-leaf-io';
import { MANAGED_WORKSPACE_SAFETY_SETTINGS, managedWorkspaceSafetyHooksContent, resolveManagedWorkspaceSafetyHookRuntime } from '@/lib/worktree/safety-hooks';

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function stateFor(laneId: string) {
  const lane = getLane(laneId);
  const state = readStandingLane(laneId);
  if (!lane || !state || state.removed) throw new Error('Standing lane not found.');
  return { lane, state };
}

export function standingLaneStatus(laneId: string) {
  const { lane, state } = stateFor(laneId);
  return { lane, ...state,
    currentTask: state.tasks.find(task => task.phase !== 'done' && task.phase !== 'queued') ?? null,
    queueDepth: state.tasks.filter(task => task.phase === 'queued').length };
}

export function listStandingLanes() {
  return listLanes().flatMap(lane => {
    const state = readStandingLane(lane.id);
    return state && !state.removed ? [standingLaneStatus(lane.id)] : [];
  });
}

export async function createStandingLane(input: Record<string, unknown>) {
  const repoPath = required(input.repoPath, 'repoPath');
  const runtimeId = required(input.runtime, 'runtime');
  const model = required(input.model, 'model');
  const effort = required(input.effort, 'effort') as ThinkingEffort;
  if (!THINKING_EFFORTS.includes(effort)) throw new Error('Unknown reasoning effort.');
  const runtime = getRuntime(runtimeId);
  if (!runtime?.capabilities.launch || !runtime.capabilities.resume || !runtime.capabilities.readTranscript) {
    throw new Error('Standing lanes require a runtime with durable resume and transcript support.');
  }
  if (!listOwnedSessionLifecycles().some(entry => entry.runtimeId === runtimeId && entry.detachedPacketIdentity)) {
    throw new Error('This runtime does not support standing packet session bindings.');
  }
  const effortPin = resolveEffortPin({ requestedEffort: effort, runtime: runtimeId as OrchestratorRuntime, model, explicitModel: model });
  if (!effortPin.ok) throw new Error(effortPin.message);
  await assertRuntimeDispatchable(runtimeId as OrchestratorRuntime, model, repoPath);
  const baseBranch = await resolveDefaultBranch(repoPath);
  const opened = await dispatch({ verb: 'open_lane', repoPath, runtime: runtimeId as OrchestratorRuntime,
    baseBranch, branch: `lane/${randomUUID()}`, label: typeof input.label === 'string' ? input.label : 'Standing worker' });
  if (!opened.ok) throw new Error(opened.note);
  saveStandingLane(opened.laneId, { model, effort, stopped: false, removed: false, blockedReason: null, tasks: [] });
  return standingLaneStatus(opened.laneId);
}

async function clean(laneId: string, handoff = true): Promise<void> {
  const { lane } = stateFor(laneId);
  if (!lane.worktreePath) return;
  const flags = await laneGit(lane.worktreePath, lane.repoPath, ['ls-files', '-v', '-z']);
  if (flags.stdout.split('\0').some(entry => entry[0] === 'S' || /^[a-z]/.test(entry))) {
    throw new Error('Tracked index flags can hide uncommitted edits; clear skip-worktree and assume-unchanged before checkout reuse.');
  }
  const status = await laneGit(lane.worktreePath, lane.repoPath, ['status', '--porcelain', '-z', '--untracked-files=all', ...(handoff ? ['--ignored=traditional'] : [])]);
  const entries = status.stdout.split('\0').filter(Boolean);
  const safetyEntry = `!! ${MANAGED_WORKSPACE_SAFETY_SETTINGS}`;
  if (entries.some(entry => entry !== safetyEntry)) throw new Error('Previous task left uncommitted or ignored files; commit or preserve them before sending another task.');
  if (entries.includes(safetyEntry)) {
    // The only ignored base file permitted is the exact manager-injected safety policy.
    // Task edits, extra local settings and dependency/cache artifacts never inherit this grant.
    const identity = await assertManagedWorkspaceMaterialization(lane.repoPath, lane.worktreePath);
    const expected = managedWorkspaceSafetyHooksContent(await resolveManagedWorkspaceSafetyHookRuntime());
    if (await readPinnedWorkspaceFile(lane.worktreePath, identity, MANAGED_WORKSPACE_SAFETY_SETTINGS) !== expected) {
      throw new Error('Previous task changed ignored runtime settings; preserve them before checkout reuse.');
    }
  }
}

async function persistPacket(laneId: string, task: StandingTask, phase: 'running' | 'done') {
  const { lane, state } = stateFor(laneId);
  await withLockedState(current => {
    let packet = current.packets.find(packet => packet.id === task.id);
    if (!packet) {
      packet = {
        id: task.id, title: task.prompt, summary: task.prompt, referenceLabel: task.id,
        workspaceTargetPath: lane.repoPath, branchTarget: task.branch, runtime: lane.runtime,
        model: state.model, launchContext: { source: 'mcp', presentation: 'split', repoContext: 'transient', caller: 'standing lane' }, dependencyLabels: [], dependencyPacketIds: [], queueState: 'held',
        holdIntent: 'operator', releaseState: 'pending', status: 'running', lane: null, review: null,
        standingLaneId: laneId,
      };
      current.packets.push(packet);
    }
    packet.status = phase === 'done' ? 'archived' : 'running';
    packet.lane = { tileId: laneId, tabId: laneId, laneId, sessionKey: lane.sessionKey,
      runtime: lane.runtime, model: state.model, repoPath: lane.repoPath, worktreePath: lane.worktreePath };
  });
}

function promptFor(task: StandingTask): string {
  return `Standing worker task ${task.id}. Keep this runtime session and its context.\n`
    + `Work only on branch ${task.branch}, based on ${task.baseCommit}. Commit your work and report verification.\n`
    + 'o8 will open the task pull request. Never merge, release, or publish a pull request yourself.\n\n' + task.prompt;
}

async function startNext(laneId: string, state: StandingLaneState): Promise<void> {
  if (readStandingLane(laneId)?.stopped || state.blockedReason) return;
  const task = state.tasks.find(task => task.phase === 'queued');
  if (!task) return;
  const { lane } = stateFor(laneId);
  if (lane.sessionKey && (await readOwnedSessionRecord(lane.sessionKey))?.activeRun) return;
  const authority = await resolvePacketCreationBase({ repoPath: lane.repoPath, packetId: task.id,
    branch: task.branch, baseBranch: lane.baseBranch, runtime: lane.runtime });
  if (readStandingLane(laneId)?.stopped) return;
  task.baseCommit = authority.baseCommit;
  task.phase = 'dispatching'; task.startedAt = new Date().toISOString();
  saveStandingLane(laneId, state);
  if (lane.worktreePath) {
    // No reset/clean: refuse dirty files and create an independent branch at the fetched base.
    await laneGit(lane.worktreePath, lane.repoPath, ['fetch', 'origin', lane.baseBranch]);
    await settleStandingTaskProcesses(laneId, state);
    await clean(laneId);
    if (readStandingLane(laneId)?.stopped) return;
    await laneGit(lane.worktreePath, lane.repoPath, ['checkout', '-b', task.branch, authority.baseCommit]);
  }
  updateLane(laneId, { branch: task.branch, packetId: task.id, prNumber: null, outcome: null });
  await persistPacket(laneId, task, 'running');
  if (readStandingLane(laneId)?.stopped) return;
  const result = await dispatch(lane.sessionKey
    ? { verb: 'send_turn', laneId, message: promptFor(task), actor: 'user' }
    : { verb: 'launch_session', laneId, prompt: promptFor(task), model: state.model,
      effort: state.effort, launchContext: { source: 'mcp', presentation: 'split', repoContext: 'transient', caller: 'standing lane' }, clientMutationId: `standing:${task.id}`, actor: 'user' });
  if (!result.ok) throw new Error(result.note);
  const attached = getLane(laneId)!;
  const record = attached.sessionKey ? await readOwnedSessionRecord(attached.sessionKey) : null;
  const run = record?.activeRun ?? record?.recentRuns[0];
  if (!run?.prompt.includes(`Standing worker task ${task.id}.`)) throw new Error('Task dispatch has no matching runtime run receipt.');
  task.runId = run.id;
  task.phase = 'running'; saveStandingLane(laneId, state);
  await persistPacket(laneId, task, 'running');

}

async function finishTask(laneId: string, state: StandingLaneState, task: StandingTask): Promise<void> {
  // Close managed-run admission durably before the packet settlement snapshot.
  task.phase = 'publishing'; saveStandingLane(laneId, state);
  await settleStandingTaskProcesses(laneId, state);
  await clean(laneId, false);
  const { lane } = stateFor(laneId);
  if (!lane.worktreePath) throw new Error('Task has no managed checkout.');
  task.commit = (await laneGit(lane.worktreePath, lane.repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
  if (task.commit === task.baseCommit) throw new Error('Task produced no commit; pull request requires committed work.');
  const verificationResult = await runCompletionVerification(lane.worktreePath, task.baseCommit!, lane.repoPath);
  if (!verificationResult.ok) throw new Error(`Task verification failed (${verificationResult.kind}): ${verificationResult.output}`);
  await clean(laneId, false);
  if ((await laneGit(lane.worktreePath, lane.repoPath, ['rev-parse', 'HEAD'])).stdout.trim() !== task.commit) {
    throw new Error('Task commit changed during verification; inspect before publication.');
  }
  task.phase = 'publishing'; saveStandingLane(laneId, state);
  if (readStandingLane(laneId)?.stopped) return;
  if (!lane.prNumber) {
    // Reconcile an interrupted publication by branch through the same GitHub CLI.
    const existing = await materializationAwareExecFile('gh', ['pr', 'list', '--head', task.branch, '--state', 'all', '--json', 'number,url,state,headRefName'], { cwd: lane.repoPath });
    const prs = JSON.parse(existing.stdout) as Array<{ number: number; url: string; state: string; headRefName: string }>;
    if (prs.length > 1 || (prs[0] && (prs[0].headRefName !== task.branch || prs[0].state !== 'OPEN'))) throw new Error('Task pull request is closed, merged or ambiguous; inspect before continuing.');
    if (prs[0]) updateLane(laneId, { prNumber: prs[0].number, outcome: 'pr_opened' });
  }
  if (readStandingLane(laneId)?.stopped) return;
  if (!getLane(laneId)?.prNumber) {
    const result = await dispatch({ verb: 'create_pr', laneId, actor: 'user' });
    if (!result.ok) throw new Error(result.note);
  }
  const published = getLane(laneId)!;
  if (!published.prNumber) throw new Error('Pull request number was not recorded.');
  task.prNumber = published.prNumber;
  await persistPacket(laneId, task, 'done');
  const verification = ['Runtime turn completed successfully', 'Worktree clean', 'Task commit differs from current base', 'Existing completion verification passed (typecheck when available and changed-file rule check)'];
  const receipt = await createPacketReceiptForClosedPacket({ packetId: task.id, laneId,
    disposition: { kind: 'pr_opened', branch: task.branch, commit: task.commit,
      prNumber: task.prNumber, verification, openedAt: new Date().toISOString() } });
  task.receiptId = receipt.receipt.receiptId;
  task.phase = 'done'; saveStandingLane(laneId, state);
  if (!readStandingLane(laneId)?.stopped) setLaneStatus(laneId, 'idle', 'system', 'standing_task_completed');
}

/** Called by normal completion and restart reconciliation; never invents a new session. */
export async function reconcileStandingLane(laneId: string) {
  return exclusive(laneId, async () => {
    const { lane, state } = stateFor(laneId);
    if (state.stopped || state.blockedReason) return standingLaneStatus(laneId);
    try {
      const task = state.tasks.find(task => !['queued', 'done'].includes(task.phase));
      if (task) {
        if (!lane.sessionKey) throw new Error('Task dispatch did not attach a durable session; review before retrying.');
        let session = await readOwnedSessionRecord(lane.sessionKey);
        let run: OwnedRunRecord | undefined;
        // Atomic metadata publication can invalidate one read. Recheck the whole proof,
        // never combine a newer header with an older run or replay an uncertain dispatch.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) session = await readOwnedSessionRecord(lane.sessionKey);
          if (session?.activeRun) {
            await getRuntime(lane.runtime)!.discoverSessions();
            session = await readOwnedSessionRecord(lane.sessionKey);
          }
          const candidate = task.runId
            ? [session?.activeRun, ...(session?.recentRuns ?? [])].find(entry => entry?.id === task.runId)
            : session?.activeRun ?? session?.recentRuns[0];
          const current = getLane(laneId);
          if (session?.surfaceId === lane.sessionKey && session.packetId === task.id
            && current?.sessionKey === lane.sessionKey && current.packetId === task.id && current.branch === task.branch
            && candidate?.prompt.includes(`Standing worker task ${task.id}.`)
            && (!task.runId || candidate.id === task.runId)
            && task.startedAt && candidate.startedAt >= task.startedAt) { run = candidate; break; }
        }
        if (!session || !run) {
          throw new Error('Task dispatch outcome is unconfirmed; previous runtime output cannot complete this task.');
        }
        if (session.activeRun || run.outcome === 'running') {
          if (!session.activeRun) await getRuntime(lane.runtime)!.discoverSessions();
          return standingLaneStatus(laneId);
        }
        if (hasQueuedPacketSteers(laneId)) {
          await drainQueuedPacketSteers(laneId);
          if (hasQueuedPacketSteers(laneId) || (await readOwnedSessionRecord(lane.sessionKey))?.activeRun) return standingLaneStatus(laneId);
        }
        task.runId = run.id;
        if (!run || run.outcome !== 'finished') throw new Error('Previous task did not finish successfully; lane needs operator attention.');
        await finishTask(laneId, state, task);
      }
      if (!readStandingLane(laneId)?.stopped) await startNext(laneId, state);
    } catch (error) {
      state.blockedReason = error instanceof Error ? error.message : 'Standing task failed.';
      saveStandingLane(laneId, state);
      if (!readStandingLane(laneId)?.stopped) setLaneStatus(laneId, 'awaiting_human', 'system', 'standing_task_blocked');
    }
    return standingLaneStatus(laneId);
  });
}

let reconciling = false;
export async function reconcileStandingLanes(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    for (const row of listStandingLanes()) {
      if (!row.stopped && !row.blockedReason) await reconcileStandingLane(row.lane.id);
    }
  } finally { reconciling = false; }
}

export async function standingLaneAction(action: string, input: Record<string, unknown>) {
  if (action === 'create') return createStandingLane(input);
  if (action === 'list') return { lanes: listStandingLanes() };
  const laneId = required(input.laneId, 'laneId');
  const { lane } = stateFor(laneId);
  if (action === 'status') return reconcileStandingLane(laneId);
  if (action === 'stop' || action === 'remove') {
    holdStandingLane(laneId); // Persist BEFORE waiting for a launch or interrupt.
    const result = await dispatch({ verb: 'stop', laneId, actor: 'user' });
    if (!result.ok) throw new Error(result.note);
    if (action === 'remove') await exclusive(laneId, async () => {
      const archived = await dispatch({ verb: 'archive', laneId, actor: 'user' });
      if (!archived.ok) throw new Error(archived.note);
      saveStandingLane(laneId, { ...readStandingLane(laneId)!, removed: true });
    });
    return action === 'remove' ? { removed: true, laneId } : standingLaneStatus(laneId);
  }
  if (action === 'transcript') return { transcript: lane.sessionKey
    ? await getRuntime(lane.runtime)!.readTranscript(lane.sessionKey, undefined, 200) : [] };
  if (action === 'steer') return exclusive(laneId, async () => {
    const { state } = stateFor(laneId);
    if (state.stopped) throw new Error('Standing lane is stopped.');
    const current = state.tasks.find(task => !['queued', 'done'].includes(task.phase));
    if (current) {
      const steer = await steerPacket({ packetId: current.id, message: required(input.message, 'message'), source: 'operator', clientMutationId: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined });
      return { ...standingLaneStatus(laneId), steer };
    }
    const result = await dispatch({ verb: 'send_turn', laneId, message: required(input.message, 'message'), actor: 'user' });
    if (!result.ok) throw new Error(result.note);
    return standingLaneStatus(laneId);
  });
  if (action !== 'send') throw new Error('Unknown standing lane action.');
  await exclusive(laneId, async () => {
    const { lane, state } = stateFor(laneId);
    if (state.stopped) throw new Error('Standing lane is stopped.');
    const current = state.tasks.find(task => !['done', 'queued'].includes(task.phase));
    const active = lane.sessionKey ? (await readOwnedSessionRecord(lane.sessionKey))?.activeRun : null;
    if (!current || !active) await clean(laneId);
    if (state.blockedReason && !/uncommitted/.test(state.blockedReason)) throw new Error(state.blockedReason);
    state.blockedReason = null;
    const id = `pkt-${randomUUID()}`;
    state.tasks.push({ id, prompt: required(input.task, 'task'), branch: `lane/${laneId}/${id}`, phase: 'queued' });
    saveStandingLane(laneId, state);
  });
  return reconcileStandingLane(laneId);
}
