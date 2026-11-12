import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

/** Next never imports a brain handler, even with the native transport flag unset. */
export function symonOwnerRoute() {
  const unavailable = () => Response.json({ ok: false, error: 'brain_unavailable' }, { status: 503 });
  return ownedByNativeTransport(async () => unavailable(), unavailable, { alwaysForward: true });
}
