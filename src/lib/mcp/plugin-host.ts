import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { PLUGIN_FOLLOW_UP_SCOPE, PLUGIN_READ_SCOPE, PLUGIN_PREPARE_TASK_SCOPE, PLUGIN_LAUNCH_TASK_SCOPE, type PluginPrincipal } from '@/lib/auth/plugin-token';
import { taskDraftValidationMessage } from '@/lib/mcp/task-draft-validation';
import { bindIdempotencyClientMutation, deriveIdempotencyKey, withIdempotency } from '@/lib/orchestrator/idempotency-store';
import { listMissionRegistryEntries, readMissionRegistryEntry } from '@/lib/orchestrator/mission-registry';
import { steerPacket } from '@/lib/orchestrator/operator-mission-service';
import { isPostEffectSteerFailure } from '@/lib/orchestrator/operator-mission-service/steer';
import { readOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { appendPluginAudit, type PluginAuditEntry } from './plugin-audit';
import { readPluginCompletion } from './plugin-result';
import { callTaskDraftTool } from './task-draft-host';
import { readTaskResult } from './task-result-host';
import { TaskDraftError } from './task-draft-contract';
import { controlHostedTaskExecution } from './task-execution-control';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 1200): string {
  return typeof value === 'string'
    ? value.replace(/```[\s\S]*?```/g, '[code omitted]').slice(0, max) : '';
}

function snapshot(mission: OrchestratorMissionState, packet: OrchestratorPacket) {
  return {
    missionId: mission.missionId, packetId: packet.id,
    project: mission.repoPath ? basename(mission.repoPath) : '',
    title: text(packet.title, 160), status: packet.status,
    summary: text(packet.completionSummary || packet.blockedReason || packet.summary),
    releaseState: packet.releaseState,
    needsOperator: packet.status === 'blocked' || packet.status === 'awaiting_review' || packet.status === 'failed',
  };
}

function missions(): OrchestratorMissionState[] {
  const stored = listMissionRegistryEntries({ includeArchived: false }).map((entry) => entry.mission);
  const current = readOrchestratorMissionState();
  return current.missionId
    ? [current, ...stored.filter((mission) => mission.missionId !== current.missionId)] : stored;
}

function selectedPacket(args: Record<string, unknown>) {
  const missionId = String(args.missionId);
  const current = readOrchestratorMissionState();
  const mission = current.missionId === missionId
    ? current : readMissionRegistryEntry(missionId, { includeArchived: true })?.mission;
  const packet = mission?.packets.find((candidate) => candidate.id === args.packetId);
  return mission && packet ? { mission, packet } : null;
}

function validArguments(tool: string, args: Record<string, unknown>): boolean {
  const required = tool === 'o8_attention' ? ['machineId'] : tool === 'o8_result'
    ? ['machineId', 'missionId', 'packetId'] : ['machineId', 'missionId', 'packetId', 'message', 'idempotencyKey'];
  if (tool === 'o8_attention' && args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^[0-9]{1,8}$/.test(args.cursor))) return false;
  return Object.keys(args).every((key) => required.includes(key) || (tool === 'o8_attention' && key === 'cursor')) && required.every((key) =>
    typeof args[key] === 'string' && Boolean((args[key] as string).trim())
    && (args[key] as string).length <= (key === 'message' ? 2000 : 256));
}

interface ToolReceipt { ok: boolean; code?: string; [key: string]: unknown }

async function followUp(principal: PluginPrincipal, args: Record<string, unknown>): Promise<ToolReceipt> {
  const selected = selectedPacket(args);
  if (!selected || selected.packet.archivedAt || selected.packet.status === 'archived'
    || selected.packet.releaseState === 'released' || selected.packet.operatorStopped) {
    return { ok: false, code: 'task_unavailable', message: 'Open o8 to choose or resume an active task.' };
  }
  const clientKey = `${principal.clientId}:${principal.machineId}:${args.idempotencyKey}`;
  const body = JSON.stringify({ missionId: args.missionId, packetId: args.packetId, message: args.message });
  const binding = bindIdempotencyClientMutation({ namespace: 'plugin_follow_up', clientKey, body });
  if (binding.status !== 'bound' && binding.status !== 'matched') {
    return { ok: false, code: binding.status === 'conflict' ? 'idempotency_key_conflict' : 'idempotency_store_unavailable' };
  }
  const key = deriveIdempotencyKey({ verb: 'plugin_follow_up', scopeId: String(args.packetId), clientKey, body });
  const receipt = await withIdempotency<ToolReceipt>({ key, verb: 'plugin_follow_up', scopeId: String(args.packetId) }, async () => {
    try {
      await steerPacket({
        packetId: String(args.packetId), message: String(args.message),
        source: 'plugin:chatgpt', clientMutationId: key,
      });
      return { ok: true, accepted: true, completed: false, packetId: args.packetId, message: 'Follow-up accepted. Check the task result for its outcome.' };
    } catch (error) {
      if (!isPostEffectSteerFailure(error)) throw error;
      return { ok: false, code: error.code, outcomeUnknown: error.phase === 'outcome_unknown', message: 'Inspect the task in o8 before sending another follow-up.' };
    }
  });
  return !receipt.inProgress && !receipt.unresolved ? { ...receipt.result, replayed: receipt.replayed }
    : { ok: false, code: 'follow_up_pending', message: 'The follow-up is pending. Check o8 and retry only with the same arguments and key.' };
}

