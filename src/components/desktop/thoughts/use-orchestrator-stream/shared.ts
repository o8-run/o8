import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';
import { MODEL_IDS } from '@/lib/models';
import { openSurfaceWebSocket } from '@/lib/connect/open-surface-websocket';

export type OrchestratorStreamStatus = 'connecting' | 'ready' | 'busy' | 'error' | 'dead';

export type { OrchestratorPermissionMode } from '@/lib/orchestrator/permission-mode';
export const DEFAULT_ORCHESTRATOR_MODEL: string = MODEL_IDS.orchestratorDefault;

export const ORCHESTRATOR_CONTEXT_LIMIT = 1_000_000;
export const ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR = 250_000;
export const ORCHESTRATOR_AUTO_COMPACT_THRESHOLD = 300_000;
// Fable mode (Slice 4, 2026-07-02) — the metered-orchestrator window target.
// A per-token-metered backend re-reads its window every turn, so it compacts
// at ~15K instead of 300K. Cache-aware discipline: compaction REWRITES the
// prompt-cache prefix (one full-price re-read), so it must only fire at the
// between-turn boundary the auto-compact effect already gates on
// (status === 'ready') — never mid-stride — and the floor/threshold gap keeps
// it from thrashing (re-arm only after a compaction actually lands below the
// floor). The GLOBAL constants above are deliberately untouched.
export const ORCHESTRATOR_METERED_AUTO_COMPACT_RESET_FLOOR = 12_000;
export const ORCHESTRATOR_METERED_AUTO_COMPACT_THRESHOLD = 15_000;
export const ORCHESTRATOR_FORCE_COMPACT_THRESHOLD = Math.floor(ORCHESTRATOR_CONTEXT_LIMIT * 0.85);
export { ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS } from '@/lib/orchestrator/context-estimate';
export const ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS = 8_000;
export const ORCHESTRATOR_COMPACTION_STATUS_MIN_MS = 1_200;
export const ORCHESTRATOR_TOKEN_EVENT = 'cortex:orchestrator-token-usage';

export interface OrchestratorTokenUsageDetail {
  repoPath: string | null;
  tokenCount: number;
  runningTotal: number;
}

export interface CompactResponsePayload {
  ok?: boolean;
  applied?: boolean;
  transcript?: MobileTranscriptEntry[];
  resumePrelude?: string | null;
  tokensAfter?: number;
}

export function approxTokens(value: string): number {
  return Math.max(0, Math.ceil(value.trim().length / 4));
}

export function normalizeRepoPath(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Fresh WS credentials fetched AFTER page load. The layout bakes token + port
 * into the HTML at render time; a page that outlives an app restart (dev-bridge
 * webview across a self-update, sidecar re-picking ports) holds stale values
 * and every send dies until a manual reload (live-hit 2026-07-12). On a failed
 * handshake, `refreshWsCredentials()` pulls the live values from
 * /api/panel/ws-info (loopback passes the middleware) and getWsUrl prefers
 * them over the baked snapshot from then on.
 */
let wsCredentialOverride: { port: number; token: string } | null = null;
let wsCredentialRefreshInFlight: Promise<boolean> | null = null;

export function refreshWsCredentials(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (wsCredentialRefreshInFlight) return wsCredentialRefreshInFlight;
  wsCredentialRefreshInFlight = fetch('/api/panel/ws-info')
    .then(async (res) => {
      if (!res.ok) return false;
      const data = await res.json() as { wsPort?: unknown; wsToken?: unknown };
      const port = typeof data.wsPort === 'number' && Number.isInteger(data.wsPort) && data.wsPort > 0 ? data.wsPort : null;
      const token = typeof data.wsToken === 'string' && data.wsToken.length >= 16 ? data.wsToken : null;
      if (!port || !token) return false;
      wsCredentialOverride = { port, token };
      return true;
    })
    .catch(() => false)
    .finally(() => { wsCredentialRefreshInFlight = null; });
  return wsCredentialRefreshInFlight;
}

export function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port, protocol } = window.location;
  const token = wsCredentialOverride?.token
    ?? document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';

  if (isLocal) {
    const wsPort = wsCredentialOverride?.port ?? getBrowserWsPort();
    return `ws://${hostname}:${wsPort}/ws?token=${encodeURIComponent(token)}`;
  }

  const wsPort = port ? `:${port}` : '';
  return `${wsProto}://${hostname}${wsPort}/ws?token=${encodeURIComponent(token)}`;
}

export function openOrchestratorWebSocket(): WebSocket | null {
  return openSurfaceWebSocket(getWsUrl());
}

function normalizeTelemetryPath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '').replace(/^~(?=\/)/, '');
}

export function scoreTelemetryPath(candidate: string | null | undefined, repoPath: string): number {
  const normalizedCandidate = normalizeTelemetryPath(candidate);
  const normalizedRepo = normalizeTelemetryPath(repoPath);
  if (!normalizedCandidate || !normalizedRepo) return 0;
  if (normalizedCandidate === normalizedRepo) return 4;
  if (normalizedRepo.endsWith(normalizedCandidate) || normalizedCandidate.endsWith(normalizedRepo)) return 3;
  const candidateName = normalizedCandidate.split('/').filter(Boolean).pop();
  const repoName = normalizedRepo.split('/').filter(Boolean).pop();
  return candidateName && candidateName === repoName ? 1 : 0;
}

export function emitTokenUsage(detail: OrchestratorTokenUsageDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OrchestratorTokenUsageDetail>(ORCHESTRATOR_TOKEN_EVENT, { detail }));
}

export function formatTimestampLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function createIdleBusyState(): ThoughtsOrchestratorBusyState {
  return {
    active: false,
    startedAt: null,
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
    latestToolLabel: null,
  };
}
