import type { RequestPrincipalContext } from '@/lib/auth/principal';

/** The existing live view allows occupancy, never task content or credentials. */
export function canReadLiveLaneOccupancy(principal: RequestPrincipalContext): boolean {
  return principal.role === 'operator'
    || (principal.role === 'worker' && !principal.readOnly && Boolean(principal.packetId && principal.tokenId));
}
