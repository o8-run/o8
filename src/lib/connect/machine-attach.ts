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
import { O8_WEB_MACHINE_SURFACE, webMachineRouteAllowed } from './web-machine-surface';

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
  closing: boolean;
}

export interface MachineRelayConnectorConfig {
  machineId: string;
  ticketProvider: () => Promise<MachineRelayTicket>;
  relayUrl?: string;
  apiBase?: string;
  /** Only to block responses that would carry it; never sent on a replay. */
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
      if (frame.surface === undefined) {
        this.openStream(frame.sid);
        return;
      }
      // A plugin grant arrives as plain claims the Mac cannot verify, so a
      // plugin stream is refused until the account service signs its grants.
      this.sendControl({
        t: 'mux-close',
        sid: frame.sid,
        code: 4403,
        reason: frame.surface === 'plugin' ? 'plugin_grant_unverifiable' : 'surface_not_supported',
      });
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
    // Only HTTP reads of the notice pages and their static files are replayed.
    // Realtime frames are dropped: no local operator socket is opened for a
    // relayed stream.
    if (message.t !== 'http-req') return;
    if (!webMachineRouteAllowed(message.method, message.path)) {
      this.sendMux(sid, { t: 'http-res', rid: message.rid, status: 403, error: 'web_machine_route_forbidden', bodyB64: '', last: true });
      return;
    }
    const operatorToken = this.localOperatorToken();
    void replayRelayHttpRequest({
      sid,
      request: withoutAuthorization(message as HttpReqFrame),
      apiBase: this.config.apiBase ?? localApiBase(),
      requestRegistry: this.httpRequests,
      timeoutMs: this.httpRequestTimeoutMs,
      maxTunnelBytes: this.maxTunnelBytes,
      isStreamActive: () => this.streams.get(sid) === state,
      send: (response) => this.sendMux(sid, response),
      relaySurface: O8_WEB_MACHINE_SURFACE,
      blockedResponseValues: operatorToken ? [operatorToken] : [],
      fetchImpl: this.config.fetchImpl,
    });
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

  private openStream(sid: string): void {
    if (!this.streams.has(sid)) this.streams.set(sid, { sid, closing: false });
    this.sendControl({ t: 'mux-ready', sid });
  }

  private localOperatorToken(): string {
    return (this.config.operatorToken ?? getOrCreateWsToken)().trim();
  }

  private teardownStream(sid: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    state.closing = true;
    this.httpRequests.abortStream(sid);
    this.streams.delete(sid);
  }

  private teardownStreams(reason: 'connector-stop' | 'stream-teardown'): void {
    this.httpRequests.abortAll(reason);
    for (const state of this.streams.values()) state.closing = true;
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
    }, this.keepAliveIntervalMs, { class: 'always', reason: 'links to the other computers of the owner drop without it' });
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

/** The relay's frame never chooses the local credential: replays carry none. */
function withoutAuthorization(request: HttpReqFrame): HttpReqFrame {
  const headers: Record<string, unknown> = {};
  if (request.headers && typeof request.headers === 'object') {
    for (const [name, value] of Object.entries(request.headers as Record<string, unknown>)) {
      if (name.toLowerCase() !== 'authorization') headers[name] = value;
    }
  }
  return { ...request, authorization: undefined, headers };
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
