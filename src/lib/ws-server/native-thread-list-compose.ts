import type { IncomingMessage } from 'node:http';
import { applyNetworkProjectionHealth } from '@/lib/bots/network-health';
import { mobileThreadPullRequests } from '@/lib/mobile/pull-request-projection';
import { composeMobileThreadList, isMobileThreadListPieces, THREAD_LIST_COMPOSE_LIMIT } from '@/lib/mobile/thread-list-response';

/** Only the authenticated Rust backhaul can supply local pieces. This phase
 * performs no local projection or lookup of its own; the existing PR producer
 * retains its association reads and live GitHub authority. */
export async function composeNativeThreadList(req: IncomingMessage, authenticatedBridge: boolean): Promise<Response> {
  if (!authenticatedBridge || req.method !== 'POST' || req.headers['x-o8d-session-read'] !== 'compose-threads/1') return new Response(null, { status: 409 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > THREAD_LIST_COMPOSE_LIMIT) return new Response(null, { status: 409 });
    chunks.push(bytes);
  }
  try {
    const pieces: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isMobileThreadListPieces(pieces)) return new Response(null, { status: 409 });
    // This process owns projection health. Selection/order and local pieces
    // are already complete; only network rows need the in-memory health map.
    const ready = { ...pieces, pieces: pieces.pieces.map(piece => piece.thread.source === 'bot-network'
      ? { ...piece, thread: applyNetworkProjectionHealth(piece.thread) } : piece) };
    const pulls = await mobileThreadPullRequests(ready.pieces.map(({ thread }) => thread.id)).catch(() => []);
    return composeMobileThreadList(ready, pulls);
  } catch { return new Response(null, { status: 409 }); }
}
