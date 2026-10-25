import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { assertNotKnowledgeSource } from '@/lib/cortex/knowledge/sources';

import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { modelBelongsToRuntime } from '@/lib/lane/orchestrator-model-guard';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { resolveEffortPin, type ConcreteThinkingEffort } from '@/lib/orchestrator/effort-pin';

export type LeadStatus = 'queued' | 'running' | 'waiting_workers' | 'completed'
  | 'blocked' | 'needs_approval' | 'failed' | 'stopped';

export type LeadOutcomeKind = 'completed' | 'waiting_workers' | 'needs_context'
  | 'needs_approval' | 'blocked';

export interface LeadBrief {
  objective: string;
  scope: string[];
  doneTests: string[];
  nonGoals: string[];
  budgets: string[];
  escalationCriteria: string[];
}

export interface LeadRouting {
  backend: 'codex' | 'claude';
  model: string;
  effort: ConcreteThinkingEffort;
}

export interface StartLeadInput extends LeadRouting {
  repoPath: string;
  idempotencyKey: string;
  brief: LeadBrief;
}

export interface SendLeadInput {
  leadId: string;
  message: string;
  displayMessage?: string;
  permissionMode?: 'full' | 'plan';
  attachments?: LeadAttachment[];
  idempotencyKey: string;
  repoPath?: string;
  threadId?: string;
  backend?: OrchestratorBackendId;
  model?: string;
  effort?: string;
}

export interface LeadAttachment {
  dataUri: string;
  name?: string;
}

export interface ReportLeadOutcomeInput {
  leadId: string;
  turnId: string;
  repoPath: string;
  threadId: string;
  kind: LeadOutcomeKind;
  summary: string;
  evidence: string[];
}

export interface LeadRow {
  id: string;
  start_key: string;
  request_digest: string;
  thread_id: string;
  repo_path: string;
  backend: 'codex' | 'claude';
  model: string;
  effort: ConcreteThinkingEffort;
  status: LeadStatus;
  current_turn_id: string | null;
  result_turn_id: string | null;
  result_status: string | null;
  result_text: string | null;
  error: string | null;
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface TurnRow {
  id: string;
  lead_id: string;
  root_turn_id: string | null;
  idempotency_key: string;
  ordinal: number;
  kind: 'operator' | 'review' | 'worker_return';
  message: string;
  display_message: string;
  permission_mode: 'full' | 'plan';
  attachments_json: string | null;
  brief_json: string | null;
  status: LeadStatus | 'interrupted';
  result_text: string | null;
  error: string | null;
  session_id: string | null;
  owner_pid: number | null;
  owner_identity_json: string | null;
  lease_token: string | null;
  lease_heartbeat_at: number | null;
  outcome_kind: LeadOutcomeKind | null;
  outcome_summary: string | null;
  outcome_evidence_json: string | null;
  outcome_reported_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export function validateLeadAttachments(value: unknown): LeadAttachment[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new LeadLifecycleError('attachments must be an array with at most 8 entries.', 'invalid_lead_request', 400);
  }
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw new LeadLifecycleError(`attachments[${index}] must be an object.`, 'invalid_lead_request', 400);
    }
    const record = attachment as Record<string, unknown>;
    if (typeof record.dataUri !== 'string'
      || !/^data:image\/[a-z+.-]+;base64,/i.test(record.dataUri)
      || record.dataUri.length >= 5_000_000) {
      throw new LeadLifecycleError(
        `attachments[${index}].dataUri must be a supported image data URI under 5MB.`,
        'invalid_lead_request',
        400,
      );
    }
    if (record.name !== undefined && typeof record.name !== 'string') {
      throw new LeadLifecycleError(`attachments[${index}].name must be a string.`, 'invalid_lead_request', 400);
    }
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name.length > 500) {
      throw new LeadLifecycleError(`attachments[${index}].name must be 500 characters or fewer.`, 'invalid_lead_request', 400);
    }
    return { dataUri: record.dataUri, ...(name ? { name } : {}) };
  });
}

export class LeadLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LeadLifecycleError';
  }
}

export function cleanLeadString(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LeadLifecycleError(`${field} is required.`, 'invalid_lead_request', 400);
  }
  const result = value.trim();
  if (result.length > max) {
    throw new LeadLifecycleError(`${field} must be ${max} characters or fewer.`, 'invalid_lead_request', 400);
  }
  return result;
}

export function validateLeadStringList(
  value: unknown,
  field: string,
  required = false,
): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new LeadLifecycleError(`${field} must be an array with at most 50 entries.`, 'invalid_lead_request', 400);
  }
  const items = value.map((item, index) => cleanLeadString(item, `${field}[${index}]`, 2_000));
  if (required && items.length === 0) {
    throw new LeadLifecycleError(`${field} must contain at least one entry.`, 'invalid_lead_request', 400);
  }
  return items;
}

export function validateLeadBrief(value: unknown): LeadBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LeadLifecycleError('brief must be an object.', 'invalid_lead_request', 400);
  }
  const brief = value as Record<string, unknown>;
  return {
    objective: cleanLeadString(brief.objective, 'brief.objective'),
    scope: validateLeadStringList(brief.scope, 'brief.scope', true),
    doneTests: validateLeadStringList(brief.doneTests, 'brief.doneTests', true),
    nonGoals: validateLeadStringList(brief.nonGoals, 'brief.nonGoals'),
    budgets: validateLeadStringList(brief.budgets, 'brief.budgets'),
    escalationCriteria: validateLeadStringList(brief.escalationCriteria, 'brief.escalationCriteria', true),
  };
}

export function validateLeadRouting(input: {
  backend: unknown;
  model: unknown;
  effort: unknown;
}): LeadRouting {
  if (input.backend !== 'codex' && input.backend !== 'claude') {
    throw new LeadLifecycleError('backend must be codex or claude.', 'unsupported_lead_backend', 400);
  }
  const model = cleanLeadString(input.model, 'model', 256);
  const runtime = input.backend === 'codex' ? 'codex' : 'claude-code';
  if (!modelBelongsToRuntime(model, runtime)) {
    throw new LeadLifecycleError(
      `Model "${model}" is incompatible with backend "${input.backend}".`,
      'lead_model_incompatible',
      400,
    );
  }
  const effort = resolveEffortPin({
    requestedEffort: input.effort,
    runtime,
    model,
    explicitModel: model,
  });
  if (!effort.ok || !effort.selectedEffort || effort.selectedEffort === 'adaptive') {
    throw new LeadLifecycleError(
      effort.ok ? 'A concrete effort pin is required.' : effort.message,
      effort.ok ? 'lead_effort_required' : effort.code,
      400,
    );
  }
  return { backend: input.backend, model, effort: effort.selectedEffort };
}

export function digestLeadRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function resolveLeadRepoPath(value: string, field = 'repoPath'): string {
  try {
    assertNotKnowledgeSource(value);
    assertOrchestratorRepoPath(value);
    return realpathSync(value);
  } catch (error) {
    throw new LeadLifecycleError(
      `${field} must name an existing Git repository: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_lead_repo',
      400,
    );
  }
}
