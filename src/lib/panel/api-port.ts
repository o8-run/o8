import { apiFrontDoorEnabled } from '@/lib/ws-server/api-front-door-config';
// API port resolver — picks free port from sidecar handshake.
/**
 * Shared port resolver — answers "where is the o8 backend?"
 *
 * Resolution order (first match wins):
 *   1. Explicit env var: PORT, O8_API_PORT, CORTEX_IDE_PORT.
 *   2. O8_DEV_FRONTEND_URL — when the prod app is launched in dev-bridge
 *      mode, the URL it loads from is the same origin the dev server is
 *      bound to. Parsing the port from it keeps ws-server/MCP/etc.
 *      consistent with the running webview without requiring a duplicate
 *      PORT/NEXT_ORIGIN env on every helper process.
 *   3. `~/.o8/api-port` written by the Tauri Rust sidecar during
 *      startup (prod block starts at 47100). Stale files are tolerated because
 *      the env var path wins when present.
 *   4. Port-block defaults so dev workflows still work without a sidecar.
 *
 * This is the single source of truth for /api/setup/mcp-config,
 * /api/setup/claude-desktop, orchestrator-session.ts, and the MCP server.
 * Never hardcode backend ports in a new file — import from here.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_API_PORT,
  DEFAULT_WS_PORT,
} from '@/lib/panel/port-constants';
import { getDataDir } from '@/lib/data-dir-migration';
export {
  DEFAULT_API_PORT,
  DEFAULT_WS_PORT,
  DEFAULT_DEV_API_PORT,
  DEFAULT_DEV_WS_PORT,
  DEV_API_PORT_BLOCK,
  DEV_WS_PORT_BLOCK,
  PROD_API_PORT_BLOCK,
  PROD_WS_PORT_BLOCK,
  RESERVED_PORT_BLOCK,
} from '@/lib/panel/port-constants';

export interface PortInfo {
  apiPort: number;
  wsPort: number;
  source: 'env' | 'file' | 'default';
}

// Small cache — re-read the port file if it's been rewritten (e.g., the
// Tauri shell restarted into a new port).
let _cached: { info: PortInfo; mtimeMs: number } | null = null;

function dataDir(): string {
  return getDataDir();
}

function readPortFile(name: string): number | null {
  const p = join(dataDir(), name);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    return null;
  } catch {
    return null;
  }
}

function portFileMtime(name: string): number | null {
  try {
    const p = join(dataDir(), name);
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function portFromDevFrontendUrl(): number | null {
  const raw = process.env.O8_DEV_FRONTEND_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const port = parseInt(url.port, 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

export function resolvePortInfo(): PortInfo {
  const info = resolveOriginalPortInfo();
  return apiFrontDoorEnabled() ? { ...info, wsPort: info.apiPort } : info;
}

function resolveOriginalPortInfo(): PortInfo {
  // 1) Env var wins. `PORT` comes from the Next.js process itself (bundled
  // server.js sets it). `O8_API_PORT` is set explicitly by the Rust sidecar
  // for child processes.
  const apiFromEnv =
    (process.env.O8_API_PORT && parseInt(process.env.O8_API_PORT, 10))
    || (process.env.PORT && parseInt(process.env.PORT, 10))
    || (process.env.CORTEX_IDE_PORT && parseInt(process.env.CORTEX_IDE_PORT, 10))
    || null;
  const wsFromEnv =
    (process.env.O8_WS_PORT && parseInt(process.env.O8_WS_PORT, 10))
    || (process.env.WS_PORT && parseInt(process.env.WS_PORT, 10))
    || null;

  if (apiFromEnv && Number.isFinite(apiFromEnv)) {
    return {
      apiPort: apiFromEnv,
      wsPort: wsFromEnv && Number.isFinite(wsFromEnv) ? wsFromEnv : DEFAULT_WS_PORT,
      source: 'env',
    };
  }

  // 2) Dev-bridge mode: when the prod app loads its webview from a dev
  // server, O8_DEV_FRONTEND_URL is the source of truth for where the API
  // is listening. ws-server / MCP / orchestrator-session all share this.
  const devFrontendPort = portFromDevFrontendUrl();
  if (devFrontendPort) {
    return {
      apiPort: devFrontendPort,
      wsPort: wsFromEnv && Number.isFinite(wsFromEnv) ? wsFromEnv : DEFAULT_WS_PORT,
      source: 'env',
    };
  }

  // 3) Port file — cached by mtime.
  const apiMtime = portFileMtime('api-port');
  if (apiMtime != null && _cached && _cached.mtimeMs === apiMtime) {
    return _cached.info;
  }
  const apiFromFile = readPortFile('api-port');
  const wsFromFile = readPortFile('ws-port');
  if (apiFromFile) {
    const info: PortInfo = {
      apiPort: apiFromFile,
      wsPort: wsFromFile ?? DEFAULT_WS_PORT,
      source: 'file',
    };
    if (apiMtime != null) _cached = { info, mtimeMs: apiMtime };
    return info;
  }

  // 4) Default fallback — sidecar-free workflow.
  return { apiPort: DEFAULT_API_PORT, wsPort: DEFAULT_WS_PORT, source: 'default' };
}

/**
 * Whether this realtime server is the one its data folder names. The desktop
 * shell records the port of the server it started in `ws-port`. A second server
 * started on another port against the same folder (a development server beside
 * the installed app) shares the install and pairing identity, so it must not
 * sign in to the relay: the relay keeps one link per identity, and two servers
 * would replace each other's link on every reconnect.
 */
export function ownsDataDirRelayIdentity(wsPort: number): boolean {
  const recorded = readPortFile('ws-port');
  return recorded === null || recorded === wsPort;
}

export function getApiBase(): string {
  const { apiPort } = resolvePortInfo();
  return `http://127.0.0.1:${apiPort}`;
}

export function getWsBase(): string {
  const { wsPort } = resolvePortInfo();
  return `ws://127.0.0.1:${wsPort}`;
}
