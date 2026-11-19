import { apiFrontDoorEnabled } from '@/lib/ws-server/api-front-door-config';
import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  resolveRequestPrincipal,
  resolveRequestPrincipalContext,
  type RequestPrincipalContext,
} from '@/lib/auth/principal';
import {
  addSessionRule,
  listSessionRules,
  removeSessionRule,
  getSessionRule,
} from '@/lib/db/session-rules-store';
import { withSessionRuleMutation } from '@/lib/orchestrator/session-merge-restriction';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Session rules (#1329) — operator-authored, thread-scoped rules. The
 * default-deny middleware already gates this whole family on loopback +
 * ws-token; NO allowlist entry is added. WRITES (POST/DELETE) are additionally
 * operator-principal-only — a dispatched worker (local-worker token) may READ
 * the rules that govern it, never edit them.
 */

function requireThreadId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function findPacketForWorker(packetId: string): OrchestratorPacket | null {
  const current = readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
  if (current) return current;
  const registry = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true });
  return registry?.mission.packets.find((packet) => packet.id === packetId) ?? null;
}

function workerMayReadThread(principal: RequestPrincipalContext, threadId: string): boolean {
  if (principal.role !== 'worker' || !principal.packetId) return false;
  const packet = findPacketForWorker(principal.packetId);
  return packet?.orchestratorThreadId === threadId;
}

// GET /api/orchestrator/session-rules?threadId=<id> — list active rules.
// Operators may read any thread; workers may read only the thread that
// dispatched their packet.
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const threadId = requireThreadId(request.nextUrl.searchParams.get('threadId'));
  if (!threadId) {
    return operatorError('invalid_request', 'threadId query param is required.', 400);
  }
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && !workerMayReadThread(principal, threadId)) {
    return operatorError('forbidden', 'A dispatched worker can only read session rules for the thread that dispatched its packet.', 403);
  }
  try {
    return operatorSuccess({ rules: listSessionRules(threadId) });
  } catch (error) {
    return operatorError('session_rules_list_failed', error instanceof Error ? error.message : 'Failed to list session rules.');
  }
}

// POST /api/orchestrator/session-rules — add a rule. Operator-only.
// Body: { threadId: string, text: string }
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Editing session rules is operator-only; a dispatched worker can read but not add rules.', 403);
  }

  if (apiFrontDoorEnabled()) return operatorError('session_rules_native_owner', 'Session-rule writes require the native operator transport.', 503);

  const record = asRecord(await parseJsonBody(request));
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }
  const threadId = requireThreadId(record.threadId);
  if (!threadId) {
    return operatorError('invalid_request', 'threadId is required.', 400);
  }
  const text = typeof record.text === 'string' ? record.text : '';
  if (!text.trim()) {
    return operatorError('invalid_request', 'text is required.', 400);
  }
  try {
    if (record.constraint !== undefined && record.constraint !== null && record.constraint !== 'no_merge') {
      return operatorError('invalid_request', 'Unknown session-rule constraint.', 400);
    }
    const rule = await withSessionRuleMutation(threadId, () => addSessionRule(threadId, text, record.constraint === 'no_merge' ? 'no_merge' : null));
    if (!rule) {
      return operatorError('invalid_request', 'Rule text was empty after trimming.', 400);
    }
    return operatorSuccess({ rule });
  } catch (error) {
    return operatorError('session_rules_add_failed', error instanceof Error ? error.message : 'Failed to add session rule.');
  }
}

// DELETE /api/orchestrator/session-rules?id=<ruleId> — remove a rule. Operator-only.
export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Editing session rules is operator-only; a dispatched worker can read but not remove rules.', 403);
  }

  if (apiFrontDoorEnabled()) return operatorError('session_rules_native_owner', 'Session-rule writes require the native operator transport.', 503);

  const id = requireThreadId(request.nextUrl.searchParams.get('id'));
  if (!id) {
    return operatorError('invalid_request', 'id query param is required.', 400);
  }
  try {
    const rule = getSessionRule(id);
    return operatorSuccess({ removed: rule ? await withSessionRuleMutation(rule.threadId, () => removeSessionRule(id)) : false });
  } catch (error) {
    return operatorError('session_rules_remove_failed', error instanceof Error ? error.message : 'Failed to remove session rule.');
  }
}
