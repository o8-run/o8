import { describe, expect, it, vi } from 'vitest';

import { createLanEncryptedHttp } from './lan-encrypted-http';

function harness(client: { id: string; authKind: 'operator' | 'device'; deviceId?: string; e2ee?: { state: string } }) {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
  const http = createLanEncryptedHttp({
    apiBase: () => 'http://127.0.0.1:1',
    send: (_c, frame) => { sent.push(frame as Record<string, unknown>); },
    isOpen: () => true,
    deviceIdForToken: (token) => (token === 'tok-a' ? 'dev-a' : null),
    fetchImpl,
  });
  return { http, sent, fetchImpl, client };
}

const request = { t: 'http-req', rid: 'r1', method: 'GET', path: '/api/mobile/inbox', headers: { authorization: 'Bearer tok-a' } };

describe('HTTP over a phone\'s local-network socket', () => {
  it('refuses a socket that is not an encrypted device socket, without reaching the API', () => {
    for (const client of [
      { id: 'c1', authKind: 'operator' as const, e2ee: { state: 'encrypted' } },
      { id: 'c2', authKind: 'device' as const, deviceId: 'dev-a', e2ee: { state: 'awaiting-init' } },
      { id: 'c3', authKind: 'device' as const, deviceId: 'dev-a' },
    ]) {
      const { http, sent, fetchImpl } = harness(client);
      expect(http.handle(client as never, request)).toBe(true);
      expect(sent).toEqual([expect.objectContaining({ t: 'http-res', rid: 'r1', status: 403, error: 'encrypted_device_socket_required' })]);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('leaves other messages to the caller', () => {
    const { http } = harness({ id: 'c1', authKind: 'device', deviceId: 'dev-a', e2ee: { state: 'encrypted' } });
    expect(http.handle({ id: 'c1' } as never, { type: 'subscribe' })).toBe(false);
  });
});
