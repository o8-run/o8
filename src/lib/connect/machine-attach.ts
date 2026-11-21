import { recurring } from '@/lib/background-work/ledger';
import 'server-only';

import { WebSocket } from 'ws';

import {
  DEFAULT_MAX_TUNNEL_BYTES,
  DEFAULT_RELAY_URL,
  httpCancelRequestId,
  RelayHttpRequestRegistry,
  type HttpReqFrame,
} from '@/lib/mobile/relay-connector-protocol';
import { replayRelayHttpRequest } from '@/lib/mobile/relay-http-replay';
import { RelayReconnectPolicy } from '@/lib/mobile/relay-reconnect';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

import type { MachineRelayTicket } from './machine-registry';
import { parsePluginRelayGrant, pluginReplayAuthorization, type PluginRelayGrant } from './plugin-relay';

const P = '[connect]';
const DEFAULT_HTTP_TIMEOUT_MS = 55_000;
const DEFAULT_REFRESH_INTERVAL_MS = 8 * 60 * 1_000;
const DEFAULT_EXPIRY_LEAD_MS = 2 * 60 * 1_000;
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const MACHINE_HANDSHAKE_TIMEOUT_MS = 10_000;

export type { MachineRelayTicket } from './machine-registry';

type ConnectReason = 'attach' | 'reconnect' | 'ticket-refresh';

interface MachineStreamState {
  sid: string;
  bridge: WebSocket | null;
  pendingFrames: string[];
  pendingBytes: number;
  closing: boolean;
  pluginGrant?: PluginRelayGrant;
}

export interface MachineRelayConnectorConfig {
  machineId: string;
  ticketProvider: () => Promise<MachineRelayTicket>;
  relayUrl?: string;
  apiBase?: string;
  localWebSocketUrl?: string;
  operatorToken?: () => string;
  fetchImpl?: typeof fetch;
  maxTunnelBytes?: number;
  httpRequestTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  reconnectRandom?: () => number;
  refreshIntervalMs?: number;
  expiryLeadMs?: number;
  keepAliveIntervalMs?: number;
  pongTimeoutMs?: number;
  now?: () => number;
}

/**
 * Persistent machine-scoped relay client. `/machine` deliberately shares the
 * mobile connector's outer mux, HTTP replay, and reconnect policy, while
 * keeping mobile's device E2EE handshake isolated and unchanged.
 */
export class MachineRelayConnector {
  private activeSocket: WebSocket | null = null;
  private candidateSocket: WebSocket | null = null;
  private readonly streams = new Map<string, MachineStreamState>();
  private readonly httpRequests = new RelayHttpRequestRegistry();
  private readonly reconnect: RelayReconnectPolicy;
  private readonly relayUrl: string;
  private readonly maxTunnelBytes: number;
  private readonly httpRequestTimeoutMs: number;
  private readonly refreshIntervalMs: number;
  private readonly expiryLeadMs: number;
  private readonly keepAliveIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private candidateTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private stopped = true;

  constructor(private readonly config: MachineRelayConnectorConfig) {
    this.relayUrl = (
      config.relayUrl
      || process.env.O8_RELAY_URL
      || DEFAULT_RELAY_URL
    ).replace(/\/+$/, '');
    this.maxTunnelBytes = config.maxTunnelBytes ?? DEFAULT_MAX_TUNNEL_BYTES;
    this.httpRequestTimeoutMs = positiveInteger(
      config.httpRequestTimeoutMs,
      DEFAULT_HTTP_TIMEOUT_MS,
    );
    this.refreshIntervalMs = positiveInteger(
      config.refreshIntervalMs,
      DEFAULT_REFRESH_INTERVAL_MS,
    );
    this.expiryLeadMs = nonNegativeInteger(
      config.expiryLeadMs,
      DEFAULT_EXPIRY_LEAD_MS,
    );
    this.keepAliveIntervalMs = positiveInteger(
      config.keepAliveIntervalMs,
      DEFAULT_KEEP_ALIVE_INTERVAL_MS,
    );
    this.pongTimeoutMs = positiveInteger(
      config.pongTimeoutMs,
      DEFAULT_PONG_TIMEOUT_MS,
    );
    this.reconnect = new RelayReconnectPolicy(
      positiveInteger(config.reconnectBaseMs, 1_000),
      positiveInteger(config.reconnectCapMs, 30_000),
      8,
      config.reconnectRandom,
    );
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnect.reset();
    void this.connect('attach');
  }

