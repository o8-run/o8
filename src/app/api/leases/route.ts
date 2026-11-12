import { NextRequest, NextResponse } from 'next/server';

import { resolveRequestPrincipalContext, type RequestPrincipalContext } from '@/lib/auth/principal';
import { isLegacyLocalWorkerToken } from '@/lib/auth/worker-token';
import {
  getResourceLeaseStore,
} from '@/lib/leases/resource-lease-default-store';
import { observeResourceLeaseParticipant } from '@/lib/leases/resource-lease-participant';
import {
  ResourceLeaseInputError,
  ResourceLeaseSafetyError,
  normalizeResourceLeaseOwner,
  normalizeResourceName,
  type ResourceLeaseOwnerInput,
} from '@/lib/leases/resource-lease-types';
import { probeOwnedRunProcessClaim } from '@/lib/runtimes/shared/owned-session/run-process-proof';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LeaseMutationBody {
  action?: unknown;
  resource?: unknown;
  owner?: unknown;
  claimToken?: unknown;
  waiterPid?: unknown;
  ttlMs?: unknown;
  wait?: unknown;
  waiterId?: unknown;
}

type AuthorizedLeasePrincipal = Extract<RequestPrincipalContext, { role: 'operator' | 'worker' }>;
const GOVERNANCE_RESOURCE_PREFIXES = ['repo-tree:', 'test-suite:', 'apfs-mounts:'] as const;

