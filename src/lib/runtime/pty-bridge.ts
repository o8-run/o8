import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';

interface SpawnBridgeTerminalRequest {
  sessionName: string;
  ownedSurfaceId?: string;
  shellCommand: string;
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  resolvedEnvironment?: boolean;
  /** Trusted ownership metadata for governed worker terminal actions. */
  packetId?: string;
  laneId?: string;
}

interface SpawnBridgeTerminalResponse {
  ok: boolean;
  sessionName: string;
  pid?: number | null;
  error?: string;
}

function bridgeUrl(path: string) {
  const { wsPort } = resolvePortInfo();
  return `http://127.0.0.1:${wsPort}${path}`;
}

export class BridgeSpawnNotSubmittedError extends Error {}

function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; cause?: unknown; errors?: unknown[] };
  return value.code === 'ECONNREFUSED' || connectionRefused(value.cause)
    || Boolean(value.errors?.length && value.errors.every(connectionRefused));
}

export async function spawnBridgeTerminalSession(payload: SpawnBridgeTerminalRequest) {
  let response: Response;
  try { response = await fetch(bridgeUrl('/terminal-spawn'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOrCreateWsToken()}`,
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
  }); } catch (error) {
    if (connectionRefused(error)) throw new BridgeSpawnNotSubmittedError('Bridge connection refused before submission.');
    throw error;
  }
  if ([400, 401, 403, 404, 409, 503].includes(response.status)) {
    throw new BridgeSpawnNotSubmittedError(`Bridge refused submission (${response.status}).`);
  }
  const data = await response.json().catch(() => ({})) as SpawnBridgeTerminalResponse;
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Unable to spawn terminal session through the bridge.');
  }
  return data;
}

export async function isBridgeSessionAlive(sessionName: string, options?: { requireConfirmation: boolean }): Promise<boolean> {
  try {
    const response = await fetch(bridgeUrl(`/terminal-alive?session=${encodeURIComponent(sessionName)}`), {
      method: 'GET',
      headers: { Authorization: `Bearer ${getOrCreateWsToken()}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Bridge liveness could not be confirmed.');
    const data = await response.json() as { alive?: boolean };
    if (typeof data.alive !== 'boolean') throw new Error('Bridge liveness response is invalid.');
    return data.alive;
  } catch (error) {
    if (options?.requireConfirmation) throw error;
    return false;
  }
}

export async function signalBridgeTerminalSession(sessionName: string, signal: NodeJS.Signals = 'SIGTERM') {
  const response = await fetch(bridgeUrl('/terminal-signal'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOrCreateWsToken()}`,
    },
    body: JSON.stringify({ sessionName, signal }),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Unable to signal terminal session through the bridge.');
  }
}