  /**
   * Supervisor/network-tick recovery seam. A healthy connector is untouched;
   * a connector with no live socket, candidate, or retry timer re-enters the
   * same infinite ladder instead of requiring a desktop relaunch.
   */
  resume(): void {
    if (
      this.stopped
      || this.connecting
      || this.activeSocket
      || this.candidateSocket
      || this.reconnectTimer
    ) {
      return;
    }
    console.log(`${P} retry-resume machineId=${shortId(this.config.machineId)}`);
    this.scheduleRetry(false);
  }

  stop(reason = 'operator-disabled'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.teardownStreams('connector-stop');
    const active = this.activeSocket;
    const candidate = this.candidateSocket;
    this.activeSocket = null;
    this.candidateSocket = null;
    closeSocket(candidate, 'connector stop');
    if (active !== candidate) closeSocket(active, 'connector stop');
    console.log(`${P} detach machineId=${shortId(this.config.machineId)} reason=${reason}`);
  }

  private async connect(reason: ConnectReason): Promise<void> {
    if (this.stopped || this.connecting || this.candidateSocket) return;
    this.connecting = true;
    try {
      let ticket: MachineRelayTicket;
      try {
        ticket = await this.config.ticketProvider();
        if (!ticket.ticket.trim() || !Number.isFinite(Date.parse(ticket.expiresAt))) {
          throw new Error('invalid relay ticket response');
        }
      } catch (error) {
        console.warn(
          `${P} ${reason} ticket failed machineId=${shortId(this.config.machineId)}: ${errorMessage(error)}`,
        );
        this.scheduleRetry(Boolean(this.activeSocket));
        return;
      }
      if (this.stopped) return;

      let socket: WebSocket;
      try {
        socket = new WebSocket(`${this.relayUrl}/machine`, {
          headers: {
            authorization: `Bearer ${ticket.ticket}`,
            'x-o8-machine-id': this.config.machineId,
            'x-o8-plugin-protocol': '1',
          },
        });
      } catch (error) {
        console.warn(
          `${P} ${reason} dial failed machineId=${shortId(this.config.machineId)}: ${errorMessage(error)}`,
        );
        this.scheduleRetry(Boolean(this.activeSocket));
        return;
      }

      this.candidateSocket = socket;
      socket.on('open', () => {
        if (this.stopped || socket !== this.candidateSocket) {
          closeSocket(socket, 'stale candidate');
          return;
        }
        this.armCandidateTimeout(socket);
      });
      socket.on('message', (raw) => {
        if (socket === this.candidateSocket) {
          this.promoteSocket(socket, ticket, reason);
        }
        if (socket === this.activeSocket) this.onRelayMessage(raw);
      });
      socket.on('close', (code, rawReason) => {
        this.onSocketClose(socket, code, rawReason.toString('utf8'));
      });
      socket.on('pong', () => {
        this.onKeepAlivePong(socket);
      });
      socket.on('error', (error) => {
        console.warn(
          `${P} socket error machineId=${shortId(this.config.machineId)}: ${errorMessage(error)}`,
        );
      });
    } finally {
      this.connecting = false;
    }
  }

