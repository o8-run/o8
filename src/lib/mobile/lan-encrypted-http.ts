import 'server-only';

import {
  DEFAULT_MAX_TUNNEL_BYTES,
  httpCancelRequestId,
  RelayHttpRequestRegistry,
  type HttpReqFrame,
} from './relay-connector-protocol';
import { replayRelayHttpRequest } from './relay-http-replay';

/** Must beat the phone's 60 s tunnel deadline, as on the relay. */
const LAN_HTTP_TIMEOUT_MS = 55_000;

export interface LanHttpClient {
  id: string;
  authKind: 'operator' | 'device';
  deviceId?: string | null;
  e2ee?: { state: 'awaiting-init' | 'encrypted' };
}

export interface LanEncryptedHttpDeps<C extends LanHttpClient> {
  apiBase: () => string;
  /** Sends a frame on the client's socket; the socket encrypts it. */
  send: (client: C, frame: Record<string, unknown>) => void;
  isOpen: (client: C) => boolean;
  /** The active device a bearer belongs to, if any. */
  deviceIdForToken: (token: string) => string | null;
  fetchImpl?: typeof fetch;
}

function bearer(frame: HttpReqFrame): string | null {
  const raw = typeof frame.authorization === 'string' ? frame.authorization
    : frame.headers && typeof frame.headers === 'object'
      ? (frame.headers as Record<string, unknown>).authorization ?? (frame.headers as Record<string, unknown>).Authorization
      : null;
  return typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7).trim() : null;
}

/**
 * HTTP for a phone on the same network, carried over its end-to-end encrypted
 * socket as the relay carries it, so its bearer never crosses the network in
 * cleartext. Only an enrolled device's encrypted socket may use it, and only
 * with that same device's bearer. Each request is replayed into the local
 * gated API exactly as a relayed one.
 */
export function createLanEncryptedHttp<C extends LanHttpClient>(deps: LanEncryptedHttpDeps<C>) {
  const requests = new RelayHttpRequestRegistry();

  function refuse(client: C, rid: unknown, error: string): void {
    if (typeof rid === 'string' && rid) deps.send(client, { t: 'http-res', rid, status: 403, error, bodyB64: '', last: true });
  }

  return {
    /** Handles an `http-req` or `http-cancel` frame; returns false for anything else. */
    handle(client: C, msg: Record<string, unknown>): boolean {
      if (msg.t === 'http-cancel') {
        const rid = httpCancelRequestId(msg);
        if (rid) requests.cancel(client.id, rid);
        return true;
      }
      if (msg.t !== 'http-req') return false;
      const frame = msg as HttpReqFrame;
      if (client.authKind !== 'device' || !client.deviceId || client.e2ee?.state !== 'encrypted') {
        refuse(client, frame.rid, 'encrypted_device_socket_required');
        return true;
      }
      const token = bearer(frame);
      if (!token || deps.deviceIdForToken(token) !== client.deviceId) {
        refuse(client, frame.rid, 'device_mismatch');
        return true;
      }
      void replayRelayHttpRequest({
        sid: client.id,
        request: frame,
        apiBase: deps.apiBase(),
        requestRegistry: requests,
        timeoutMs: LAN_HTTP_TIMEOUT_MS,
        maxTunnelBytes: DEFAULT_MAX_TUNNEL_BYTES,
        isStreamActive: () => deps.isOpen(client),
        send: (out) => deps.send(client, out),
        fetchImpl: deps.fetchImpl,
      }).catch(() => {
        /* A failed replay answers through its own error frame or the phone's deadline. */
      });
      return true;
    },
    /** Aborts the client's requests when its socket closes. */
    close(clientId: string): void {
      requests.abortStream(clientId);
    },
  };
}
