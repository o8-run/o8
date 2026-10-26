/**
 * Deterministic suite for the API auth gate (src/middleware.ts).
 *
 * Covers the Tier-1 security model:
 *   - loopback is transport context, not an authenticated principal
 *   - operator, worker, device, and spectator bearer capabilities are distinct
 *   - read-only iframe exceptions and self-authenticating routes stay explicit
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The gate is what's under test — not Clerk's wrapper.
vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const TEST_TOKEN = 'vitest-gate-token-0123456789abcdef';
const DEVICE_TOKEN = 'vitest-device-token-0123456789abcdef';
const WORKER_TOKEN = 'vitest-worker-token-0123456789abcdef';
const SPECTATOR_TOKEN = 'vitest-spectator-token-0123456789abcdef';
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-gate-test-'));
writeFileSync(path.join(dataDir, 'ws-token'), `${TEST_TOKEN}\n`, 'utf-8');
writeFileSync(path.join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(
  path.join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(DEVICE_TOKEN).digest('hex')}\n`,
  'utf-8',
);
writeFileSync(
  path.join(dataDir, 'broadcast-spectator-tokens'),
  `${createHash('sha256').update(SPECTATOR_TOKEN).digest('hex')}\n`,
  'utf-8',
);
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { panelGateMiddleware } = await import('@/middleware');

function gatedRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  // Remote-principal fixtures use the allowed local authority and retain
  // their remote peer identity, as requests forwarded by the relay do.
  const target = new URL(url);
  const headers = { ...options.headers };
  if (target.hostname === '192.168.1.50') {
    headers['x-o8-client-addr'] ??= target.hostname;
    target.hostname = 'localhost';
    headers.host = target.host;
  }
  return new NextRequest(target, { method: options.method ?? 'GET', headers });
}

describe('panelGateMiddleware — Broadcast spectator capability', () => {
  const authorization = `Bearer ${SPECTATOR_TOKEN}`;

  it('allows only the exact spectator read routes and refuses every write', () => {
    for (const pathname of [
      '/api/broadcast/commentary',
      '/api/broadcast/events',
      '/api/broadcast/snapshot',
      '/api/orchestrator/truth',
    ]) {
      expect(panelGateMiddleware(gatedRequest(`http://localhost:3001${pathname}`, {
        headers: { authorization },
      })).status).toBe(200);
      expect(panelGateMiddleware(gatedRequest(`http://localhost:3001${pathname}`, {
        method: 'HEAD',
        headers: { authorization },
      })).status).toBe(200);
      expect(panelGateMiddleware(gatedRequest(`http://localhost:3001${pathname}`, {
        method: 'POST',
        headers: { authorization },
      })).status).toBe(403);
    }
    expect(panelGateMiddleware(gatedRequest('http://localhost:3001/api/broadcast/tokens', {
      method: 'POST',
      headers: { authorization },
    })).status).toBe(403);
    expect(panelGateMiddleware(gatedRequest('http://localhost:3001/api/broadcast/post', {
      method: 'POST',
      headers: { authorization },
    })).status).toBe(403);
    expect(panelGateMiddleware(gatedRequest('http://localhost:3001/api/broadcast/say', {
      method: 'POST',
      headers: { authorization },
    })).status).toBe(403);
    expect(panelGateMiddleware(gatedRequest('http://localhost:3001/api/lanes', {
      method: 'POST',
      headers: { authorization },
    })).status).toBe(403);
    expect(panelGateMiddleware(gatedRequest('http://localhost:3001/api/panel/repos', {
      headers: { authorization },
    })).status).toBe(403);
    expect(panelGateMiddleware(gatedRequest('http://localhost:3001/api/mobile/enroll', {
      method: 'POST',
      headers: { authorization },
    })).status).toBe(403);
    expect(panelGateMiddleware(gatedRequest('http://localhost:3001/api/worker/event', {
      method: 'POST',
      headers: { authorization },
    })).status).toBe(403);
  });

  it('serves an unprivileged Broadcast shell stamped for root-layout isolation', () => {
    const response = panelGateMiddleware(gatedRequest('http://192.168.1.50:3001/broadcast', {
      headers: { host: '192.168.1.50:3001' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-request-x-o8-broadcast-surface')).toBe('1');
  });
});

describe('panelGateMiddleware — loopback trust', () => {
  it('rejects curl-style loopback requests without an operator credential', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/panel/repos', {
        headers: { host: 'localhost:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects LAN requests with no token', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/repos', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/v2/files (repo file WRITE surface) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/v2/files', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/v2/context/files (chat context git-exec sink) against cross-origin', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/v2/context/files?q=x', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/panel/file-io (arbitrary-path canvas file card) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/file-io?path=/etc/hosts', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/panel/app/relaunch (desktop restart request) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/app/relaunch', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/browser/agent (embedded-browser verb bridge) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/browser/agent', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/browser/engine/view (headless-Chrome live view) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/browser/engine/view?scope=operator', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/canvas/intent (canvas intent bus) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/canvas/intent', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('requires the operator ws-token for /api/mcp even on loopback', () => {
    const denied = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:3001/api/mcp', {
        method: 'POST',
        headers: { host: '127.0.0.1:3001', 'x-o8-client-addr': '127.0.0.1' },
      }),
    );
    const allowed = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:3001/api/mcp', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3001',
          'x-o8-client-addr': '127.0.0.1',
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      }),
    );
    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });

  it('requires the ws-token for a non-loopback /api/mcp caller', () => {
    const denied = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mcp', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001', 'x-o8-client-addr': '192.168.1.50' },
      }),
    );
    const allowed = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mcp', {
        method: 'POST',
        headers: {
          host: '192.168.1.50:3001',
          'x-o8-client-addr': '192.168.1.50',
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      }),
    );
    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });

  it('rejects a hostile browser origin without an operator credential', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:3001/api/mcp', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3001',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'https://evil.example',
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('gates /api/orchestrator/steer-packet (extracted layer-3 steer mutation) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/orchestrator/steer-packet', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it.each([
    ['/api/orchestrator/ui-loop', 'GET'],
    ['/api/orchestrator/ui-loop/steer', 'POST'],
  ])('gates the Design Mode warm-loop route against LAN: %s', (pathname, method) => {
    const res = panelGateMiddleware(
      gatedRequest(`http://192.168.1.50:3001${pathname}`, {
        method,
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/voice/realtime/session (mints OpenAI realtime tokens on the operator key) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/voice/realtime/session', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates the Codex app-server realtime lifecycle and event poll against LAN', () => {
    for (const method of ['GET', 'POST']) {
      const res = panelGateMiddleware(
        gatedRequest('http://192.168.1.50:3001/api/voice/realtime/codex', {
          method,
          headers: { host: '192.168.1.50:3001' },
        }),
      );
      expect(res.status).toBe(401);
    }
  });

  it('gates /api/mobile/symon/session (Agent-mode ephemeral-token mint) against LAN without a token', () => {
    // The phone reaches this with the paired Bearer ws-token; a bare LAN request
    // is denied (mint runs on the operator's BYOK OpenAI key).
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/symon/session', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('passes /api/mobile/symon/session with the paired Bearer ws-token (the phone path)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/symon/session', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001', authorization: `Bearer ${TEST_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('passes the Symon text-session mint with the operator bearer', () => {
    expect(panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/symon/text-session', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001', authorization: `Bearer ${TEST_TOKEN}` },
      }),
    ).status).toBe(200);
  });

  it('gates /api/mobile/symon/tool (internal ws-server → Next tool relay) against LAN', () => {
    // Not phone-facing; the ws-server reaches it over loopback with the ws-token.
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/symon/tool', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('requires the operator bearer for the loopback ws-server relay', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/mobile/symon/tool', {
        method: 'POST',
        headers: { host: 'localhost:3001', authorization: `Bearer ${TEST_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('gates /api/telemetry/crash (renderer crash sink) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/telemetry/crash', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('requires the operator bearer for loopback renderer crash reports', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/telemetry/crash', {
        method: 'POST',
        headers: { host: 'localhost:3001', authorization: `Bearer ${TEST_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('gates /api/invites (beta founding-invite codes) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/invites', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('passes /api/browser/proxy from loopback (the in-webview iframe is loopback)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A3005', {
        headers: { host: 'localhost:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('now GATES /api/browser/proxy against LAN (RF-4: was the SSRF entry point)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A3001', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('does not treat the Tauri origin as an operator credential', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/orchestrator/threads', {
        headers: { host: 'localhost:3001', origin: 'tauri://localhost' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('does not treat the WebView2 shell origin as an operator credential', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/orchestrator/threads', {
        headers: { host: 'localhost:3001', origin: 'http://tauri.localhost' },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('panelGateMiddleware — socket truth is authoritative', () => {
  it('rejects a known-LAN socket even when every other header is spoofed loopback', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/panel/repos', {
        headers: {
          'x-o8-client-addr': '192.168.1.50',
          host: 'localhost:3001',
          origin: 'http://localhost:3001',
          'sec-fetch-site': 'same-origin',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('does not treat a known-loopback socket as an operator credential', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/repos', {
        headers: {
          'x-o8-client-addr': '::ffff:127.0.0.1',
          host: '192.168.1.50:3001',
        },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('panelGateMiddleware — bearer token fallback for LAN clients', () => {
  it('passes with the correct ws-token as a Bearer header', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/inbox', {
        headers: {
          host: '192.168.1.50:3001',
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects HTTP query-string credentials', () => {
    const res = panelGateMiddleware(
      gatedRequest(`http://192.168.1.50:3001/api/mobile/inbox?token=${TEST_TOKEN}`, {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/inbox', {
        headers: {
          host: '192.168.1.50:3001',
          authorization: 'Bearer wrong-token-with-the-same-length00',
        },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('panelGateMiddleware — worker capability scope', () => {
  function workerRequest(pathname: string, method = 'GET') {
    return panelGateMiddleware(gatedRequest(`http://192.168.1.50:3001${pathname}`, {
      method,
      headers: {
        host: '192.168.1.50:3001',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
    }));
  }

  it('allows workers to read and mutate the named lease surface', () => {
    expect(workerRequest('/api/leases', 'GET').status).toBe(200);
    expect(workerRequest('/api/leases', 'POST').status).toBe(200);
  });

  it('allows only the worker observation proposal method through the global gate', () => {
    expect(workerRequest('/api/cortex/proposals', 'POST').status).toBe(200);
    expect(workerRequest('/api/cortex/proposals', 'GET').status).toBe(403);
    expect(workerRequest('/api/cortex/proposals', 'DELETE').status).toBe(403);
  });

  it('admits only POST on the packet scope escape hatch', () => {
    expect(workerRequest('/api/lanes/lane-owned/scope', 'GET').status).toBe(200);
    expect(workerRequest('/api/lanes/lane-owned/scope', 'POST').status).toBe(200);
    expect(workerRequest('/api/lanes/lane-owned/scope', 'DELETE').status).toBe(403);
    expect(workerRequest('/api/lanes/lane-owned/diff', 'POST').status).toBe(403);
  });

  it('keeps ungranted lease methods and operator mutations closed to workers', () => {
    expect(workerRequest('/api/leases', 'DELETE').status).toBe(403);
    expect(workerRequest('/api/orchestrator/merge', 'POST').status).toBe(403);
    expect(workerRequest('/api/broadcast/say', 'POST').status).toBe(403);
  });

  it('admits only the bounded scheduled-speech route for handler-level automation proof', () => {
    expect(workerRequest('/api/broadcast/automation-say', 'POST').status).toBe(200);
    expect(workerRequest('/api/broadcast/automation-say', 'GET').status).toBe(403);
    expect(workerRequest('/api/broadcast/calendar', 'POST').status).toBe(403);
  });
});

describe('panelGateMiddleware — per-device capability scope', () => {
  function deviceRequest(pathname: string, method = 'GET') {
    return panelGateMiddleware(gatedRequest(`http://192.168.1.50:3001${pathname}`, {
      method,
      headers: {
        host: '192.168.1.50:3001',
        authorization: `Bearer ${DEVICE_TOKEN}`,
      },
    }));
  }

  it('allows the mobile API family', () => {
    expect(deviceRequest('/api/mobile/inbox').status).toBe(200);
    expect(deviceRequest('/api/mobile/symon/text-session', 'POST').status).toBe(200);
  });

  it('allows the explicit mobile approval capability', () => {
    expect(deviceRequest('/api/panel/approvals', 'POST').status).toBe(200);
  });

  it('allows a paired phone to read and cancel its Symon watches, and nothing else', () => {
    // Read + cancel only. Registering a watch stays inside a voice turn, where
    // it cards, so no method beyond these two reaches the phone's watch surface.
    expect(deviceRequest('/api/mobile/symon/watches', 'GET').status).toBe(200);
    expect(deviceRequest('/api/mobile/symon/watches/watch_abc123', 'DELETE').status).toBe(200);
    expect(deviceRequest('/api/mobile/symon/watches', 'POST').status).toBe(403);
    expect(deviceRequest('/api/mobile/symon/watches', 'DELETE').status).toBe(403);
    expect(deviceRequest('/api/mobile/symon/watches/watch_abc123', 'POST').status).toBe(403);
    expect(deviceRequest('/api/mobile/symon/watches/watch_abc123', 'GET').status).toBe(403);
  });

  it('refuses an unauthenticated caller on both Symon watch paths', () => {
    for (const [pathname, method] of [
      ['/api/mobile/symon/watches', 'GET'],
      ['/api/mobile/symon/watches/watch_abc123', 'DELETE'],
    ] as const) {
      expect(panelGateMiddleware(gatedRequest(`http://192.168.1.50:3001${pathname}`, {
        method,
        headers: { host: '192.168.1.50:3001' },
      })).status).toBe(401);
    }
  });

  it.each([
    ['/api/mobile/terminal-sessions', 'GET'],
    ['/api/mobile/terminal-input', 'POST'],
    ['/api/orchestrator/steer-packet', 'POST'],
  ])('allows the mobile terminal + layer-3 steer capabilities: %s', (pathname, method) => {
    // Managed remote access: the phone lists/types into live PTYs and steers a
    // packet over the encrypted relay, which forwards the per-device bearer.
    expect(deviceRequest(pathname, method).status).toBe(200);
  });

  it.each([
    ['/api/symon/mcp/tools', 'GET'],
    ['/api/symon/mcp/call', 'POST'],
  ])('refuses paired devices direct access to Symon MCP tools: %s', (pathname, method) => {
    expect(deviceRequest(pathname, method).status).toBe(403);
  });

  it('allows the Ask generative-surface stream to enrolled devices', () => {
    // The o8/Life "Ask" surface streams from /api/mobile/genui/stream; it was
    // absent from the device allowlist, so a paired phone got a 403 "Device
    // token is not authorized for this endpoint" on every Ask turn.
    expect(deviceRequest('/api/mobile/genui/stream', 'POST').status).toBe(200);
  });

  it.each([
    ['/api/repo-spec', 'GET'],
    ['/api/repo-spec', 'PUT'],
    ['/api/repo-spec/asset', 'POST'],
    ['/api/runtime/inventory', 'GET'],
    ['/api/worktrees/diff', 'GET'],
    ['/api/worktrees/diff-summary', 'GET'],
    ['/api/dictation/transcribe', 'POST'],
    ['/api/tts', 'POST'],
    ['/api/panel/projects', 'GET'],
    ['/api/panel/search', 'GET'],
  ])(
    'allows the phone-facing surfaces reached outside /api/mobile/*: %s %s',
    (pathname, method) => {
      // Repo o8.md notes, fleet inventory, review diffs, dictation/TTS, projects
      // + search — each previously 403'd the phone at the middleware.
      expect(deviceRequest(pathname, method).status).toBe(200);
    },
  );

  it.each([
    ['/api/repo-spec', 'DELETE'],
    ['/api/runtime/inventory', 'POST'],
    ['/api/worktrees/diff', 'POST'],
    ['/api/panel/projects', 'POST'],
  ])(
    'still denies non-granted methods on the new surfaces: %s %s',
    (pathname, method) => {
      expect(deviceRequest(pathname, method).status).toBe(403);
    },
  );

  it.each([
    ['/api/mobile/devices', 'GET'],
    ['/api/mobile/devices/revoke', 'POST'],
    ['/api/mobile/push-url', 'POST'],
    ['/api/mobile/symon/tool', 'POST'],
    ['/api/mobile/symon/text-turn', 'POST'],
    ['/api/mobile/ws-token', 'GET'],
    ['/api/mobile/some-future-route', 'POST'],
  ])('denies operator/internal mobile routes to a paired device: %s', (pathname, method) => {
    expect(deviceRequest(pathname, method).status).toBe(403);
  });

  it.each([
    '/api/browser/agent',
    '/api/panel/file-io?path=/etc/hosts',
    '/api/panel/github-device',
    '/api/setup/mcp-servers',
    '/api/orchestrator/merge',
    '/api/leases',
  ])('denies device credentials outside the mobile capability set: %s', (pathname) => {
    expect(deviceRequest(pathname, 'POST').status).toBe(403);
  });
});

describe('panelGateMiddleware — allowlists and bypasses', () => {
  it('gates setup GETs because they expose machine configuration', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/setup/status', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates setup identity GETs from cross-origin callers', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/setup/identity', {
        headers: { host: '192.168.1.50:3001', origin: 'https://example.com' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still gates setup identity non-GETs from LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/setup/identity', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001', origin: 'https://example.com' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('still gates setup WRITES from LAN (config-write CSRF protection)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/setup/claude-desktop', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('allows the mobile push public key (needed before any pairing)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/push/public-key', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('allows the nonce-signed mobile pairing discovery probe without a bearer', () => {
    // The phone probes bounded candidate ports before it knows which listener
    // is its paired desktop, so this request cannot carry its device bearer.
    // The route's E2EE identity signature, not middleware auth, makes the
    // public response safe to trust.
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:47122/api/mobile/pairing-discovery?nonce=nonce-for-the-paired-phone', {
        headers: { host: '192.168.1.50:47122' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('allows /api/mobile/enroll POST from LAN (#5 bootstrap — handler auths the enroll code)', () => {
    // An unpaired phone has no bearer token yet; enrollment bypasses the gate and
    // the route handler requires a valid single-use enroll code instead.
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/enroll', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('still gates the rest of /api/mobile/* from LAN without a token (#5 — only enroll is open)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/devices', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('bypasses worker-protocol routes (they run their own bearer auth)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/worker/poll', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('bypasses the HMAC-verified GitHub webhook (external caller, self-auth)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/github/webhook', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('panelGateMiddleware — default-deny (RF-2: no fail-open)', () => {
  it('denies a previously-ungated state route from LAN (/api/board)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/board?repo=x', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('denies an UNLISTED /api route from LAN (proves the default is deny, not pass)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/some-future-route-nobody-gated', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('denies an unlisted route from loopback without an operator credential', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/some-future-route-nobody-gated', {
        method: 'POST',
        headers: { host: 'localhost:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('allows an unlisted route only with the exact operator bearer', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/some-future-route-nobody-gated', {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('panelGateMiddleware — o8.md inline images (file-asset loopback-read, 2026-07-31 regression)', () => {
  // Spec-panel images render as plain <img src="/api/panel/file-asset?…"> —
  // an <img> tag CANNOT attach a bearer. The mobile-auth hardening removed
  // blanket loopback trust and every inline o8.md image silently 401'd.
  // These replay the REAL webview <img> request shape through the gate.

  it('passes the webview <img> shape (same-origin subresource on socket-truth loopback)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/panel/file-asset?workspace=%2Frepo&path=o8-assets%2Fa.png', {
        headers: {
          host: '127.0.0.1:47100',
          'sec-fetch-site': 'same-origin',
          'x-o8-client-addr': '127.0.0.1',
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('still denies file-asset from a LAN socket (socket truth wins)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/panel/file-asset?workspace=%2Frepo&path=o8-assets%2Fa.png', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '192.168.1.50',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still denies file-asset from a hostile Origin even on loopback', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/panel/file-asset?workspace=%2Frepo&path=o8-assets%2Fa.png', {
        headers: {
          host: '127.0.0.1:47100',
          origin: 'https://evil.example',
          'x-o8-client-addr': '127.0.0.1',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still denies non-GET file-asset requests even from loopback', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/panel/file-asset?workspace=%2Frepo&path=o8-assets%2Fa.png', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
        },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('panelGateMiddleware — boot-gate identity probe (v0.1.600 stuck-boot regression)', () => {
  // The packaged boot page (out/frontend/index.html, served by the Tauri shell)
  // probes GET /api/setup/identity to find its own server before navigating to
  // /dashboard. It is static HTML — it CANNOT attach a bearer. Hardening #1562
  // removed the blanket /api/setup/* allowlist and took this probe down with
  // it: every packaged boot of v0.1.600 stalled on the boot screen. These
  // replay the REAL request shapes end to end through the gate.

  it('passes the packaged boot probe (tauri origin + socket-truth loopback)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        headers: {
          host: '127.0.0.1:47100',
          origin: 'tauri://localhost',
          'x-o8-client-addr': '127.0.0.1',
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('passes a bare loopback GET (curl / dev-shape, no origin, no sec-fetch)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:3001/api/setup/identity', {
        headers: { host: '127.0.0.1:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('still denies the identity probe from LAN (socket truth wins)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '192.168.1.50',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still denies the identity probe from a LAN host in dev (no socket truth)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/setup/identity', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still denies non-GET identity requests even from loopback', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('other setup GETs stay gated from loopback without a bearer (#1562 posture)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/status', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  // Adversarial review 2026-07-15: a malicious page the user has open can fetch
  // 127.0.0.1, which rides a LOOPBACK socket — socket truth alone would stamp it
  // trusted and (because the identity route sets ACAO:*) leak instance/boot ids.
  it('DENIES the identity probe from a hostile cross-site Origin over a loopback socket', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'https://evil.example',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still passes the identity probe from the tauri boot-page origin', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'tauri://localhost',
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  // WebView2 (Windows) serves the shell from `http(s)://tauri.localhost`
  // instead of the tauri:// scheme — the same boot probe must pass there
  // (#1673 audit: the gate rejected the app's own requests on Windows).
  it('passes the identity probe from the WebView2 boot-page origin (http)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'http://tauri.localhost',
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('passes the identity probe from the WebView2 boot-page origin (https)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'https://tauri.localhost',
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  // Browsers resolve EVERY `*.localhost` name to loopback, so the shell
  // origins are an exact-match set, never a suffix rule — a cross-site page
  // served from another .localhost name stays outside the gate.
  it('rejects the identity probe from a non-shell .localhost origin', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/setup/identity', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'http://evil.localhost',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still passes the identity probe from a loopback page origin (dev bridge)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:3001/api/setup/identity', {
        headers: {
          host: '127.0.0.1:3001',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'http://localhost:3001',
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('also denies the browser/proxy loopback-read from a hostile Origin (defense in depth)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://127.0.0.1:47100/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A3005', {
        headers: {
          host: '127.0.0.1:47100',
          'x-o8-client-addr': '127.0.0.1',
          origin: 'https://evil.example',
        },
      }),
    );
    expect(res.status).toBe(401);
  });
});
