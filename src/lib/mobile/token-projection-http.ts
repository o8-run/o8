import type { IncomingMessage, ServerResponse } from 'node:http';
import { syncTokenFile } from '@/lib/mobile/device-registry';

/** Internal repair operation. Authentication must use the operator bearer only. */
export function handleTokenProjectionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authorize: (req: IncomingMessage) => boolean,
): boolean {
  if (req.url !== '/internal/mobile-token-projection' || req.method !== 'POST') return false;
  if (!authorize(req)) { res.writeHead(401); res.end(); return true; }
  try {
    syncTokenFile();
    res.writeHead(204);
  } catch {
    res.writeHead(503, { 'Retry-After': '2' });
  }
  res.end();
  return true;
}
