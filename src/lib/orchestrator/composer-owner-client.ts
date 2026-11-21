import { randomUUID } from 'node:crypto';
import { getWsBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { COMPOSER_RPC_FRAME_LIMIT, COMPOSER_RPC_TIMEOUT_MS, validComposerOwnerResult, ComposerOwnerReplyError,
  ComposerOwnerUnavailable, ComposerOwnerUnknownOutcome,
  type ComposerOwnerMethod, type ComposerOwnerParams, type ComposerOwnerResults } from '@/lib/ws-server/composer-owner-rpc';

export type ComposerOwnerTransport = <M extends ComposerOwnerMethod>(method: M, params: ComposerOwnerParams[M]) => Promise<ComposerOwnerResults[M]>;
let producer: ComposerOwnerTransport | undefined;

/** Only the WS bridge installs this. Next never attaches another producer. */
export function bindComposerOwnerProducer(transport: ComposerOwnerTransport): () => void {
  producer = transport;
  return () => { if (producer === transport) producer = undefined; };
}
const INTERNAL_METHODS = new Set<ComposerOwnerMethod>(['enqueue', 'get', 'list', 'listTargets', 'listTranscript', 'promote', 'cancel']);

/** Next's transport: the owner's operator-authenticated internal endpoint. A
 * fixture whose WS port is not the o8d front door passes the owner's origin. */
export function composerOwnerHttpTransport(origin?: () => string): ComposerOwnerTransport {
  return (method, params) => internalRequest(method, params, origin?.() ?? getWsBase().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'));
}

async function internalRequest<M extends ComposerOwnerMethod>(method: M, params: ComposerOwnerParams[M], base: string): Promise<ComposerOwnerResults[M]> {
  if (!INTERNAL_METHODS.has(method)) throw new ComposerOwnerUnavailable('The composer executor requires its attached owner.');
  const body = JSON.stringify({ v: 1, method, params });
  if (Buffer.byteLength(body) > COMPOSER_RPC_FRAME_LIMIT) throw new ComposerOwnerReplyError('limit', 'The composer owner request exceeds its frame limit.');
  const headers = { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' };
  let response: Response;
  try {
    response = await fetch(`${base}/internal/composer-queue`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(COMPOSER_RPC_TIMEOUT_MS), redirect: 'error',
    });
  } catch {
    // A lost enqueue response may follow a commit. Never retry using another transport.
    if (['enqueue', 'promote', 'cancel'].includes(method)) throw new ComposerOwnerUnknownOutcome(method, randomUUID());
    throw new ComposerOwnerUnavailable('The composer queue owner is unavailable.');
  }
  if (response.status === 503) throw new ComposerOwnerUnavailable('The composer queue owner is unavailable.');
  if (!response.ok) throw new ComposerOwnerReplyError(response.status === 401 ? 'invalid' : 'unavailable', 'The composer queue owner request was refused.');
  let reply: unknown;
  try {
    if (!response.body) throw new Error('Missing owner response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > COMPOSER_RPC_FRAME_LIMIT) { void reader.cancel().catch(() => {}); throw new Error('Oversized owner response'); }
        chunks.push(part.value);
      }
      reply = JSON.parse(Buffer.concat(chunks, bytes).toString());
    } finally { reader.releaseLock(); }
  } catch { throw new ComposerOwnerUnknownOutcome(method, randomUUID()); }
  if (!reply || typeof reply !== 'object' || !('ok' in reply)) throw new ComposerOwnerUnknownOutcome(method, randomUUID());
  if (reply.ok === false && 'error' in reply && reply.error && typeof reply.error === 'object'
    && 'code' in reply.error && typeof reply.error.code === 'string' && 'message' in reply.error && typeof reply.error.message === 'string') {
    throw new ComposerOwnerReplyError(reply.error.code, reply.error.message);
  }
  if (reply.ok !== true || !('result' in reply) || !validComposerOwnerResult(method, reply.result)) throw new ComposerOwnerUnknownOutcome(method, randomUUID());
  return reply.result as ComposerOwnerResults[M];
}

/** True while o8d is attached as the producer: it then sends a notice for every queue change. */
export function composerOwnerSignalsAvailable(): boolean {
  return producer !== undefined;
}

/** Choose once per call. A sent request never falls back or automatically replays. */
const nextTransport = composerOwnerHttpTransport();
export const composerOwnerRequest: ComposerOwnerTransport = (method, params) => {
  const transport = producer ?? nextTransport;
  return transport(method, params);
};
