import { isReadOnlyWorkerBearer, resolveReadOnlyWorkerToken } from './read-only-worker-token';
import { isBrainReadWorkerBearer, resolveBrainReadWorkerToken } from './brain-read-worker-token';
import { isLegacyLocalWorkerToken, isPacketWorkerToken } from './worker-token';
import { resolvePacketWorkerToken } from './packet-worker-token';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { readActiveTokenHashes } from '@/lib/mobile/device-token-file';
import { readActiveSpectatorTokenHashes } from '@/lib/broadcast/spectator-token-file';
import { resolveSpectatorTokenRecord } from '@/lib/broadcast/spectator-token-store';
import { resolvePluginToken, type PluginPrincipal } from './plugin-token';

export type RequestPrincipal = 'operator' | 'worker' | 'device' | 'spectator' | 'plugin' | 'anonymous';

export type RequestPrincipalContext =
  | { role: 'operator' }
  | PluginPrincipal
  | {
      role: 'worker';
      readOnly?: true;
      brainRepoPath?: string;
      brainProjectId?: string | null;
      packetId: string | null;
      tokenId: string | null;
      leaseProcessMarker: string | null;
      leaseProcessPid: number | null;
      leaseProcessGroupId: number | null;
    }
  | { role: 'device' }
  | { role: 'spectator'; repoGrants: string[] }
  | { role: 'anonymous' };

export interface WorkerPacketRefusal {
  code: 'worker_packet_mismatch';
  message: string;
}

function tokenMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function isDeviceToken(presented: string): boolean {
  if (!presented) return false;
  const hash = createHash('sha256').update(presented).digest('hex');
  return readActiveTokenHashes().has(hash);
}

function isSpectatorToken(presented: string): boolean {
  if (!presented) return false;
  const hash = createHash('sha256').update(presented).digest('hex');
  return readActiveSpectatorTokenHashes().has(hash);
}

/**
 * Resolve the caller's principal for governance authorization. A dispatched
 * worker presents the local-worker token (O8_WORKER_TOKEN, attached by its
 * `o8` CLI). Operator, device, and spectator authority require an affirmative bearer match;
 * an absent or unknown credential is anonymous even when the socket is loopback.
 *
 * Fail-closed by construction: loopback location is transport evidence, not an
 * identity. This prevents a worker from becoming an operator by omitting its
 * worker token when calling a governance route directly.
 *
 * Accepts a plain `Request` (NextRequest is one) so both App-Router handlers
 * and the `Request`-typed panel routes share one resolver.
 */
export function resolveRequestPrincipal(req: Request): RequestPrincipal {
  return resolveRequestPrincipalContext(req).role;
}

export function resolveRequestPrincipalContext(req: Request): RequestPrincipalContext {
  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (isBrainReadWorkerBearer(bearer)) {
    const grant = resolveBrainReadWorkerToken(bearer);
    return grant ? { role: 'worker', readOnly: true, brainRepoPath: grant.repoPath, brainProjectId: grant.projectId,
      packetId: null, tokenId: null, leaseProcessMarker: null, leaseProcessPid: null, leaseProcessGroupId: null }
      : { role: 'anonymous' };
  }
  if (isReadOnlyWorkerBearer(bearer)) {
    const identity = resolveReadOnlyWorkerToken(bearer);
    return identity ? { role: 'worker', readOnly: true, packetId: null, tokenId: identity.tokenId,
      leaseProcessMarker: identity.runId, leaseProcessPid: null, leaseProcessGroupId: null } : { role: 'anonymous' };
  }
  const plugin = resolvePluginToken(bearer);
  if (plugin) return plugin;
  if (isPacketWorkerToken(bearer)) {
    const worker = resolvePacketWorkerToken(bearer);
    return worker
      ? {
          role: 'worker',
          packetId: worker.packetId,
          tokenId: worker.tokenId,
          leaseProcessMarker: worker.leaseProcessMarker,
          leaseProcessPid: worker.leaseProcessPid,
          leaseProcessGroupId: worker.leaseProcessGroupId,
        }
      : {
          role: 'worker',
          packetId: null,
          tokenId: null,
          leaseProcessMarker: null,
          leaseProcessPid: null,
          leaseProcessGroupId: null,
        };
  }
  if (isLegacyLocalWorkerToken(bearer)) {
    return {
      role: 'worker',
      packetId: null,
      tokenId: null,
      leaseProcessMarker: null,
      leaseProcessPid: null,
      leaseProcessGroupId: null,
    };
  }
  if (isSpectatorToken(bearer)) {
    const spectator = resolveSpectatorTokenRecord(bearer);
    if (spectator) return { role: 'spectator', repoGrants: spectator.repoGrants };
  }
  if (bearer && tokenMatches(bearer, getOrCreateWsToken().trim())) return { role: 'operator' };
  if (isDeviceToken(bearer)) return { role: 'device' };
  return { role: 'anonymous' };
}

/** Fail closed whenever a worker credential targets any packet but its owner. */
export function workerPacketRefusal(
  principal: RequestPrincipalContext,
  targetPacketId: string | null | undefined,
): WorkerPacketRefusal | null {
  if (principal.role !== 'worker') return null;
  const target = targetPacketId?.trim() || null;
  if (principal.packetId && target === principal.packetId) return null;
  return {
    code: 'worker_packet_mismatch',
    message: principal.packetId
      ? `Worker credential for packet ${principal.packetId} cannot address packet ${target ?? '(unbound)'}.`
      : 'This legacy worker credential is not bound to a packet and cannot address packet-scoped routes.',
  };
}