/** Explicit capabilities only. This host never calls the unrestricted operator registry. */
export async function callPluginTool(principal: PluginPrincipal, payload: unknown): Promise<{
  status: number; result: ToolReceipt;
}> {
  const params = record(payload);
  const tool = typeof params?.name === 'string' ? params.name : '';
  const args = record(params?.arguments) ?? {};
  const audit: PluginAuditEntry = {
    at: new Date().toISOString(), actor: 'plugin', surface: 'chatgpt',
    clientId: principal.clientId, machineId: principal.machineId,
    callId: randomUUID(), tool: tool.slice(0, 100), phase: 'requested',
    argumentHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
  };
  if (typeof args.missionId === 'string') audit.missionId = args.missionId.slice(0, 256);
  if (typeof args.packetId === 'string') audit.packetId = args.packetId.slice(0, 256);
  if (typeof args.taskId === 'string') audit.taskId = args.taskId.slice(0, 36);
  try {
    // An audit failure refuses all tool execution, including a follow-up.
    appendPluginAudit(audit);
  } catch {
    return { status: 503, result: { ok: false, code: 'audit_unavailable' } };
  }
  let status = 200;
  let result: ToolReceipt;
  const draftTool = tool === 'o8_task_options' || tool === 'o8_prepare_task';
  const controlTool = tool === 'o8_launch_task' || tool === 'o8_stop_task';
  const known = controlTool || draftTool || ['o8_attention', 'o8_result', 'o8_task_result', 'o8_follow_up'].includes(tool);
  const requiredScope = controlTool ? PLUGIN_LAUNCH_TASK_SCOPE : draftTool ? PLUGIN_PREPARE_TASK_SCOPE
    : tool === 'o8_follow_up' ? PLUGIN_FOLLOW_UP_SCOPE : PLUGIN_READ_SCOPE;
  try {
    if (!known || !principal.scopes.includes(requiredScope) || args.machineId !== principal.machineId) {
      status = 403;
      result = { ok: false, code: 'forbidden', message: 'This connection cannot perform that action. Use o8 for operator decisions.' };
    } else if (controlTool) {
      result = await controlHostedTaskExecution(principal, args, tool === 'o8_launch_task' ? 'launch' : 'stop');
    } else if (draftTool) {
      result = await callTaskDraftTool(principal, tool, args) as ToolReceipt;
    } else if (tool === 'o8_task_result') {
      result = await readTaskResult(principal, args);
    } else if (!validArguments(tool, args)) {
      status = 400;
      result = { ok: false, code: 'invalid_arguments' };
    } else if (tool === 'o8_attention') {
      const all = missions().flatMap((mission) => mission.packets
        .filter((packet) => !packet.archivedAt && packet.status !== 'archived' && packet.releaseState !== 'released')
        .map((packet) => ({ ...snapshot(mission, packet), summary: text(packet.blockedReason || packet.summary, 160) })))
        .sort((left, right) => Number(right.needsOperator) - Number(left.needsOperator));
      const offset = Number(args.cursor ?? 0);
      result = { ok: true, tasks: all.slice(offset, offset + 20), totalTasks: all.length, nextCursor: offset + 20 < all.length ? String(offset + 20) : null };
    } else if (tool === 'o8_result') {
      const selected = selectedPacket(args);
      if (selected) {
        const completion = readPluginCompletion(selected.mission, selected.packet);
        result = { ok: true, task: { ...snapshot(selected.mission, selected.packet), completion,
          summary: completion.available ? completion.summary : 'Current worker result is unavailable. Check the task in o8.',
        } };
      } else result = { ok: false, code: 'task_not_found' };
    } else {
      result = await followUp(principal, args);
    }
  } catch (error) {
    status = error instanceof TaskDraftError ? error.status : 503;
    const validation = draftTool && error instanceof TaskDraftError && error.status === 400
      ? taskDraftValidationMessage(error.code) : undefined;
    const selectionRefused = tool === 'o8_task_options' && error instanceof TaskDraftError
      && (error.status === 400 || error.status === 409);
    result = { ok: false, code: error instanceof TaskDraftError ? error.code : 'task_unavailable',
      ...(selectionRefused ? { nextAction: 'ask_user', selectionRequired: true } : {}),
      message: selectionRefused
        ? 'The selected workspace was refused. Report the error and ask the user for direction. Do not try another registration without explicit user direction. No snapshot or task was prepared.'
        : validation ?? (draftTool ? 'The task draft is held or unavailable. This preparation request did not start or retry a worker. Retry only with the same arguments and key.'
        : controlTool ? 'Inspect the existing task attempt in o8 before continuing. A launch retry only inspects that attempt; it cannot create a replacement worker.'
          : 'Inspect the task in o8. Retry a follow-up only with the same arguments and key.') };
  }
  try {
    appendPluginAudit({ ...audit, at: new Date().toISOString(), phase: 'finished', outcome: result.ok ? 'success' : 'refused',
      ...(typeof result.taskId === 'string' ? { taskId: result.taskId } : {}) });
  } catch {
    return { status: 503, result: { ok: false, code: 'audit_outcome_unknown', outcomeUnknown: true } };
  }
  return { status, result };
}
