import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { WebSocket } from 'ws';

import { listApprovals } from '@/lib/approvals/store';
import { readCachedEntitlement } from '@/lib/entitlement/license';
import { getEntitlementSync } from '@/lib/entitlement/store';
import type { Plan } from '@/lib/entitlement/types';
import { resolvePortInfo } from '@/lib/panel/api-port';

import { startServerHandshake, completeServerHandshake, type ServerHandshake } from './e2ee-channel';
import { encryptFrame, decryptFrame, isEncryptedFrame, type EncryptedFrame } from './e2ee-crypto';
import { getServerIdentity } from './e2ee-identity';
import { listDevices, resolveDeviceByToken, type MobileDevice } from './device-registry';
import { listRemoteNotificationTokens } from './live-activity-push';
import {
  deriveRoutingId,
  httpCancelRequestId,
  passthroughCloseCode,
  relayConnectorEligible,
  DEFAULT_MAX_TUNNEL_BYTES,
  DEFAULT_RELAY_URL,
  RelayHttpRequestRegistry,
  type HttpReqFrame,
} from './relay-connector-protocol';
import { replayRelayHttpRequest } from './relay-http-replay';
import { RelayReconnectPolicy } from './relay-reconnect';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * o8 Relay connector — the Mac-side outbound leg of the public relay contract
 * documented in docs/internals/connect-contract.md.
 *
 * The Mac dials OUT to the relay (no inbound ports). For each relayed phone the
 * connector TERMINATES the Mac-side tunnel — it must, because v1.1 requires it to
 * read the in-tunnel `auth {token}` (first-frame gate) and `http-req` (replayed to
 * local Next), both of which live inside the E2EE channel, so the connector holds
 * the session key (it is Mac-side + fully trusted; the ZERO-KNOWLEDGE constraint
 * binds the RELAY, not this). Per bridged stream:
 *
 *   await-auth → first frame MUST be `auth {token}`, validated against the device
 *                registry; invalid → close 4403 (held unauthenticated until then)
 *   handshaking → mandatory server-initiated E2EE (same identity key as ws-server,
 *                 so the phone's pinned key matches); failure → 4403, NO raw fallback
 *   ready       → decrypt each frame: `http-req` → replay to 127.0.0.1:{apiPort}
 *                 stamping a NON-loopback x-o8-client-addr marker + the phone's
 *                 Bearer (middleware gates per-route, never loopback-trusted); every
 *                 other frame → bridged to a local ws-server connection (the realtime
 *                 channels). Mac-origin 4401/4403 closes pass back through the relay.
 *
 * HARD ISOLATION: gated behind entitlement + an operator setting + a license token,
 * and every entry point is wrapped so a failure NEVER touches the LAN path. When the
 * relay is down the Mac just isn't reachable off-network; LAN is unaffected.
 *
 * NOTE: the live E2EE-channel bridge + real-phone interop is validated by the
 * gated cross-network conformance path with the real mobile client — it cannot
 * be exercised in-repo. The contract-critical PURE logic
 * (relay-connector-protocol.ts) is unit-tested; the relay half is validated
 * against the public relay wire contract in docs/internals/connect-contract.md.
 */

const P = '[relay]';
const STREAM_HANDSHAKE_DEADLINE_MS = 8_000; // must beat the relay's 10s deadline
const HTTP_REPLAY_TIMEOUT_MS = 55_000; // must beat the mobile tunnel's 60s deadline
// Same ping/pong settings as machine attach, with a 30s total detection budget.
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 20_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const RELAY_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_ENTITLEMENT_RETRY_INTERVAL_MS = 5 * 60_000;

// v1.1 contract sequence: Mac-initiated E2EE handshake on bridge → device identified
// by the client's init signature against the enrolled registry (mutual-auth, no plaintext
// token to the relay) → then `auth {token}` as the first IN-TUNNEL (encrypted) frame
// before any channel/http traffic.
type StreamPhase = 'handshaking' | 'await-tunnel-auth' | 'ready';

interface StreamState {
  sid: string;
  phase: StreamPhase;
  device?: MobileDevice;
  deviceToken?: string;
  handshake?: ServerHandshake;
  sessionKey?: Uint8Array;
  bridge?: WebSocket;
  deadline?: ReturnType<typeof setTimeout>;
}

export interface RelayConnectorConfig {
  /** The app factory supplies live getters; conformance callers may supply fixture credentials. */
  plan: Plan;
  settingEnabled: boolean;
  licenseToken: string | null;
  relayUrl?: string;
  /** > 0 when a blocked approval is waiting — drives push-req when no phone is live. */
  blockedApprovalCount: () => number;
  maxTunnelBytes?: number;
  /** Test/diagnostic override. Production is capped below the mobile deadline. */
  httpRequestTimeoutMs?: number;
  keepAliveIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Rejected or locally ineligible credentials are rechecked at +/-20% of this interval. */
  entitlementRetryIntervalMs?: number;
  entitlementRetryRandom?: () => number;
}

export class RelayConnector {
  private ws: WebSocket | null = null;
  private readonly streams = new Map<string, StreamState>();
  private readonly reconnect = new RelayReconnectPolicy();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private awaitingEntitlement = false;
  private liveDeviceCount = 0;
  private readonly routingId: string;
  private readonly relayUrl: string;
  private readonly maxTunnelBytes: number;
  private readonly httpRequestTimeoutMs: number;
  private readonly keepAliveIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly entitlementRetryIntervalMs: number;
  private readonly httpRequests = new RelayHttpRequestRegistry();

  constructor(private readonly config: RelayConnectorConfig) {
    this.routingId = deriveRoutingId(getServerIdentity().publicKeyB64);
    this.relayUrl = (config.relayUrl || process.env.O8_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, '');
    this.maxTunnelBytes = config.maxTunnelBytes ?? DEFAULT_MAX_TUNNEL_BYTES;
    this.keepAliveIntervalMs = positiveInteger(config.keepAliveIntervalMs, DEFAULT_KEEP_ALIVE_INTERVAL_MS);
    this.pongTimeoutMs = positiveInteger(config.pongTimeoutMs, DEFAULT_PONG_TIMEOUT_MS);
    this.entitlementRetryIntervalMs = positiveInteger(config.entitlementRetryIntervalMs, DEFAULT_ENTITLEMENT_RETRY_INTERVAL_MS);
    const configuredTimeout = config.httpRequestTimeoutMs;
    this.httpRequestTimeoutMs =
      typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.min(Math.floor(configuredTimeout), HTTP_REPLAY_TIMEOUT_MS)
        : HTTP_REPLAY_TIMEOUT_MS;
  }

  get id(): string {
    return this.routingId;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearKeepAlive();
    for (const sid of [...this.streams.keys()]) this.teardownStream(sid);
    this.httpRequests.abortAll('connector-stop');
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'connector stop');
    } catch {
      /* already gone */
    }
  }

  private dial(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      const { plan, settingEnabled, licenseToken } = this.config;
      if (!relayConnectorEligible(plan, settingEnabled) || !licenseToken?.trim()) {
        this.scheduleReconnect(true);
        return;
      }
      ws = new WebSocket(`${this.relayUrl}/mac`, {
        headers: {
          authorization: `Bearer ${licenseToken.trim()}`,
          'x-o8-routing-id': this.routingId,
        },
      });
    } catch (err) {
      console.warn(`${P} dial failed: ${errMsg(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped || ws !== this.ws) return;
      this.startKeepAlive(ws);
      console.log(`${P} connector up → ${this.relayUrl} (routingId=${this.routingId.slice(0, 8)}…)`);
    });
    ws.on('pong', () => {
      if (ws === this.ws) this.acknowledgeLiveness();
    });
    ws.on('message', (raw) => {
      if (ws === this.ws && !this.stopped) this.onRelayMessage(raw);
    });
    ws.on('close', (code) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.clearKeepAlive();
      if (code === 4409) {
        console.warn(`${P} connector closed 4409 entitlement_lapsed — waiting for refreshed entitlement`);
      }
      this.scheduleReconnect(code === 4409);
    });
    ws.on('error', (err) => {
      console.warn(`${P} connector socket error: ${errMsg(err)}`);
    });
  }

  private scheduleReconnect(entitlementBlocked = false): void {
    if (this.stopped) return;
    if (entitlementBlocked) this.awaitingEntitlement = true;
    for (const sid of [...this.streams.keys()]) this.teardownStream(sid);
    // A WebSocket upgrade is not entitlement acceptance. Keep this cadence
    // across failed attempts until the relay acknowledges a successful attach.
    const delay = this.awaitingEntitlement
      ? Math.round(this.entitlementRetryIntervalMs * (0.8 + 0.4 * (this.config.entitlementRetryRandom ?? Math.random)()))
      : this.reconnect.nextDelay();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.httpRequests.abortAll('connector-stop');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startKeepAlive(ws: WebSocket): void {
    this.clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.stopped || ws !== this.ws || ws.readyState !== WebSocket.OPEN || this.pongTimer) return;
      try {
        ws.ping();
      } catch {
        ws.terminate();
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.stopped || ws !== this.ws) return;
        console.warn(`${P} keepalive timeout`);
        ws.terminate();
      }, this.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.keepAliveIntervalMs);
    this.keepAliveTimer.unref?.();
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.keepAliveTimer = null;
    this.pongTimer = null;
    this.heartbeatTimer = null;
  }

  private acknowledgeLiveness(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.sendControl({ t: 'relay-capabilities', heartbeat: 'app-v1' });
    const beat = () => this.sendControl({ t: 'relay-heartbeat', v: 1 });
    beat();
    this.heartbeatTimer = setInterval(beat, RELAY_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  // ── relay → connector ──
  private onRelayMessage(raw: unknown): void {
    const frame = safeParse(typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8'));
    if (!frame) return;
    switch (frame.t) {
      case 'mux-open':
        this.openStream(String(frame.sid));
        return;
      case 'mux-close':
        this.teardownStream(String(frame.sid));
        return;
      case 'devices':
        this.awaitingEntitlement = false;
        this.reconnect.reset();
        // An explicit relay advertisement is required: older relays must never
        // receive control frames they do not understand.
        if (frame.heartbeat === 'app-v1') this.startHeartbeat();
        this.liveDeviceCount = typeof frame.count === 'number' ? frame.count : 0;
        this.maybePushOnDevices();
        return;
      case 'relay-heartbeat-ack':
        if (this.heartbeatTimer && frame.v === 1) this.acknowledgeLiveness();
        return;
      case 'mux':
        if (typeof frame.sid === 'string' && typeof frame.payload === 'string') {
          this.onStreamPayload(frame.sid, frame.payload);
        }
        return;
      default:
        return;
    }
  }

  private openStream(sid: string): void {
    if (this.streams.has(sid)) return;
    const state: StreamState = { sid, phase: 'handshaking' };
    state.deadline = setTimeout(() => this.closeStream(sid, 4403, 'handshake_deadline'), STREAM_HANDSHAKE_DEADLINE_MS);
    state.deadline.unref?.();
    this.streams.set(sid, state);
    // Contract: the Mac initiates the handshake unconditionally on bridge. The hello is
    // server-side only (no device needed yet) — the device is identified from the client's
    // init signature below.
    this.startStreamHandshake(state);
  }

  private onStreamPayload(sid: string, payloadB64: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    const bytes = Buffer.from(payloadB64, 'base64');

    if (state.phase === 'handshaking') {
      const inner = parseJson(bytes);
      if (!inner || inner.type !== 'e2ee-init' || !state.handshake) return;
      const init = { clientEphPub: inner.clientEphPub, clientNonce: inner.clientNonce, clientSig: inner.clientSig };
      // Identify AND authenticate the device from its init signature: the one enrolled
      // device whose identity public key verifies clientSig is the caller. No plaintext
      // token ever crosses the relay — the token check is deferred to the encrypted tunnel.
      let matched: { device: MobileDevice; sessionKey: Uint8Array } | null = null;
      for (const dev of safe(() => listDevices()) ?? []) {
        const result = completeServerHandshake({ ...state.handshake, deviceIdentityPubB64: dev.identityPublicKey }, init);
        if (!('error' in result)) { matched = { device: dev, sessionKey: result.sessionKey }; break; }
      }
      if (!matched) {
        this.closeStream(sid, 4403, 'e2ee: no enrolled device verifies the init signature');
        return;
      }
      state.device = matched.device;
      state.sessionKey = matched.sessionKey;
      state.handshake = undefined;
      state.phase = 'await-tunnel-auth';
      console.log(`${P} handshake OK sid=${sid.slice(0, 8)} device=${matched.device.id.slice(0, 8)} — awaiting in-tunnel auth{token}`);
      this.sendEncrypted(state, { channel: 'system', event: 'e2ee-ready' });
      this.sendControl({ t: 'mux-ready', sid }); // relay clears pending + its deadline
      return;
    }

    if (state.phase === 'await-tunnel-auth') {
      // First frame INSIDE the tunnel must be `auth {token}`, validated against the device
      // the handshake already identified (same device must hold identity secret + token).
      if (!state.sessionKey) return;
      const parsed = parseJson(bytes);
      if (!isEncryptedFrame(parsed)) return;
      const plaintext = decryptFrame(parsed as EncryptedFrame, state.sessionKey);
      if (plaintext === null) return;
      const inner = safeParse(plaintext);
      const data = inner && typeof inner.data === 'object' && inner.data ? (inner.data as Record<string, unknown>) : null;
      const isAuth = inner?.t === 'auth' || inner?.event === 'auth';
      const token = typeof inner?.token === 'string' ? inner.token : (data && typeof data.token === 'string' ? data.token : '');
      if (!isAuth || !token) { this.closeStream(sid, 4403, 'expected in-tunnel auth{token}'); return; }
      const byToken = safe(() => resolveDeviceByToken(token));
      if (!byToken || byToken.id !== state.device?.id) { this.closeStream(sid, 4403, 'auth token/identity mismatch'); return; }
      state.deviceToken = token;
      state.phase = 'ready';
      if (state.deadline) clearTimeout(state.deadline);
      this.openBridge(state);
      return;
    }

    // ready — decrypt the {e2ee,n,c} envelope and route the plaintext.
    if (!state.sessionKey) return;
    const parsed = parseJson(bytes);
    if (!isEncryptedFrame(parsed)) return;
    const plaintext = decryptFrame(parsed as EncryptedFrame, state.sessionKey);
    if (plaintext === null) return; // couldn't decrypt — drop
    const msg = safeParse(plaintext);
    if (!msg) return;
    if (msg.t === 'http-cancel') {
      const rid = httpCancelRequestId(msg);
      if (rid) this.httpRequests.cancel(state.sid, rid);
      return;
    }
    if (msg.t === 'http-req') {
      void this.replayHttp(state, msg as HttpReqFrame);
      return;
    }
    // Everything else is a realtime ws channel frame → bridge to the local ws-server.
    if (state.bridge && state.bridge.readyState === WebSocket.OPEN) {
      try {
        state.bridge.send(plaintext);
      } catch {
        /* bridge gone */
      }
    }
  }

  private startStreamHandshake(state: StreamState): void {
    try {
      // deviceIdentityPubB64 deferred ('') — the hello is server-side only; the device is
      // identified from the client's init signature (see the handshaking phase above).
      const { handshake, hello } = startServerHandshake(getServerIdentity(), '');
      state.handshake = handshake;
      state.phase = 'handshaking';
      // hello is PLAINTEXT (it establishes the key) but signed by the server identity.
      this.sendPlain(state, { channel: 'system', event: 'e2ee-hello', data: hello });
    } catch (err) {
      this.closeStream(state.sid, 4403, `handshake_init: ${errMsg(err)}`);
    }
  }

  private openBridge(state: StreamState): void {
    if (!state.deviceToken) return;
    const { wsPort } = resolvePortInfo();
    let bridge: WebSocket;
    try {
      // Loopback to our own ws-server. The connector already did device-auth + E2EE,
      // so this hop is a trusted plaintext loopback channel.
      bridge = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(state.deviceToken)}`);
    } catch (err) {
      console.warn(`${P} bridge dial failed sid=${state.sid}: ${errMsg(err)}`);
      return;
    }
    state.bridge = bridge;
    bridge.on('message', (raw) => {
      // ws-server → phone: encrypt the plaintext channel frame and tunnel it back.
      const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8');
      const obj = safeParse(text);
      if (obj) this.sendEncrypted(state, obj);
    });
    bridge.on('close', (code) => {
      // A Mac-origin revoke/reject (4401/4403) rides back to the phone unchanged.
      const passthrough = passthroughCloseCode(code);
      this.closeStream(state.sid, passthrough ?? undefined, 'bridge_closed');
    });
    bridge.on('error', () => {/* close handler tears down */});
  }

  private async replayHttp(state: StreamState, req: HttpReqFrame): Promise<void> {
    const { apiPort } = resolvePortInfo();
    await replayRelayHttpRequest({
      sid: state.sid,
      request: req,
      apiBase: `http://127.0.0.1:${apiPort}`,
      requestRegistry: this.httpRequests,
      timeoutMs: this.httpRequestTimeoutMs,
      maxTunnelBytes: this.maxTunnelBytes,
      isStreamActive: () => this.streams.get(state.sid) === state,
      send: (frame) => this.sendEncrypted(state, frame),
    });
  }

  // ── push-req (queue-and-notify) ──
  private maybePushOnDevices(): void {
    if (this.liveDeviceCount > 0) return;
    if ((safe(() => this.config.blockedApprovalCount()) ?? 0) <= 0) return;
    const tokens = safe(() => listRemoteNotificationTokens()) ?? [];
    if (tokens.length === 0) return; // no alert-capable token registered yet (mobile must add it)
    // Fan out to EVERY enrolled phone — any of the operator's devices can act on
    // a blocked approval when they're all asleep, not just the first-registered
    // one. (Everything else in the relay data plane is already per-device.)
    for (const target of tokens) {
      this.sendControl({ t: 'push-req', apnsAlertToken: target.token, environment: target.environment, kind: 'approval' });
    }
  }

  // ── send helpers ──
  private sendControl(frame: object): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
    } catch {
      /* relay gone */
    }
  }

  private sendPlain(state: StreamState, obj: object): void {
    this.sendControl({ t: 'mux', sid: state.sid, seq: 0, payload: Buffer.from(JSON.stringify(obj), 'utf8').toString('base64') });
  }

  private sendEncrypted(state: StreamState, obj: object): void {
    if (!state.sessionKey) return;
    const frame = encryptFrame(JSON.stringify(obj), state.sessionKey);
    this.sendControl({ t: 'mux', sid: state.sid, seq: 0, payload: Buffer.from(JSON.stringify(frame), 'utf8').toString('base64') });
  }

  private closeStream(sid: string, code?: number, reason?: string): void {
    if (!this.streams.has(sid)) return;
    const phase = this.streams.get(sid)?.phase;
    if (code && code !== 1000 && code !== 1001) {
      console.warn(`${P} stream REJECT sid=${sid.slice(0, 8)} code=${code} reason=${reason ?? '?'} phase=${phase ?? '?'}`);
    }
    this.sendControl({ t: 'mux-close', sid, ...(code ? { code, reason } : {}) });
    this.teardownStream(sid);
  }

  private teardownStream(sid: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    this.httpRequests.abortStream(sid);
    if (state.deadline) clearTimeout(state.deadline);
    try {
      state.bridge?.close();
    } catch {
      /* already gone */
    }
    this.streams.delete(sid);
  }
}

