import { appendEvent, listLanes } from '@/lib/lane/registry';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { resolvePacketScope } from '@/lib/orchestrator/packet-scope-policy';

const MAX_REQUEST_PATHS = 8;
const MAX_ALLOWED_PATHS = 64;
const BLOCKED_PREFIXES = ['.git', '.next', 'dist', 'out'];

export interface PacketScopeExpansionResult {
  packetId: string;
  laneId: string | null;
  requestedPaths: string[];
  allowedPaths: string[];
  reason: string;
  expanded: boolean;
  /** `lead` when the lead granted the scope; `worker` when the worker requested it. */
  grantedBy: 'lead' | 'worker';
}

function normalizeExpansionPath(value: string): string {
  const path = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!path) throw new Error('Scope expansion paths must not be empty.');
  if (path === '**/*' || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`Scope expansion path is not bounded: ${value}`);
  }
  if (path.includes('*') && !path.endsWith('/**')) {
    throw new Error(`Scope expansion wildcards are limited to a trailing /**: ${value}`);
  }
  if (BLOCKED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    throw new Error(`Scope expansion cannot include blocked path: ${value}`);
  }
  return path;
}

export async function requestPacketScopeExpansion(input: {
  packetId: string;
  paths: string[];
  reason: string;
  /** A lead grant records `scope_granted`, which does not hold the packet for inspection. */
  grantedBy?: 'lead' | 'worker';
}): Promise<PacketScopeExpansionResult> {
  const grantedBy = input.grantedBy === 'lead' ? 'lead' : 'worker';
  const verb = grantedBy === 'lead' ? 'scope_granted' : 'scope_expansion_requested';
  const packetId = input.packetId.trim();
  const reason = input.reason.trim();
  if (!packetId) throw new Error('packetId is required.');
  if (reason.length < 8) throw new Error('A recorded scope expansion reason of at least 8 characters is required.');
  const requestedPaths = [...new Set(input.paths.map(normalizeExpansionPath))];
  if (requestedPaths.length === 0) throw new Error('At least one scope expansion path is required.');
  if (requestedPaths.length > MAX_REQUEST_PATHS) {
    throw new Error(`A scope expansion request is limited to ${MAX_REQUEST_PATHS} paths.`);
  }

  const { result } = await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) throw new Error(`Packet ${packetId} was not found.`);
    const currentPaths = resolvePacketScope(packet).allowedPaths;
    const allowedPaths = currentPaths.includes('**/*')
      ? currentPaths
      : [...new Set([...currentPaths, ...requestedPaths])];
    if (allowedPaths.length > MAX_ALLOWED_PATHS) {
      throw new Error(`Expanded packet scope cannot exceed ${MAX_ALLOWED_PATHS} paths.`);
    }
    packet.allowedFiles = allowedPaths;
    packet.lastEventAt = new Date().toISOString();
    packet.lastEventLabel = verb;
    return {
      requestedPaths,
      allowedPaths,
      expanded: allowedPaths.some((path) => !currentPaths.includes(path)),
    };
  });

  const lane = listLanes().find((candidate) => candidate.packetId === packetId) ?? null;
  if (lane) {
    appendEvent(lane.id, verb, 'orchestrator', {
      packetId,
      requestedPaths,
      allowedPaths: result.allowedPaths,
      reason,
      expanded: result.expanded,
    });
  }
  return {
    packetId,
    laneId: lane?.id ?? null,
    requestedPaths,
    allowedPaths: result.allowedPaths,
    reason,
    expanded: result.expanded,
    grantedBy,
  };
}
