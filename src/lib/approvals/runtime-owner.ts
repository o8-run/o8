import { NextRequest } from 'next/server';
import { getApproval } from '@/lib/approvals/store';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const RUNTIME_APPROVAL_OPERATION = 'runtimeApprovalOperation';

export function isNativeApprovalContinuation(kind: unknown): boolean {
  return kind === 'runtime' || kind === 'lane' || kind === 'plan';
}

/** Data-only intent. WS repeats this selection against its own durable record. */
export function isRuntimeApprovalRequest(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  if (body.action !== 'approve' && body.action !== 'reject') return false;
  if (typeof body.id !== 'string') return false;
  const approval = getApproval(body.id.trim());
  if (body.terminalAdapter !== undefined) return approval?.continuation?.kind === 'lane';
  return isNativeApprovalContinuation(approval?.continuation?.kind);
}

const forward = ownedByNativeTransport(
  async () => Response.json({ ok: false, error: 'Native approval operation requires the native transport.' }, { status: 503 }),
  () => Response.json({ ok: false, error: 'Approval runtime owner is unavailable.' }, { status: 503 }),
  // The handler reads only the bearer and the agent-tool marker; the merge hold depends on the marker.
  { forwardHeaders: ['x-o8-agent-tool'] },
);

/** Forward runtime, lane and plan decisions; LLM continuations stay beside their proxy. */
export function forwardRuntimeApproval(request: NextRequest, body: Record<string, unknown>): Promise<Response> {
  return forward(new NextRequest(request.url, {
    method: request.method, headers: request.headers, signal: request.signal,
    body: JSON.stringify({ ...body, [RUNTIME_APPROVAL_OPERATION]: true }),
  }));
}
