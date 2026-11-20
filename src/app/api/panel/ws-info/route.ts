export const dynamic = 'force-dynamic';

import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { apiFrontDoorEnabled } from '@/lib/ws-server/api-front-door-config';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * Live WS credentials for an already-loaded page.
 *
 * The root layout bakes the ws token + port into the HTML at render time, so
 * a page can hold STALE credentials two ways (both live-hit 2026-07-12):
 * the app restarted underneath it (token/port rotated), or — dev-bridge —
 * the dev Next server's own WS_PORT env (scripts/dev.mjs pins 47125 for the
 * pure-dev stack) outranks the port FILE written by the Tauri sidecar, so
 * every page is told to dial a ws-server that doesn't exist. Env-order
 * reasoning can't distinguish those modes, so this endpoint returns the port
 * that PROVABLY answers: probe the sidecar's port file first (the live app's
 * truth when present), then the env-resolved value, and report the first one
 * actually listening.
 *
 * Security: sits under the default-deny middleware — loopback callers (our
 * own page) pass automatically; a remote caller must already present the
 * bearer token to learn the token, which is a no-op. Same exposure model as
 * the /mobile page embedding the token for loopback loads.
 */

function portFromFile(): number | null {
  try {
    const dataDir = getDataDir();
    const filePath = path.join(dataDir, 'ws-port');
    if (!existsSync(filePath)) return null;
    const parsed = parseInt(readFileSync(filePath, 'utf8').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
  } catch {
    return null;
  }
}

function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(300, () => done(false));
  });
}

export async function GET(): Promise<Response> {
  const resolved = resolvePortInfo().wsPort;
  // Takeover has one advertised listener. A still-live stale port file must
  // not override that listener during the launcher's metadata handoff.
  const filePort = apiFrontDoorEnabled() ? null : portFromFile();
  const candidates = [...new Set([filePort, resolved].filter((p): p is number => p != null))];

  let wsPort = resolved;
  for (const candidate of candidates) {
    if (await portAlive(candidate)) {
      wsPort = candidate;
      break;
    }
  }

  return Response.json({ wsPort, wsToken: getOrCreateWsToken() });
}