// ── ws-server bootstrap entry (isolated; never breaks LAN) ───────────────────

/**
 * Resolve the operator toggle. Env override wins (`O8_RELAY_CONNECTOR=on|off`),
 * else the operator-defaults file's `relayConnectorEnabled`, else ON (default ON
 * when entitled). Reads the defaults JSON directly for forward-compat with a UI
 * toggle without coupling to the 800-line defaults.ts (a deliberate blast-radius
 * choice on a critical file — the UI plumbing is a follow-up).
 */
export function resolveRelayConnectorEnabled(): boolean {
  const raw = process.env.O8_RELAY_CONNECTOR?.trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return false;
  if (raw === 'on' || raw === 'true' || raw === '1') return true;
  try {
    const p = path.join(getDataDir(), 'operator-defaults.json');
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { relayConnectorEnabled?: unknown };
    if (typeof parsed.relayConnectorEnabled === 'boolean') return parsed.relayConnectorEnabled;
  } catch {
    /* missing/invalid → default */
  }
  return true;
}

let activeConnector: RelayConnector | null = null;

/** Read current persisted credentials and the same eligibility gates on every dial. */
function readRelayEntitlement(): { plan: Plan; licenseToken: string } | null {
  const plan = getEntitlementSync().plan;
  if (!relayConnectorEligible(plan, resolveRelayConnectorEnabled())) return null;
  const licenseToken = readCachedEntitlement()?.licenseKey?.trim();
  return licenseToken ? { plan, licenseToken } : null;
}

