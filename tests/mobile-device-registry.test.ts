import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import { createEnrollCode, consumeEnrollCode, hashToken } from '@/lib/mobile/device-registry';

/**
 * #5 mobile E2EE — enroll-code lifecycle + token hashing (the pure, DB-free
 * half). The DB-backed registry round-trip (enroll → resolve → revoke) is
 * covered by tests/smoke/mobile-device-registry-smoke.ts against a temp DB.
 */
describe('#5 enroll codes', () => {
  const NOW = 1_000_000;

  it('mints a code that validates once then is consumed (single-use)', () => {
    const code = createEnrollCode(NOW);
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeEnrollCode(code, NOW + 1000)).toBe(true);
    expect(consumeEnrollCode(code, NOW + 2000)).toBe(false); // already consumed
  });

  it('rejects an expired code (past the 5-min TTL)', () => {
    const code = createEnrollCode(NOW);
    expect(consumeEnrollCode(code, NOW + 5 * 60 * 1000 + 1)).toBe(false);
  });

  it('rejects unknown / empty codes', () => {
    expect(consumeEnrollCode('deadbeef', NOW)).toBe(false);
    expect(consumeEnrollCode('', NOW)).toBe(false);
  });
});

describe('#5 token hashing', () => {
  it('is deterministic sha256 hex and never echoes the token', () => {
    const h = hashToken('abc123');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashToken('abc123'));
    expect(h).not.toContain('abc123');
    expect(hashToken('abc123')).not.toBe(hashToken('abc124'));
  });
});


import * as fs from 'node:fs';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { enrollDevice, listDevices, revokeDevice, resolveDeviceByToken, isTokenRevoked, syncTokenFile } from '@/lib/mobile/device-registry';
import { closeDb, getSqlite } from '@/lib/db';
import middleware, { panelGateMiddleware } from '@/middleware';
import { handleTokenProjectionRequest } from '@/lib/mobile/token-projection-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as tokenProjection from '@/lib/mobile/device-token-file';
import { MOBILE_DEVICE_TOKENS_PATH } from '@/lib/mobile/device-token-file';

function repairProjection(authorized = true): Response {
  let status = 0;
  const response = { writeHead: (code: number) => { status = code; }, end: () => {} };
  const request = { url: '/internal/mobile-token-projection', method: 'POST' };
  expect(handleTokenProjectionRequest(request as IncomingMessage, response as unknown as ServerResponse, () => authorized)).toBe(true);
  return new Response(null, { status });
}

const req = (token: string) => new NextRequest('http://localhost:3001/api/mobile/ripple/resolve', {
  method: 'POST', headers: { authorization: `Bearer ${token}` },
});
afterAll(() => closeDb());

