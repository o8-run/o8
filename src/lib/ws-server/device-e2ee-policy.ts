/** Private mobile close codes. Keep docs/internals/mobile-e2ee.md in sync. */
export const MOBILE_CLOSE = {
  serverShutdown: 1001,
  credentialRejected: 4401,
  proofRejected: 4403,
  deviceRevoked: 4410,
  handshakeTimeout: 4411,
  initializationFailed: 4412,
  internalError: 4413,
  authUnavailable: 4414,
  protocolRejected: 4415,
} as const;

export type DeviceE2eeFailure = 'handshake_timeout' | 'handshake_init_failed';

/** Fail closed without telling a phone that its credential was revoked. */
export function deviceE2eeFailureAction(failure: DeviceE2eeFailure) {
  return {
    closeCode: failure === 'handshake_timeout' ? MOBILE_CLOSE.handshakeTimeout : MOBILE_CLOSE.initializationFailed,
    closeReason: failure,
    sendInitialState: false as const,
  };
}