function noStore<T>(body: T, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

function errorResponse(code: string, message: string, status: number) {
  return noStore({
    schema: 'o8/resource-lease.error/v1',
    ok: false,
    error: { code, message },
  }, status);
}

function authorizedPrincipal(request: NextRequest): AuthorizedLeasePrincipal | NextResponse {
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return errorResponse('principal_forbidden', 'Resource leases require an operator or worker credential.', 403);
  }
  if (principal.role === 'worker' && !principal.packetId && !principal.tokenId) {
    const auth = request.headers.get('authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!isLegacyLocalWorkerToken(bearer)) {
      return errorResponse(
        'worker_credential_unresolved',
        'The worker credential has no active authoritative binding.',
        403,
      );
    }
  }
  return principal as AuthorizedLeasePrincipal;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function requestedOwner(value: unknown): ResourceLeaseOwnerInput {
  const owner = record(value);
  return normalizeResourceLeaseOwner({
    id: typeof owner?.id === 'string' ? owner.id : '',
    label: typeof owner?.label === 'string' ? owner.label : '',
    pid: integer(owner?.pid) ?? 0,
  });
}

function principalOwner(
  principal: AuthorizedLeasePrincipal,
  value: unknown,
): ResourceLeaseOwnerInput {
  const owner = requestedOwner(value);
  if (principal.role === 'operator') return owner;
  const authority = principal.packetId
    ? `packet:${principal.packetId}`
    : principal.tokenId ? `worker-token:${principal.tokenId}` : 'worker:legacy';
  return { ...owner, id: authority, label: authority };
}

function principalActor(principal: AuthorizedLeasePrincipal): string {
  if (principal.role === 'operator') return 'operator';
  return principal.packetId
    ? `packet:${principal.packetId}`
    : principal.tokenId ? `worker-token:${principal.tokenId}` : 'worker:legacy';
}

function isGovernanceResource(resource: string): boolean {
  return GOVERNANCE_RESOURCE_PREFIXES.some((prefix) => resource.startsWith(prefix));
}

function reservedNamespaceRefusal(resource: string) {
  return noStore({
    schema: 'o8/resource-lease.acquire/v1',
    ok: false,
    result: {
      state: 'refused',
      reason: 'reserved_namespace',
      holder: null,
      nextWaiter: null,
      blocked: null,
      message: `${resource} is reserved for the governed o8 pipeline.`,
    },
  }, 409);
}

async function workerProcessRefusal(
  principal: AuthorizedLeasePrincipal,
  pids: number[],
): Promise<NextResponse | null> {
  if (principal.role !== 'worker') return null;
  if (!principal.packetId || !principal.tokenId || !principal.leaseProcessMarker) {
    return errorResponse(
      'worker_process_unbound',
      'The worker credential has no authenticated process binding for lease mutation.',
      409,
    );
  }
  for (const pid of new Set(pids)) {
    const proof = await probeOwnedRunProcessClaim({
      pid,
      marker: principal.leaseProcessMarker,
      rootPid: principal.leaseProcessPid,
    });
    if (proof.state !== 'match') {
      return errorResponse(
        'worker_process_unproven',
        `Lease mutation refused because PID ${pid} is not proved by the authenticated worker credential: ${proof.detail}`,
        409,
      );
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const principal = authorizedPrincipal(request);
  if (principal instanceof NextResponse) return principal;
  try {
    const resource = request.nextUrl.searchParams.get('resource')?.trim();
    if (resource) {
      const lease = await getResourceLeaseStore().status(resource);
      return noStore({ schema: 'o8/resource-lease.status/v1', ok: true, lease });
    }
    const leases = await getResourceLeaseStore().list();
    return noStore({ schema: 'o8/resource-lease.list/v1', ok: true, count: leases.length, leases });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: NextRequest) {
  const principal = authorizedPrincipal(request);
  if (principal instanceof NextResponse) return principal;
  const body = await request.json().catch(() => null) as LeaseMutationBody | null;
  if (!body) return errorResponse('invalid_json', 'A JSON lease mutation is required.', 400);
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  try {
    if (action !== 'acquire' && action !== 'release' && action !== 'heartbeat') {
      return errorResponse('invalid_action', 'Lease action must be acquire, release, or heartbeat.', 400);
    }
    const resource = normalizeResourceName(typeof body.resource === 'string' ? body.resource : '');
    if (principal.role === 'worker' && isGovernanceResource(resource)) {
      return reservedNamespaceRefusal(resource);
    }
    const owner = principalOwner(principal, body.owner);
    const waiterPid = integer(body.waiterPid) ?? owner.pid;
    const processRefusal = await workerProcessRefusal(principal, [owner.pid, waiterPid]);
    if (processRefusal) return processRefusal;
    const participant = await observeResourceLeaseParticipant({
      owner,
      waiterPid,
      actor: principalActor(principal),
      claimToken: typeof body.claimToken === 'string' ? body.claimToken : '',
    });
    if (action === 'acquire') {
      const result = await getResourceLeaseStore().acquire({
        resource,
        participant,
        ttlMs: integer(body.ttlMs),
        wait: body.wait === true,
        waiterId: typeof body.waiterId === 'string' ? body.waiterId : undefined,
      });
      const status = result.state === 'queued' ? 202 : result.state === 'refused' ? 409 : 200;
      return noStore({ schema: 'o8/resource-lease.acquire/v1', ok: result.state === 'acquired', result }, status);
    }
    if (action === 'release') {
      const result = await getResourceLeaseStore().release({ resource, participant });
      const status = result.released ? 200 : result.refusal?.code === 'not_found' ? 404 : 409;
      return noStore({ schema: 'o8/resource-lease.release/v1', ok: result.released, result }, status);
    }
    if (action === 'heartbeat') {
      const lease = await getResourceLeaseStore().heartbeat({
        resource,
        participant,
        ttlMs: integer(body.ttlMs),
      });
      return lease
        ? noStore({ schema: 'o8/resource-lease.heartbeat/v1', ok: true, lease })
        : errorResponse('not_owner', 'The caller is not the exact current lease holder.', 409);
    }
    return errorResponse('invalid_action', 'Lease action must be acquire, release, or heartbeat.', 400);
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown) {
  if (error instanceof ResourceLeaseInputError) {
    return errorResponse('invalid_lease_input', error.message, 400);
  }
  if (error instanceof ResourceLeaseSafetyError) {
    console.error('[resource-lease] Safety check failed:', error);
    return errorResponse(error.code, 'Resource lease state is unavailable and no ownership change was asserted.', 503);
  }
  console.error('[resource-lease] Route mutation failed:', error);
  return errorResponse(
    'lease_persistence_unavailable',
    'Resource lease state is unavailable and no ownership change was asserted.',
    503,
  );
}
