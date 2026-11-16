import { afterEach, describe, expect, it, vi } from 'vitest';

import { deviceE2eeFailureAction } from './device-e2ee-policy';

describe('enrolled device E2EE policy', () => {
  it.each(['handshake_timeout', 'handshake_init_failed'] as const)(
    'fails closed on %s without authorizing plaintext state',
    (failure) => {
      expect(deviceE2eeFailureAction(failure)).toEqual({
        closeCode: failure === 'handshake_timeout' ? 4411 : 4412,
        closeReason: failure,
        sendInitialState: false,
      });
    },
  );
});


import { initiateE2eeHandshake } from './device-e2ee-handshake';
import type { ServerHandshake } from '@/lib/mobile/e2ee-channel';

afterEach(() => vi.useRealTimers());

describe('remote device handshake connection entry', () => {
  it('closes a silent device with a retryable timeout and withholds app state', () => {
    vi.useFakeTimers();
    const client: { id: string; ws: { close: ReturnType<typeof vi.fn> }; e2ee?: { state: 'awaiting-init' | 'encrypted'; handshake?: ServerHandshake; helloTimer?: ReturnType<typeof setTimeout> } } = { id: 'fixture', ws: { close: vi.fn() } };
    const send = vi.fn();
    initiateE2eeHandshake(client, { identityPublicKey: 'fixture-key' }, send);
    expect(send).toHaveBeenCalledWith(client, expect.objectContaining({ event: 'e2ee-hello' }));
    vi.advanceTimersByTime(2500);
    expect(client.ws.close).toHaveBeenCalledWith(4411, 'handshake_timeout');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('closes an initialization failure without reporting revocation', () => {
    const client = { id: 'fixture', ws: { close: vi.fn() } };
    initiateE2eeHandshake(client, { identityPublicKey: 'fixture-key' }, () => { throw new Error('send unavailable'); });
    expect(client.ws.close).toHaveBeenCalledWith(4412, 'handshake_init_failed');
  });
});
