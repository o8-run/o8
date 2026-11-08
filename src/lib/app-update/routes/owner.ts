import { UPDATE_RETRY } from '@/lib/app-update/fresh-check';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

type Handler = (request: Request) => Promise<Response>;

/**
 * Updater state is module memory shared by update-state, update/apply and
 * relaunch: the desktop updater reports checks to one, the others wait on that
 * report, and an apply request stays bound until the updater admits it. All
 * three run in one process, the WS process while the native transport is on.
 */
export function ownedUpdateRoute(handler: Handler) {
  const owned = ownedByNativeTransport(handler, () => Response.json({ ok: false,
    error: { code: 'update_owner_unavailable', message: 'The process that owns updater state is unavailable.', ...UPDATE_RETRY } },
  { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } }));
  // Next always passes the request. The updater's in-process tests call GET()
  // bare, which reads this process's state directly, as before.
  return (request?: Request) => request ? owned(request) : handler(new Request('http://127.0.0.1/'));
}
