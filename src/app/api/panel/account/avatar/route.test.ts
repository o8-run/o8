import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'operator',
  signedOutAt: null as number | null,
  identity: 'user_local' as string | null,
  direct: null as { avatarUrl: string | null } | null,
  rows: [] as Array<{ avatarUrl: string | null }>,
}));

vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipalContext: () => ({ role: mocks.role }),
}));
vi.mock('@/lib/auth/sign-out-marker', () => ({ readAuthSignedOutAt: () => mocks.signedOutAt }));
vi.mock('@/lib/github-broker/managed', () => ({ readActiveIdentity: () => mocks.identity }));
vi.mock('@/lib/db/users', () => ({ findUserByClerkId: () => mocks.direct }));
vi.mock('@/lib/db/schema', () => ({ users: { avatarUrl: 'avatar_url' } }));
vi.mock('@/lib/db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ limit: () => ({ all: () => mocks.rows }) }) }) }),
}));

import { GET } from './route';

const PHOTO = 'https://avatars.githubusercontent.com/u/1?v=4';
const request = () => new Request('http://127.0.0.1/api/panel/account/avatar');
const image = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

describe('GET /api/panel/account/avatar', () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    Object.assign(mocks, { role: 'operator', signedOutAt: null, identity: 'user_local', direct: null, rows: [] });
    upstream.mockReset();
    upstream.mockImplementation(async () => image());
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('serves the signed-in account photo as bytes', async () => {
    mocks.direct = { avatarUrl: PHOTO };
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('uses the only local account when the identity matches no row', async () => {
    mocks.rows = [{ avatarUrl: PHOTO }];
    expect((await GET(request())).status).toBe(200);
  });

  it('never guesses between several local accounts', async () => {
    mocks.rows = [{ avatarUrl: PHOTO }, { avatarUrl: 'https://avatars.githubusercontent.com/u/2' }];
    expect((await GET(request())).status).toBe(204);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses anyone but the operator', async () => {
    mocks.role = 'worker';
    mocks.direct = { avatarUrl: PHOTO };
    expect((await GET(request())).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('shows no photo after sign-out', async () => {
    mocks.signedOutAt = 1;
    mocks.direct = { avatarUrl: PHOTO };
    expect((await GET(request())).status).toBe(204);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example/a.png',
    'http://avatars.githubusercontent.com/u/1',
    'http://127.0.0.1:8080/internal',
    'not a url',
  ])('only fetches known https photo hosts: %s', async (stored) => {
    mocks.direct = { avatarUrl: stored };
    expect((await GET(request())).status).toBe(204);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses redirects and anything that is not an image', async () => {
    mocks.direct = { avatarUrl: PHOTO };
    upstream.mockImplementation(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    expect((await GET(request())).status).toBe(204);
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  // An 8 MiB photo body that streams on demand, counting how much of it the handler pulls.
  const endless = (chunk = 64 * 1024, headers: Record<string, string> = {}) => {
    const pulled = { bytes: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled.bytes >= 8 * 1024 * 1024) return controller.close();
        pulled.bytes += chunk;
        controller.enqueue(new Uint8Array(chunk));
      },
    }, { highWaterMark: 0 });
    return { pulled, response: new Response(body, { headers: { 'content-type': 'image/png', ...headers } }) };
  };

  it('stops reading an oversized photo at the 2 MiB cap', async () => {
    mocks.direct = { avatarUrl: PHOTO };
    const { pulled, response } = endless();
    upstream.mockImplementation(async () => response);
    expect((await GET(request())).status).toBe(204);
    expect(pulled.bytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 64 * 1024);
  });

  it('refuses a declared oversized photo without reading it', async () => {
    mocks.direct = { avatarUrl: PHOTO };
    const { pulled, response } = endless(64 * 1024, { 'content-length': String(3 * 1024 * 1024) });
    upstream.mockImplementation(async () => response);
    expect((await GET(request())).status).toBe(204);
    expect(pulled.bytes).toBe(0);
  });

  it('still serves a photo of exactly 2 MiB', async () => {
    mocks.direct = { avatarUrl: PHOTO };
    upstream.mockImplementation(async () => new Response(new Uint8Array(2 * 1024 * 1024).fill(7), { headers: { 'content-type': 'image/png' } }));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
  });

  it('falls back to no photo when the fetch fails', async () => {
    mocks.direct = { avatarUrl: PHOTO };
    upstream.mockRejectedValue(new Error('offline'));
    expect((await GET(request())).status).toBe(204);
  });
});
