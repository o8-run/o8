/**
 * Real-path guard for the pairing payload's credential boundary (#1529 + the
 * mobile-auth device audit): a DEVICE principal must never receive the operator
 * ws-token or a fresh enroll code — only host/port refresh with token:''. The
 * operator/loopback QR path keeps the real token. Drives the ACTUAL GET handler
 * with the principal resolver mocked per case; the assertion FAILS on the old
 * handler that always returned getOrCreateWsToken().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  resolveRequestPrincipal: vi.fn(),
}));

vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: h.resolveRequestPrincipal }));
vi.mock('@/lib/panel/api-port', () => ({ resolvePortInfo: () => ({ apiPort: 3001, wsPort: 3002 }) }));
vi.mock('@/lib/panel/lan-ip', () => ({
  pickMobilePairingHosts: () => [{ host: '100.64.0.1', kind: 'tailscale' }],
}));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'OPERATOR-WS-TOKEN' }));
vi.mock('@/lib/mobile/e2ee-flag', () => ({ mobileE2eeEnabled: () => true }));
vi.mock('@/lib/mobile/device-registry', () => ({ createEnrollCode: () => 'ENROLL-CODE' }));
vi.mock('@/lib/mobile/e2ee-identity', () => ({ getServerIdentityPublicKey: () => 'SIDENT-PUB' }));

const { GET } = await import('./route');

function req() {
  return new NextRequest('http://127.0.0.1/api/panel/mobile-pairing');
}

beforeEach(() => h.resolveRequestPrincipal.mockReset());
afterEach(() => vi.clearAllMocks());

describe('GET /api/panel/mobile-pairing — credential boundary', () => {
  it('gives a DEVICE host/port refresh but NEVER the operator ws-token or an enroll code', async () => {
    h.resolveRequestPrincipal.mockReturnValue('device');
    const body = await (await GET(req())).json();
    expect(body.token).toBe('');
    expect(body.enroll).toBeUndefined();
    expect(body.sIdent).toBeUndefined();
    // Host/port refresh still works — that's the whole point (#1529).
    expect(body.host).toBe('100.64.0.1');
    expect(body.apiPort).toBe(3001);
    expect(body.wsPort).toBe(3002);
  });

  it('gives the operator/loopback QR path the real token + E2EE enroll', async () => {
    h.resolveRequestPrincipal.mockReturnValue('operator');
    const body = await (await GET(req())).json();
    expect(body.token).toBe('OPERATOR-WS-TOKEN');
    expect(body.enroll).toBe('ENROLL-CODE');
    expect(body.sIdent).toBe('SIDENT-PUB');
  });

  it('refuses a dispatched worker', async () => {
    h.resolveRequestPrincipal.mockReturnValue('worker');
    const res = await GET(req());
    expect(res.status).toBe(403);
  });
});

describe('GET /api/panel/mobile-pairing — LAN reachability flag', () => {
  const original = process.env.O8_LAN_ACCESS;
  afterEach(() => {
    if (original === undefined) delete process.env.O8_LAN_ACCESS;
    else process.env.O8_LAN_ACCESS = original;
  });

  it('reports lanAccess:false when the servers are loopback-only (default)', async () => {
    delete process.env.O8_LAN_ACCESS;
    h.resolveRequestPrincipal.mockReturnValue('operator');
    const body = await (await GET(req())).json();
    expect(body.lanAccess).toBe(false);
  });

  it('reports lanAccess:true when the operator opted in with O8_LAN_ACCESS=1', async () => {
    process.env.O8_LAN_ACCESS = '1';
    h.resolveRequestPrincipal.mockReturnValue('operator');
    const body = await (await GET(req())).json();
    expect(body.lanAccess).toBe(true);
  });
});
