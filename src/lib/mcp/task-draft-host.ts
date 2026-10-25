import { CONTROLLED_OPENROUTER_MODEL, CONTROLLED_OPENROUTER_POLICY } from '@/lib/runtimes/shared/owned-session/controlled-provider';
import { PLUGIN_LAUNCH_TASK_SCOPE } from '@/lib/auth/plugin-token';
import { randomUUID } from 'node:crypto';
import type { PluginPrincipal } from '@/lib/auth/plugin-token';
import { CODEX_MODEL_IDS, SUPPORTED_MODEL_IDS } from '@/lib/models';
import { THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';
import { resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import { requireTaskDraftAccount, withTaskDraftAccountAdmission } from './task-draft-account';
import { canonical, exactKeys, normalizedText, object, parseTaskDraftContract, TaskDraftError } from './task-draft-contract';
import { contractHash, readTaskDraft, readTaskDraftSnapshot, taskDraftKey, withTaskDraftLock,
  writeTaskDraft, writeTaskDraftSnapshot, type TaskDraftRecord } from './task-draft-store';
import { captureTaskDraftWorkspace, taskDraftChoices, verifyFiles } from './task-draft-workspace';
import { readTaskExecution } from './task-execution-store';
import { pluginCatalogRevision } from './plugin-catalog';

async function catalog() {
  const { resolveClaudeCodeWorkerGatewayKey } = await import('@/lib/claude-code/worker-profile');
  const configured = !!await resolveClaudeCodeWorkerGatewayKey();
  return (['codex', 'claude-code'] as const).map((runtime) => ({
    runtime,
    models: [...(runtime === 'codex' ? CODEX_MODEL_IDS : SUPPORTED_MODEL_IDS.filter((model) => model.startsWith('claude-')))
      .map((model) => ({ model, efforts: THINKING_EFFORTS.filter((effort) => {
        const pin = resolveEffortPin({ runtime, model, explicitModel: model, requestedEffort: effort });
        return effort !== 'adaptive' && pin.ok && pin.selectedEffort === effort;
      }) })), ...(runtime === 'claude-code' ? [{ model: CONTROLLED_OPENROUTER_MODEL, efforts: ['provider-default'],
        provider: CONTROLLED_OPENROUTER_POLICY, configured, availability: 'catalog_only_not_execution_proof' }] : [])],
    availability: 'catalog_only_not_execution_proof',
  }));
}

function receipt(draft: TaskDraftRecord, replayed: boolean, principal: PluginPrincipal) {
  const prepared = {
    ok: true, accepted: true, executionEnabled: false,
    taskId: draft.taskId, contractHash: draft.contractHash, replayed, runtime: draft.contract.runtime,
    hostedLaunchPermission: !!draft.contract.provider && principal.scopes.includes(PLUGIN_LAUNCH_TASK_SCOPE),
    model: draft.contract.model, effort: draft.contract.effort, ...(draft.contract.provider ? { provider: draft.contract.provider } : {}), workMode: 'read-only',
  };
  let execution: ReturnType<typeof readTaskExecution>;
  try { execution = readTaskExecution(draft); }
  catch (error) {
    if (!(error instanceof TaskDraftError) || error.code !== 'execution_uncertain') throw error;
    return { ...prepared, state: 'uncertain', dispatched: null, completed: false,
      executionEvidence: 'unavailable', errorCode: 'execution_uncertain',
      message: 'Task draft exists, but its desktop execution receipt is unavailable or invalid. This preparation request did not start or retry a worker.' };
  }
  if (execution) {
    // Session identity is reserved before spawn. Only a confirmed running or
    // completed receipt proves dispatch; a reserved/uncertain run stays unknown.
    const dispatched = execution.runId
      ? execution.surfaceId && ['running', 'completed'].includes(execution.state) ? true : null
      : false;
    return { ...prepared, state: execution.state, attemptId: execution.attemptId,
      dispatched, completed: execution.state === 'completed',
      executionEvidence: 'persisted', errorCode: execution.errorCode ?? null,
      message: `Task draft exists. Persisted desktop execution state: ${execution.state}. This preparation request did not start or retry a worker.` };
  }
  return { ...prepared, state: 'held', dispatched: false, completed: false,
    message: prepared.hostedLaunchPermission
      ? 'Task draft prepared and held. No worker has started. An explicit user request may start this exact contract using the separately granted o8_launch_task tool, or review and Launch in o8.'
      : 'Task draft prepared and held. No worker has started. Operator review and a separate dispatch capability are required before execution.',
  };
}

export async function callTaskDraftTool(principal: PluginPrincipal, tool: string, input: unknown): Promise<Record<string, unknown>> {
  const account = await requireTaskDraftAccount(principal);
  const args = object(input);
  if (args.machineId !== principal.machineId) throw new TaskDraftError('forbidden', 403);
  if (tool === 'o8_task_options') {
    exactKeys(args, ['machineId'], ['repoId', 'projectId']);
    normalizedText(args.machineId);
    if (args.repoId === undefined && args.projectId === undefined) {
      const choices = await taskDraftChoices();
      await requireTaskDraftAccount(principal, account);
      return { ok: true, choices, selectionRequired: true, executionEnabled: false,
        nextAction: 'ask_user', clarification: { required: ['project', 'objective'],
          question: 'Which registered project do you mean, and what would you like checked?' },
        selectionGuidance: 'Use the repository and project labels to ask which workspace the user means. Mentioning the o8 app does not select a repository named o8. Keep routing IDs internal. Ask for the current objective before selecting a workspace.' };
    }
    const repoId = normalizedText(args.repoId);
    const projectId = normalizedText(args.projectId);
    const workspace = await captureTaskDraftWorkspace(repoId, projectId);
    await requireTaskDraftAccount(principal, account);
    const runtimes = await catalog();
    const snapshot = { ...workspace, ...account, snapshotId: randomUUID(),
      machineId: principal.machineId, clientId: principal.clientId, expiresAt: Date.now() + 300_000,
      catalogRevision: pluginCatalogRevision() };
    return withTaskDraftAccountAdmission(principal, account, () => {
      writeTaskDraftSnapshot(snapshot);
      return { ok: true, repoId, projectId, snapshotId: snapshot.snapshotId, revision: snapshot.revision,
      rulesDigest: snapshot.rulesDigest, expiresAt: snapshot.expiresAt,
      workMode: 'read-only', executionEnabled: false, runtimes };
    });
  }
  if (tool !== 'o8_prepare_task') throw new TaskDraftError('forbidden', 403);
  const contract = parseTaskDraftContract(args);
  const key = taskDraftKey(account.accountId, principal.clientId, principal.machineId, contract.idempotencyKey);
  async function replay(previous: TaskDraftRecord) {
    if (previous.contractHash !== contractHash(contract)) throw new TaskDraftError('idempotency_key_conflict', 409);
    return withTaskDraftAccountAdmission(principal, previous.account, () => receipt(previous, true, principal));
  }
  // An atomic immutable record can be recovered even if its creator crashed
  // after publication while holding the lock. A lock without a record stays held.
  const durable = readTaskDraft(key);
  if (durable) return replay(durable);
  return withTaskDraftLock(key, async () => {
    await requireTaskDraftAccount(principal, account);
    const previous = readTaskDraft(key);
    if (previous) {
      // Permanent binding checked before expiring snapshots; account checks precede disclosure.
      return replay(previous);
    }
    const snapshot = readTaskDraftSnapshot(contract.snapshotId);
    if (snapshot.accountId !== account.accountId || snapshot.epoch !== account.epoch
      || snapshot.clientId !== principal.clientId || snapshot.machineId !== principal.machineId
      || snapshot.repoId !== contract.repoId || snapshot.projectId !== contract.projectId
      || snapshot.catalogRevision !== pluginCatalogRevision()
      || snapshot.expiresAt <= Date.now()) throw new TaskDraftError('snapshot_unavailable', 409);
    const fresh = await captureTaskDraftWorkspace(contract.repoId, contract.projectId);
    if (canonical(fresh) !== canonical({ repoId: snapshot.repoId, projectId: snapshot.projectId,
      repoPath: snapshot.repoPath, revision: snapshot.revision, rulesDigest: snapshot.rulesDigest })) {
      throw new TaskDraftError('snapshot_stale', 409);
    }
    try { verifyFiles(fresh.repoPath, contract.allowedFiles); }
    catch { throw new TaskDraftError('invalid_file_scope'); }
    await requireTaskDraftAccount(principal, account);
    const draft: TaskDraftRecord = {
      version: 1, taskId: randomUUID(), state: 'held', executionEnabled: false,
      createdAt: new Date().toISOString(), account, clientId: principal.clientId, snapshot,
      contract, contractHash: contractHash(contract),
      policy: { automaticDispatch: false, workMode: 'read-only', packetCount: 1, maxAttempts: 1, fallback: false, executionCarrier: null },
    };
    return withTaskDraftAccountAdmission(principal, account, () => {
      writeTaskDraft(key, draft);
      return receipt(draft, false, principal);
    });
  });
}
