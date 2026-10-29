/** Test-only voice host peer for the native window. It admits and rejects
 * controls the way the realtime VoiceHostBroker does (binding fields,
 * requestId receipts, one active session, decisions) and lists what it
 * admitted, so the shell test cannot pass on a looser contract. The
 * production route forwards to the hidden voice window. Keep the checks in
 * step with src/lib/ws-server/voice-host.ts until the branches share it. */
import type { SurfaceRoutes } from '../surface-routes';

type Body = Record<string, unknown>;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const bound = (body: Body) => [body.binding, body.nonce, body.threadId, body.repoPath].every(id);
const same = (a: Body, b: Body) => ['binding', 'nonce', 'threadId', 'repoPath'].every(key => a[key] === b[key]);
const reply = (status: number, body: Body) => Response.json(body, { status });
const invalid = () => reply(400, { ok: false, code: 'INVALID_VOICE_HOST_REQUEST' });
const conflict = () => reply(409, { ok: false, code: 'VOICE_BINDING_MISMATCH' });

export default async function register(): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--voice-host')) return {};
  const controls: Body[] = [];
  const rejected: Body[] = [];
  const receipts = new Map<string, string>();
  let active: (Body & { state: string }) | null = null;
  const admit = (body: Body): Response => {
    if (body.action === 'decision') {
      return id(body.confirmationId) && typeof body.allow === 'boolean' ? reply(202, { ok: true }) : invalid();
    }
    if (!bound(body)) return invalid();
    if (body.action === 'start' || body.action === 'stop') {
      if (!id(body.requestId) || (body.action === 'start' && body.source !== 'byok')) return invalid();
      const prior = receipts.get(body.requestId);
      if (prior) return prior === JSON.stringify(body) ? reply(202, { ok: true }) : conflict();
      if (body.action === 'start') {
        if (active && (active.nonce === body.nonce || !['closed', 'idle', 'error'].includes(active.state))) return conflict();
        active = { binding: body.binding, nonce: body.nonce, threadId: body.threadId, repoPath: body.repoPath, state: 'connecting' };
      } else {
        if (!active || !same(active, body)) return conflict();
        active.state = 'closing';
      }
      receipts.set(body.requestId, JSON.stringify(body));
      return reply(202, { ok: true, requestId: body.requestId, state: active.state });
    }
    if (!active || !same(active, body)) return conflict();
    if (body.action === 'context') return reply(200, { ok: true });
    if (body.action === 'accepted') {
      if (!id(body.delegationId) || !id(body.queueItemId)) return invalid();
      // The broker reads the queue item back and admits only this nonce's sends.
      return body.queueItemId.startsWith(`next-${body.nonce}-`) ? reply(200, { ok: true }) : conflict();
    }
    return invalid();
  };
  return {
    routes: {
      'POST /api/next/voice-host': async request => {
        let body: Body;
        try { body = await request.json(); } catch { return invalid(); }
        const response = admit(body);
        (response.ok ? controls : rejected).push(body);
        return response;
      },
      'GET /api/next/voice-host': async () => reply(200, { ok: true, available: true, active, confirmations: [], controls, rejected }),
    },
    admit: () => 200,
  };
}