  private promoteSocket(
    socket: WebSocket,
    ticket: MachineRelayTicket,
    reason: ConnectReason,
  ): void {
    if (this.stopped || socket !== this.candidateSocket) {
      closeSocket(socket, 'stale candidate');
      return;
    }
    const previous = this.activeSocket;
    this.activeSocket = socket;
    this.candidateSocket = null;
    this.clearCandidateTimeout();
    this.reconnect.reset();
    this.scheduleTicketRefresh(ticket.expiresAt);
    this.startKeepAlive(socket);

    if (reason === 'ticket-refresh') {
      console.log(`${P} ticket-refresh machineId=${shortId(this.config.machineId)} status=attached`);
    } else {
      console.log(
        `${P} attach machineId=${shortId(this.config.machineId)} relay=${this.relayUrl} reason=${reason}`,
      );
    }
    if (previous && previous !== socket) closeSocket(previous, 'ticket refresh');
  }

  private onSocketClose(socket: WebSocket, code: number, reason: string): void {
    if (socket === this.candidateSocket) {
      this.candidateSocket = null;
      this.clearCandidateTimeout();
      if (!this.stopped) {
        if (!this.activeSocket) this.teardownStreams('stream-teardown');
        this.scheduleRetry(Boolean(this.activeSocket));
      }
      return;
    }
    if (socket !== this.activeSocket) return;

    this.clearKeepAlive();
    this.activeSocket = null;
    if (this.stopped) return;
    console.log(
      `${P} detach machineId=${shortId(this.config.machineId)} code=${code} reason=${reason || 'socket-closed'}`,
    );
    if (this.candidateSocket) return;
    this.teardownStreams('stream-teardown');
    this.scheduleRetry(false);
  }

