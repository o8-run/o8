import type { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from './principal';

/**
 * For packet-bound handlers the middleware opens to workers. Loopback trust admits only a caller
 * whose address the transport attests; a bearer that resolves to a packet admits the worker on
 * either transport. The handler must still refuse a worker that targets another packet
 * (workerPacketRefusal). Every other caller, including a worker credential with no packet, keeps
 * panel auth.
 */
export function requirePanelOrWorkerAuth(req: NextRequest): NextResponse | null {
  const principal = resolveRequestPrincipalContext(req);
  if (principal.role === 'operator' || (principal.role === 'worker' && principal.packetId)) return null;
  return requirePanelAuth(req);
}