/**
 * Start the off-network connector IFF entitled + toggled on + a license token is
 * cached. Fully guarded: any failure logs and returns null — the LAN path is never
 * affected. Called once from the ws-server bootstrap.
 */
export function startRelayConnectorIfEnabled(
  overrides: Partial<Omit<RelayConnectorConfig, 'plan' | 'settingEnabled' | 'licenseToken'>> = {},
): RelayConnector | null {
  try {
    const entitlement = readRelayEntitlement();
    if (!entitlement) return null;
    const connector = new RelayConnector({
      // Resolve at dial time, including retries, instead of capturing startup values.
      get plan() { return getEntitlementSync().plan; },
      get settingEnabled() { return resolveRelayConnectorEnabled(); },
      get licenseToken() { return readCachedEntitlement()?.licenseKey ?? null; },
      blockedApprovalCount: () => {
        try {
          return listApprovals({ status: 'pending' }).length;
        } catch {
          return 0;
        }
      },
      ...overrides,
    });
    connector.start();
    activeConnector = connector;
    console.log(`${P} off-network connector started (plan=${entitlement.plan}, routingId=${connector.id.slice(0, 8)}…)`);
    return connector;
  } catch (err) {
    console.warn(`${P} connector bootstrap failed (LAN unaffected): ${errMsg(err)}`);
    return null;
  }
}

export function stopRelayConnector(): void {
  try {
    activeConnector?.stop();
  } catch {
    /* ignore */
  }
  activeConnector = null;
}

// ── module-level helpers ──
function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function parseJson(bytes: Buffer): Record<string, unknown> | null {
  return safeParse(bytes.toString('utf8'));
}
function safeParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