  private scheduleRetry(refreshOnly: boolean): void {
    if (this.stopped) return;
    const delay = this.reconnect.nextDelay();
    if (refreshOnly) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        void this.connect('ticket-refresh');
      }, delay);
      this.refreshTimer.unref?.();
      return;
    }

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect('reconnect');
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private scheduleTicketRefresh(expiresAt: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const now = (this.config.now ?? Date.now)();
    const expiry = Date.parse(expiresAt);
    const cadenceTarget = now + this.refreshIntervalMs;
    const expiryTarget = expiry - this.expiryLeadMs;
    const minimumDelay = Math.min(1_000, this.refreshIntervalMs);
    const delay = Math.max(minimumDelay, Math.min(cadenceTarget, expiryTarget) - now);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      console.log(`${P} ticket-refresh machineId=${shortId(this.config.machineId)} status=requested`);
      void this.connect('ticket-refresh');
    }, delay);
    this.refreshTimer.unref?.();
  }

  private onRelayMessage(raw: unknown): void {
    const frame = parseRecord(
      typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8'),
    );
    if (!frame) return;
    if (frame.t === 'mux-open' && typeof frame.sid === 'string') {
      if (frame.surface === 'plugin') {
        const grant = parsePluginRelayGrant(frame.grant);
        if (!grant) return;
        this.openStream(frame.sid, grant);
      } else if (frame.surface === undefined) {
        this.openStream(frame.sid);
      }
      return;
    }
    if (frame.t === 'mux-close' && typeof frame.sid === 'string') {
      this.teardownStream(frame.sid);
      return;
    }
    if (
      frame.t === 'mux'
      && typeof frame.sid === 'string'
      && typeof frame.payload === 'string'
    ) {
      this.onStreamPayload(frame.sid, frame.payload);
    }
  }

  private onStreamPayload(sid: string, payload: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    const plaintext = Buffer.from(payload, 'base64').toString('utf8');
    const message = parseRecord(plaintext);
    if (!message) return;

    if (message.t === 'http-cancel') {
      const rid = httpCancelRequestId(message);
      if (rid) this.httpRequests.cancel(sid, rid);
      return;
    }
    if (message.t === 'http-req') {
      const apiBase = this.config.apiBase ?? localApiBase();
      const authorization = state.pluginGrant
        ? pluginReplayAuthorization(this.config.machineId, state.pluginGrant, message as HttpReqFrame)
        : `Bearer ${this.localOperatorToken()}`;
      if (!authorization) {
        this.sendMux(sid, { t: 'http-res', rid: message.rid, status: 403, error: 'plugin_route_forbidden', last: true });
        return;
      }
      void replayRelayHttpRequest({
        sid,
        request: message as HttpReqFrame,
        apiBase,
        requestRegistry: this.httpRequests,
        timeoutMs: this.httpRequestTimeoutMs,
        maxTunnelBytes: state.pluginGrant ? 65_536 : this.maxTunnelBytes,
        isStreamActive: () => this.streams.get(sid) === state,
        send: (response) => this.sendMux(sid, response),
        authorizationOverride: authorization,
        relaySurface: state.pluginGrant ? undefined : 'web-machine',
        blockedResponseValues: [authorization.slice(7), this.localOperatorToken()],
        fetchImpl: this.config.fetchImpl,
      });
      return;
    }

    if (state.pluginGrant) return;

    if (state.bridge?.readyState === WebSocket.OPEN) {
      try {
        state.bridge.send(plaintext);
      } catch {
        // The bridge close handler owns cleanup.
      }
      return;
    }
    if (state.pendingFrames.length >= 128 || state.pendingBytes + plaintext.length > 1024 * 1024) {
      this.closeStream(sid, 1009, 'websocket_backlog_exceeded');
      return;
    }
    state.pendingFrames.push(plaintext);
    state.pendingBytes += plaintext.length;
  }

  private sendMux(sid: string, frame: Record<string, unknown>): void {
    this.sendMuxPayload(sid, JSON.stringify(frame));
  }

  private sendMuxPayload(sid: string, payload: string): void {
    this.sendControl({
      t: 'mux',
      sid,
      seq: 0,
      payload: Buffer.from(payload, 'utf8').toString('base64'),
    });
  }

  private sendControl(frame: Record<string, unknown>): void {
    try {
      if (this.activeSocket?.readyState === WebSocket.OPEN) {
        this.activeSocket.send(JSON.stringify(frame));
      }
    } catch {
      // Socket close owns retry and stream cleanup.
    }
  }

  private openStream(sid: string, pluginGrant?: PluginRelayGrant): void {
    const existing = this.streams.get(sid);
    if (existing) {
      if (existing.bridge?.readyState === WebSocket.OPEN) {
        this.sendControl({ t: 'mux-ready', sid });
      }
      return;
    }

    const state: MachineStreamState = {
      sid,
      bridge: null,
      pendingFrames: [],
      pendingBytes: 0,
      closing: false,
      pluginGrant,
    };
    if (pluginGrant) {
      this.streams.set(sid, state);
      this.sendControl({ t: 'mux-ready', sid });
      return;
    }
    this.streams.set(sid, state);

    let bridge: WebSocket;
    try {
      bridge = new WebSocket(this.localWebSocketUrl());
    } catch (error) {
      console.warn(`${P} local websocket dial failed sid=${shortId(sid)}: ${errorMessage(error)}`);
      this.closeStream(sid, 1011, 'local_websocket_unavailable');
      return;
    }
    state.bridge = bridge;
    bridge.on('open', () => {
      if (this.streams.get(sid) !== state || state.closing) {
        closeSocket(bridge, 'stale web-machine stream');
        return;
      }
      this.sendControl({ t: 'mux-ready', sid });
      for (const frame of state.pendingFrames.splice(0)) {
        try {
          bridge.send(frame);
        } catch {
          break;
        }
      }
      state.pendingBytes = 0;
    });
    bridge.on('message', (raw) => {
      if (this.streams.get(sid) !== state || state.closing) return;
      const plaintext = typeof raw === 'string'
        ? raw
        : (raw as Buffer).toString('utf8');
      const operatorToken = this.localOperatorToken();
      if (operatorToken && plaintext.includes(operatorToken)) {
        console.warn(
          `${P} blocked local credential on realtime stream sid=${shortId(sid)}`,
        );
        this.closeStream(sid, 4403, 'local_credential_exposure_blocked');
        return;
      }
      this.sendMuxPayload(sid, plaintext);
    });
    bridge.on('close', (code, rawReason) => {
      if (state.closing || this.streams.get(sid) !== state) return;
      this.closeStream(
        sid,
        code === 1000 || code === 1001 ? code : 1011,
        rawReason.toString('utf8') || 'local_websocket_closed',
      );
    });
    bridge.on('error', (error) => {
      console.warn(`${P} local websocket error sid=${shortId(sid)}: ${errorMessage(error)}`);
    });
  }

  private localWebSocketUrl(): string {
    const base = this.config.localWebSocketUrl ?? localWsBase();
    const url = new URL(base);
    url.searchParams.set('token', this.localOperatorToken());
    return url.toString();
  }

  private localOperatorToken(): string {
    return (this.config.operatorToken ?? getOrCreateWsToken)().trim();
  }

  private closeStream(sid: string, code: number, reason: string): void {
    if (!this.streams.has(sid)) return;
    this.sendControl({ t: 'mux-close', sid, code, reason });
    this.teardownStream(sid);
  }

  private teardownStream(sid: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    state.closing = true;
    this.httpRequests.abortStream(sid);
    this.streams.delete(sid);
    closeSocket(state.bridge, 'web-machine stream closed');
  }

  private teardownStreams(reason: 'connector-stop' | 'stream-teardown'): void {
    this.httpRequests.abortAll(reason);
    for (const state of this.streams.values()) {
      state.closing = true;
      closeSocket(state.bridge, 'web-machine streams closed');
    }
    this.streams.clear();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.clearCandidateTimeout();
    this.clearKeepAlive();
    this.reconnectTimer = null;
    this.refreshTimer = null;
  }

  private startKeepAlive(socket: WebSocket): void {
    this.clearKeepAlive();
    this.keepAliveTimer = recurring('machine-attach-keepalive', () => {
      if (
        this.stopped
        || socket !== this.activeSocket
        || socket.readyState !== WebSocket.OPEN
        || this.pongTimer
      ) {
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        console.warn(
          `${P} keepalive ping failed machineId=${shortId(this.config.machineId)}: ${errorMessage(error)}`,
        );
        this.terminateUnresponsiveSocket(socket);
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.stopped || socket !== this.activeSocket) return;
        console.warn(
          `${P} keepalive timeout machineId=${shortId(this.config.machineId)}`,
        );
        this.terminateUnresponsiveSocket(socket);
      }, this.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.keepAliveIntervalMs);
    this.keepAliveTimer.unref?.();
  }

  private onKeepAlivePong(socket: WebSocket): void {
    if (socket !== this.activeSocket || !this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private terminateUnresponsiveSocket(socket: WebSocket): void {
    if (socket !== this.activeSocket) return;
    try {
      socket.terminate();
    } catch {
      closeSocket(socket, 'machine keepalive failed');
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.keepAliveTimer = null;
    this.pongTimer = null;
  }

  private armCandidateTimeout(socket: WebSocket): void {
    this.clearCandidateTimeout();
    this.candidateTimer = setTimeout(() => {
      if (socket !== this.candidateSocket) return;
      console.warn(
        `${P} machine handshake timed out machineId=${shortId(this.config.machineId)}`,
      );
      closeSocket(socket, 'machine handshake timeout');
    }, MACHINE_HANDSHAKE_TIMEOUT_MS);
    this.candidateTimer.unref?.();
  }

  private clearCandidateTimeout(): void {
    if (this.candidateTimer) clearTimeout(this.candidateTimer);
    this.candidateTimer = null;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function localApiBase(): string {
  const { apiPort } = resolvePortInfo();
  return `http://127.0.0.1:${apiPort}`;
}

function localWsBase(): string {
  const { wsPort } = resolvePortInfo();
  return `ws://127.0.0.1:${wsPort}/ws`;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket | null, reason: string): void {
  try {
    socket?.close(1000, reason);
  } catch {
    // Already closed.
  }
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
