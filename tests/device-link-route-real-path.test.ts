import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));

const owner = 'user_link';
const idleExpiresAt = '2027-01-01T00:00:00.000Z';
let dataDir: string;
let server: Server;
let calls: Array<{ path: string; authorization?: string; body: unknown }>;
let secret: string;
let rotated: string;
let ticket: string;
let bearer: string;
let approved: boolean;
let renewStatus: number;

function request(body: unknown) {
  return new Request('http://localhost/api/panel/auth/device/link', {
    method: 'POST',
    headers: { host: 'localhost', 'x-o8-client-addr': '127.0.0.1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const derived = () => `o8d_${createHmac('sha256', secret).update('o8-device-link-v1').digest('base64url')}`;
const paths = () => calls.map((call) => call.path);
async function post(body: unknown) {
  const { POST } = await import('@/app/api/panel/auth/device/link/route');
  const response = await POST(request(body));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('code-based sign-in through fake account and identity services and persisted state', () => {
  beforeEach(async () => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), 'o8-device-link-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', `pk_test_${Buffer.from('accounts.example.test$').toString('base64')}`);
    secret = `o8l_${randomBytes(32).toString('base64url')}`;
    rotated = `o8d_${randomBytes(32).toString('base64url')}`;
    ticket = randomBytes(24).toString('hex');
    // Only the issued-at claim is read locally; the services own verification.
    bearer = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), sub: owner })).toString('base64url')}.x`;
    approved = false;
    renewStatus = 200;
    calls = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const path = req.url!;
      const body = raw.startsWith('{') ? JSON.parse(raw) : raw;
      calls.push({ path, authorization: req.headers.authorization, body });
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (path === '/account/device/link') {
        return reply(200, { deviceCode: secret, userCode: 'BCDF-GHJK', verificationUrl: 'https://o8.run/link',
          expiresAt: new Date(Date.now() + 600_000).toISOString(), interval: 5 });
      }
      if (path === '/account/device/link/poll') {
        return reply(200, approved ? { status: 'approved', clerkUserId: owner, idleExpiresAt } : { status: 'pending' });
      }
      if (path === '/account/device/renew') {
        return renewStatus === 200
          ? reply(200, { ticket, deviceToken: rotated, clerkUserId: owner, idleExpiresAt })
          : reply(renewStatus, { error: 'device_session_invalid' });
      }
      if (path.startsWith('/v1/client/sign_ins')) {
        return reply(200, { response: { status: 'complete', created_session_id: 'sess_1' },
          client: { sessions: [{ id: 'sess_1', last_active_token: { jwt: bearer } }] } });
      }
      if (path === '/account/license') return reply(404, { error: 'no_license' });
      if (path === '/machines/register') {
        return reply(200, { machineId: 'machine_link', deviceCap: 3, devices: [] });
      }
      return reply(200, { ok: true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    vi.stubEnv('O8_PROXY_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('O8_IDENTITY_URL', `http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('shows a code, waits for approval, then signs in and joins the account', async () => {
    const started = await post({ action: 'start' });
    expect(started.body).toMatchObject({ ok: true, userCode: 'BCDF-GHJK', verificationUrl: 'https://o8.run/link' });
    // The one-time secret never leaves the server process.
    expect(JSON.stringify(started.body)).not.toContain(secret);
    expect(calls[0]!.body).toMatchObject({ platform: process.platform });
    expect(typeof (calls[0]!.body as { installId?: unknown }).installId).toBe('string');

    expect((await post({ action: 'poll' })).body).toEqual({ ok: true, status: 'pending' });
    expect(existsSync(join(dataDir, 'device-session.json'))).toBe(false);

    approved = true;
    const done = await post({ action: 'poll' });
    expect(done.body).toMatchObject({ ok: true, status: 'signed-in', connected: true, machineId: 'machine_link' });

    // The derived credential renews, the ticket becomes an account session, and
    // that session syncs the account and registers this machine.
    const renew = calls.find((call) => call.path === '/account/device/renew')!;
    expect(renew.authorization).toBe(`Bearer ${derived()}`);
    expect(calls.find((call) => call.path.startsWith('/v1/client/sign_ins'))!.body).toContain(`ticket=${ticket}`);
    expect(calls.find((call) => call.path === '/account/license')!.authorization).toBe(`Bearer ${bearer}`);
    expect(calls.find((call) => call.path === '/machines/register')!.authorization).toBe(`Bearer ${bearer}`);
    expect(paths()).not.toContain('/account/device/revoke');

    const stored = JSON.parse(readFileSync(join(dataDir, 'device-session.json'), 'utf8'));
    expect(stored).toMatchObject({ token: rotated, clerkUserId: owner });
    expect(JSON.parse(readFileSync(join(dataDir, 'connect-attach.json'), 'utf8'))).toEqual({ enabled: true });
    // The approval was read once: another poll has nothing pending.
    expect((await post({ action: 'poll' })).body).toEqual({ ok: true, status: 'none' });
  });

  it('never sends a stored credential to revoke when a later step fails', async () => {
    await post({ action: 'start' });
    approved = true;
    renewStatus = 503;
    const failed = await post({ action: 'poll' });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ ok: false, status: 'failed', reason: 'device_renew_failed' });
    expect(paths()).not.toContain('/account/device/revoke');
    expect(existsSync(join(dataDir, 'connect-attach.json'))).toBe(false);
  });

  it('revokes an approved credential it cannot use', async () => {
    vi.stubEnv('O8_IDENTITY_URL', '');
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    await post({ action: 'start' });
    approved = true;
    const failed = await post({ action: 'poll' });
    expect(failed.body).toMatchObject({ ok: false, reason: 'sign_in_unavailable' });
    expect(calls.find((call) => call.path === '/account/device/revoke')!.authorization).toBe(`Bearer ${derived()}`);
    expect(existsSync(join(dataDir, 'device-session.json'))).toBe(false);
  });

  it('refuses a caller that is not on this computer', async () => {
    const { POST } = await import('@/app/api/panel/auth/device/link/route');
    const response = await POST(new Request('http://o8.example/api/panel/auth/device/link', {
      method: 'POST', headers: { host: 'o8.example', 'x-o8-client-addr': '203.0.113.9', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    }));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
