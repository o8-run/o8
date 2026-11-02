export const AGENT_CONTROL_RESULT_SCHEMA = 'o8/agent-control.result/v1' as const;
export const AGENT_CONTROL_TARGET_SCHEMA = 'o8/agent-control.target/v1' as const;

export interface AgentControlAttachment {
  type?: string;
  mimeType: string;
  fileName: string;
  content: string;
}

export type AgentControlSteerSource = 'operator' | 'orchestrator' | 'heal-bot';

export type SessionControlRef = { kind: 'session'; id: string };
export type LaneControlRef = { kind: 'lane'; id: string };
export type PacketControlRef = { kind: 'packet'; id: string };
export type AgentControlRef = SessionControlRef | LaneControlRef | PacketControlRef;

export interface WorkerRecovery {
  actions: Array<'resume' | 'retire'>;
  worktreePath: string;
  branch: string | null;
  runId: string | null;
  retired: boolean;
}

export type SessionControlAction =
  | {
      kind: 'send';
      message: string;
      runId?: string;
      automaticRecoveryRunId?: string;
      attachments?: AgentControlAttachment[];
      auditSteer?: boolean;
      steerSource?: AgentControlSteerSource;
    }
  | { kind: 'interrupt'; runId?: string }
  | { kind: 'resume' }
  | { kind: 'retry' }
  | { kind: 'retire' }
  | { kind: 'watch' }
  | { kind: 'resolve' };

export type LaneControlAction =
  | { kind: 'send_turn'; message: string }
  | { kind: 'interrupt' }
  | { kind: 'hold' };

export type PacketControlAction =
  | { kind: 'steer'; message: string; source?: string }
  | { kind: 'reset'; reason?: string }
  | { kind: 'retry'; reason?: string }
  | { kind: 'rerun'; feedback: string }
  | { kind: 'terminate' }
  | { kind: 'merge'; commitMessage?: string; expectedHeadSha?: string };

export type AgentControlRequest =
  | { ref: SessionControlRef; action: SessionControlAction; clientMutationId?: string }
  | { ref: LaneControlRef; action: LaneControlAction; clientMutationId?: string }
  | { ref: PacketControlRef; action: PacketControlAction; clientMutationId?: string };

export type AgentControlStatus =
  | 'queued'
  | 'completed'
  | 'unavailable'
  | 'held'
  | 'pending_approval';

export type AgentControlApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'unknown';

/**
 * One correlation target for every control surface. The request ref records
 * what the operator acted on; canonicalRef records the strongest persisted
 * identity that connects the runtime session to its lane and packet.
 */
export interface AgentControlTarget {
  schema: typeof AGENT_CONTROL_TARGET_SCHEMA;
  canonicalRef: AgentControlRef;
  resolution: 'persisted' | 'runtime' | 'request';
  runtime: string | null;
  surfaceId: string | null;
  sessionKey: string | null;
  projectId: string | null;
  repoPath: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  laneId: string | null;
  laneStatus: string | null;
  packetId: string | null;
  packetStatus: string | null;
  approval: {
    id: string | null;
    status: AgentControlApprovalStatus;
  };
}

export interface AgentControlResult {
  schema: typeof AGENT_CONTROL_RESULT_SCHEMA;
  ok: boolean;
  ref: AgentControlRef;
  action: AgentControlRequest['action']['kind'];
  clientMutationId?: string;
  status: AgentControlStatus;
  note: string;
  target: AgentControlTarget;
  runtime?: string;
  surfaceId?: string;
  sessionKey?: string;
  laneId?: string;
  packetId?: string;
  runId?: string;
  aborted?: boolean;
  retryable?: boolean;
  reason?: string;
  approvalId?: string;
  mergeSha?: string;
}

type ParseResult =
  | { ok: true; value: AgentControlRequest }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  return optionalString(record, key) ?? null;
}

function parseAttachments(value: unknown): { ok: true; value?: AgentControlAttachment[] } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false };
  const attachments: AgentControlAttachment[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) return { ok: false };
    const mimeType = requiredString(record, 'mimeType');
    const fileName = requiredString(record, 'fileName');
    const content = requiredString(record, 'content');
    const type = record.type === undefined ? undefined : optionalString(record, 'type');
    if (!mimeType || !fileName || !content || (record.type !== undefined && !type)) return { ok: false };
    attachments.push({ type, mimeType, fileName, content });
  }
  return { ok: true, value: attachments };
}

