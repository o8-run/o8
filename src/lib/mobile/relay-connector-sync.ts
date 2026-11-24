import type { IncomingMessage, ServerResponse } from 'node:http';

import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';

export const RELAY_CONNECTOR_SYNC_PATH = '/internal/mobile-devices-changed';

/**
 * Tell the server that owns the relay connector that a phone was enrolled or
 * revoked, so it starts or stops the connector. Best effort: the next dial
 * checks for an enrolled phone again.
 */
export async function notifyMobileDevicesChanged(): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${resolvePortInfo().wsPort}${RELAY_CONNECTOR_SYNC_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
  } catch {
    /* The server is not reachable; it checks again at boot and on each dial. */
  }
}

/** Internal operation on the server: authentication must use the operator bearer only. */
export function handleRelayConnectorSyncRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authorize: (req: IncomingMessage) => boolean,
  sync: () => boolean,
): boolean {
  if (req.url !== RELAY_CONNECTOR_SYNC_PATH || req.method !== 'POST') return false;
  if (!authorize(req)) { res.writeHead(401); res.end(); return true; }
  const running = sync();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ running }));
  return true;
}
