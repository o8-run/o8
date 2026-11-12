import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { handleOperatorMcpMessage, type OperatorMcpRequest } from '@/lib/mcp/operator-mcp-host';
import { prepareMcpHttp } from '@/lib/mcp/operator-mcp-protocol';
import { probeOwnedRunProcessClaim } from '@/lib/runtimes/shared/owned-session/run-process-proof';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A packet worker receives device tools only, with identity from its persisted run. */
export async function POST(request: Request): Promise<Response> {
  const principal = resolveRequestPrincipalContext(request);
  const headers = { 'Cache-Control': 'no-store' };
  if (!headersIndicateLoopback(name => request.headers.get(name)) || principal.role !== 'worker' || principal.readOnly
    || !principal.packetId || !principal.tokenId || !principal.leaseProcessMarker || !principal.leaseProcessPid) {
    return Response.json({ error: { code: 'device_worker_required', message: 'Device input requires a live packet-bound worker.' } }, { status: 403, headers });
  }
  const proof = await probeOwnedRunProcessClaim({ pid: principal.leaseProcessPid, marker: principal.leaseProcessMarker, rootPid: principal.leaseProcessPid });
  if (proof.state !== 'match') return Response.json({ error: { code: 'device_worker_required', message: 'The controller worker run could not be verified.' } }, { status: 403, headers });
  let payload: OperatorMcpRequest;
  try {
    const text = await request.text();
    if (text.length > 16_384) throw new Error('Too large');
    payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid');
  } catch {
    return Response.json({ error: { code: 'device_action_invalid', message: 'Choose a supported device tool action.' } }, { status: 400, headers });
  }
  const protocol = prepareMcpHttp(payload, request.headers, new URL(request.url).protocol);
  if (protocol.refusal) return Response.json(protocol.refusal, { status: protocol.status ?? 400, headers });
  if (!['initialize', 'tools/list', 'tools/call', 'server/discover'].includes(payload.method)) {
    return Response.json({ jsonrpc: '2.0', id: payload.id ?? null, error: { code: -32601, message: 'Device tool method unavailable' } }, { status: 400, headers });
  }
  const result = await handleOperatorMcpMessage(payload, 'devices', {
    conversation: principal.packetId, worker: principal.tokenId, pid: principal.leaseProcessPid,
  });
  return result ? Response.json(result, { headers }) : new Response(null, { status: 202, headers });
}