export function parseAgentControlRequest(value: unknown): ParseResult {
  const record = asRecord(value);
  const refRecord = asRecord(record?.ref);
  const actionRecord = asRecord(record?.action);
  const refKind = refRecord?.kind;
  const refId = refRecord ? requiredString(refRecord, 'id') : null;
  const actionKind = actionRecord?.kind;
  const clientMutationId = record ? optionalString(record, 'clientMutationId') : undefined;

  if (!record || !refRecord || !actionRecord) {
    return { ok: false, error: 'ref and action objects are required.' };
  }
  if ((refKind !== 'session' && refKind !== 'lane' && refKind !== 'packet') || !refId) {
    return { ok: false, error: 'ref.kind must be session, lane, or packet and ref.id is required.' };
  }
  if (typeof actionKind !== 'string') {
    return { ok: false, error: 'action.kind is required.' };
  }

  if (refKind === 'session') {
    if (actionKind === 'resume' || actionKind === 'retry' || actionKind === 'retire') {
      return { ok: true, value: { ref: { kind: 'session', id: refId }, action: { kind: actionKind }, clientMutationId } };
    }
    if (actionKind === 'send') {
      const message = requiredString(actionRecord, 'message');
      if (!message) return { ok: false, error: 'message is required for session send.' };
      const steerSource = actionRecord.steerSource;
      if (steerSource !== undefined && steerSource !== 'operator' && steerSource !== 'orchestrator' && steerSource !== 'heal-bot') {
        return { ok: false, error: 'steerSource must be operator, orchestrator, or heal-bot.' };
      }
      if (actionRecord.automaticRecoveryRunId !== undefined && (typeof actionRecord.automaticRecoveryRunId !== 'string'
        || !actionRecord.automaticRecoveryRunId.trim())) {
        return { ok: false, error: 'automaticRecoveryRunId must be a nonempty generation.' };
      }
      const attachments = parseAttachments(actionRecord.attachments);
      if (!attachments.ok) {
        return { ok: false, error: 'attachments must contain mimeType, fileName, and content strings.' };
      }
      return {
        ok: true,
        value: {
          ref: { kind: 'session', id: refId },
          action: {
            kind: 'send',
            message,
            runId: optionalString(actionRecord, 'runId'),
            automaticRecoveryRunId: optionalString(actionRecord, 'automaticRecoveryRunId'),
            attachments: attachments.value,
            auditSteer: typeof actionRecord.auditSteer === 'boolean' ? actionRecord.auditSteer : undefined,
            steerSource,
          },
          clientMutationId,
        },
      };
    }
    if (actionKind === 'interrupt') {
      return {
        ok: true,
        value: {
          ref: { kind: 'session', id: refId },
          action: { kind: 'interrupt', runId: optionalString(actionRecord, 'runId') },
          clientMutationId,
        },
      };
    }
    if (actionKind === 'watch' || actionKind === 'resolve') {
      return {
        ok: true,
        value: {
          ref: { kind: 'session', id: refId },
          action: { kind: actionKind },
          clientMutationId,
        },
      };
    }
    return { ok: false, error: `Action ${actionKind} is not valid for a session ref.` };
  }

  if (refKind === 'lane') {
    if (actionKind === 'send_turn') {
      const message = requiredString(actionRecord, 'message');
      if (!message) return { ok: false, error: 'message is required for lane send_turn.' };
      return {
        ok: true,
        value: {
          ref: { kind: 'lane', id: refId },
          action: { kind: 'send_turn', message },
          clientMutationId,
        },
      };
    }
    if (actionKind === 'interrupt' || actionKind === 'hold') {
      return {
        ok: true,
        value: {
          ref: { kind: 'lane', id: refId },
          action: { kind: actionKind },
          clientMutationId,
        },
      };
    }
    return { ok: false, error: `Action ${actionKind} is not valid for a lane ref.` };
  }

  if (actionKind === 'steer') {
    const message = requiredString(actionRecord, 'message');
    if (!message) return { ok: false, error: 'message is required for packet steer.' };
    return {
      ok: true,
      value: {
        ref: { kind: 'packet', id: refId },
        action: { kind: 'steer', message, source: optionalString(actionRecord, 'source') },
        clientMutationId,
      },
    };
  }
  if (actionKind === 'rerun') {
    const feedback = requiredString(actionRecord, 'feedback');
    if (!feedback) return { ok: false, error: 'feedback is required for packet rerun.' };
    return {
      ok: true,
      value: {
        ref: { kind: 'packet', id: refId },
        action: { kind: 'rerun', feedback },
        clientMutationId,
      },
    };
  }
  if (actionKind === 'reset' || actionKind === 'retry') {
    return {
      ok: true,
      value: {
        ref: { kind: 'packet', id: refId },
        action: { kind: actionKind, reason: optionalString(actionRecord, 'reason') },
        clientMutationId,
      },
    };
  }
  if (actionKind === 'terminate') {
    return {
      ok: true,
      value: {
        ref: { kind: 'packet', id: refId },
        action: { kind: 'terminate' },
        clientMutationId,
      },
    };
  }
  if (actionKind === 'merge') {
    return {
      ok: true,
      value: {
        ref: { kind: 'packet', id: refId },
        action: {
          kind: 'merge',
          commitMessage: optionalString(actionRecord, 'commitMessage'),
          expectedHeadSha: optionalString(actionRecord, 'expectedHeadSha'),
        },
        clientMutationId,
      },
    };
  }
  return { ok: false, error: `Action ${actionKind} is not valid for a packet ref.` };
}

export function agentControlIdempotencyBody(request: AgentControlRequest): string {
  return JSON.stringify({ ref: request.ref, action: request.action });
}
