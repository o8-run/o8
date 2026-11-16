import type { MobileDevice } from '@/lib/mobile/device-registry';
import { getServerIdentity } from '@/lib/mobile/e2ee-identity';
import { startServerHandshake, type ServerHandshake } from '@/lib/mobile/e2ee-channel';
import { deviceE2eeFailureAction } from './device-e2ee-policy';

interface HandshakeClient {
  id: string;
  ws: { close: (code: number, reason: string) => void };
  e2ee?: {
    state: 'awaiting-init' | 'encrypted';
    handshake?: ServerHandshake;
    helloTimer?: ReturnType<typeof setTimeout>;
  };
}

/** The remote enrolled-device connection entry point. No plaintext fallback. */
export function initiateE2eeHandshake<Client extends HandshakeClient>(
  client: Client,
  device: Pick<MobileDevice, 'identityPublicKey'>,
  send: (client: Client, message: Record<string, unknown>) => void,
): void {
  try {
    const { handshake, hello } = startServerHandshake(getServerIdentity(), device.identityPublicKey);
    // Send hello while the connection is still "plaintext" (e2ee unset) so the
    // awaiting-init suppression in send/sendRaw doesn't block it; THEN enter the
    // handshake window. hello is plaintext (it establishes the key) but signed.
    send(client, { channel: 'system', event: 'e2ee-hello', data: hello });
    client.e2ee = { state: 'awaiting-init', handshake };
    client.e2ee.helloTimer = setTimeout(() => {
      if (client.e2ee?.state === 'awaiting-init') {
        const action = deviceE2eeFailureAction('handshake_timeout');
        console.warn(`[mobile-e2ee] ${client.id} did not complete the required device-key handshake`);
        try { client.ws.close(action.closeCode, action.closeReason); } catch { /* already gone */ }
      }
    }, 2500);
  } catch {
    console.warn('[mobile-e2ee] Handshake initialization failed; pairing retained.');
    const action = deviceE2eeFailureAction('handshake_init_failed');
    try { client.ws.close(action.closeCode, action.closeReason); } catch { /* already gone */ }
  }
}