describe('durable device pairing through persisted registry and HTTP middleware', () => {
  it('migrates an existing persisted schema even with current migration markers', () => {
    const device = enrollDevice({ identityPublicKey: 'migration-phone' });
    getSqlite().exec('ALTER TABLE mobile_devices DROP COLUMN last_paired_at');
    closeDb();
    expect(resolveDeviceByToken(device.deviceToken)?.id).toBe(device.deviceId);
    expect(enrollDevice({ identityPublicKey: 'migration-phone' }).deviceId).toBe(device.deviceId);
  });

  it('denies projection repair without operator authentication', () => {
    expect(repairProjection(false).status).toBe(401);
  });
  it('rotates the active identity in place and never revives a revoked row', () => {
    const first = enrollDevice({ identityPublicKey: 'same-phone' });
    const second = enrollDevice({ identityPublicKey: 'same-phone' });
    expect(second.deviceId).toBe(first.deviceId);
    expect(listDevices().filter(device => device.identityPublicKey === 'same-phone')).toHaveLength(1);
    expect(resolveDeviceByToken(first.deviceToken)).toBeNull();
    expect(resolveDeviceByToken(second.deviceToken)?.lastPairedAt).toBeTruthy();
    revokeDevice(first.deviceId);
    const third = enrollDevice({ identityPublicKey: 'same-phone' });
    expect(third.deviceId).not.toBe(first.deviceId);
    expect(isTokenRevoked(second.deviceToken)).toBe(true);
    expect(listDevices().filter(device => device.identityPublicKey === 'same-phone')).toHaveLength(1);
  });

  it('retains the previous pairing if credential rotation cannot be published', () => {
    const first = enrollDevice({ identityPublicKey: 'publication-phone' });
    const write = vi.spyOn(tokenProjection, 'writeActiveTokenHashes').mockImplementation(() => { throw new Error('publication unavailable'); });
    try {
      expect(() => enrollDevice({ identityPublicKey: 'publication-phone' })).toThrow('publication unavailable');
      expect(resolveDeviceByToken(first.deviceToken)?.id).toBe(first.deviceId);
    } finally { write.mockRestore(); syncTokenFile(); }
  });

  it('groups historical duplicates and revokes all of their credentials', () => {
    const first = enrollDevice({ identityPublicKey: 'historical-phone' });
    getSqlite().prepare('INSERT INTO mobile_devices (id, token_hash, identity_public_key) VALUES (?, ?, ?)')
      .run('historical-duplicate', hashToken('duplicate-fixture-credential'), 'historical-phone');
    syncTokenFile();
    expect(listDevices().filter(device => device.identityPublicKey === 'historical-phone')).toHaveLength(1);
    expect(revokeDevice(first.deviceId)).toBe(true);
    expect(isTokenRevoked(first.deviceToken)).toBe(true);
    expect(isTokenRevoked('duplicate-fixture-credential')).toBe(true);
  });

  it('distinguishes a positively matched revoked credential from unknown credentials', async () => {
    const device = enrollDevice({ identityPublicKey: 'revocation-phone' });
    revokeDevice(device.deviceId);
    expect(await panelGateMiddleware(req(device.deviceToken)).json()).toMatchObject({ code: 'device_revoked' });
    const unknown = panelGateMiddleware(req('unknown-credential'));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).not.toHaveProperty('code');
  });

  it('repairs missing and unreadable projections through the real middleware entry', async () => {
    const device = enrollDevice({ identityPublicKey: 'repair-phone' });
    writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'ws-token'), 'a'.repeat(64));
    // The internal HTTP adapter invokes this same registry operation. No server is launched.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return repairProjection();
    });
    try {
      rmSync(MOBILE_DEVICE_TOKENS_PATH);
      expect((await middleware(req(device.deviceToken)))!.status).toBe(200);
      const originalRead = fs.readFileSync;
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
        if (file === MOBILE_DEVICE_TOKENS_PATH) {
          readSpy.mockRestore();
          throw Object.assign(new Error('unreadable fixture'), { code: 'EACCES' });
        }
        return Reflect.apply(originalRead, fs, [file, ...args]);
      }) as typeof fs.readFileSync);
      expect((await middleware(req(device.deviceToken)))!.status).toBe(200);
      expect(statSync(MOBILE_DEVICE_TOKENS_PATH).mode & 0o777).toBe(0o600);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { fetchMock.mockRestore(); }
  });

  it('answers an unknown bearer with 401 when no projection exists and nothing can rebuild it', async () => {
    rmSync(MOBILE_DEVICE_TOKENS_PATH, { force: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no registry owner'));
    try {
      expect((await middleware(req('unknown-credential')))!.status).toBe(401);
      expect(panelGateMiddleware(req('unknown-credential')).status).toBe(401);
    } finally { fetchMock.mockRestore(); writeFileSync(MOBILE_DEVICE_TOKENS_PATH, '', { mode: 0o600 }); }
  });

  it('returns 503 with a retry hint when canonical storage cannot rebuild', async () => {
    getSqlite();
    rmSync(MOBILE_DEVICE_TOKENS_PATH);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const spy = vi.spyOn(await import('@/lib/db'), 'getSqlite').mockImplementation(() => { throw new Error('storage unavailable'); });
      try { return repairProjection(); }
      finally { spy.mockRestore(); }
    });
    try {
      const response = (await middleware(req('unresolved-credential')))!;
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('2');
    } finally { fetchMock.mockRestore(); syncTokenFile(); }
  });
});

describe('persistent server identity', () => {
  it('preserves invalid and unreadable existing identity files', async () => {
    const { E2EE_IDENTITY_PATH, getServerIdentity } = await import('@/lib/mobile/e2ee-identity');
    writeFileSync(E2EE_IDENTITY_PATH, 'invalid identity fixture');
    expect(() => getServerIdentity()).toThrow('Server identity is unavailable');
    expect(readFileSync(E2EE_IDENTITY_PATH, 'utf8')).toBe('invalid identity fixture');
    const { POST } = await import('@/app/api/mobile/enroll/route');
    const enrollment = await POST(new NextRequest('http://localhost:3001/api/mobile/enroll', {
      method: 'POST', body: JSON.stringify({ enroll: createEnrollCode(Date.now()), identityPublicKey: 'blocked-identity' }),
    }));
    expect(enrollment.status).toBe(503);
    expect(await enrollment.json()).toMatchObject({ code: 'server_identity_unavailable' });
    expect(listDevices().some(device => device.identityPublicKey === 'blocked-identity')).toBe(false);
    renameSync(E2EE_IDENTITY_PATH, `${E2EE_IDENTITY_PATH}.fixture`);
    mkdirSync(E2EE_IDENTITY_PATH);
    expect(() => getServerIdentity()).toThrow('Server identity is unavailable');
    expect(statSync(E2EE_IDENTITY_PATH).isDirectory()).toBe(true);
    rmSync(E2EE_IDENTITY_PATH, { recursive: true });
    rmSync(`${E2EE_IDENTITY_PATH}.fixture`);
    const first = getServerIdentity().publicKeyB64;
    expect(getServerIdentity().publicKeyB64).toBe(first);
  });
});
