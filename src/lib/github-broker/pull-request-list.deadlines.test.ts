import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  account: 'example',
  config: null as null | Record<string, unknown>,
}));
vi.mock('./env', () => ({ getGitHubAppConfig: () => fixture.config, requireGitHubAppConfig: () => fixture.config }));
vi.mock('./managed', () => ({
  readManagedGithubToken: () => ({ token: 'fixture-token', installationId: 5169, accountLogin: fixture.account }),
  readActiveIdentity: () => 'fixture-owner', readSignInEpoch: () => 'fixture-epoch',
}));

let GET: typeof import('@/app/api/panel/prs/route').GET;
const pull = {
  number: 7, node_id: 'node-7', title: 'A change', user: { login: 'author', avatar_url: '' },
  state: 'open', merged_at: null, head: { ref: 'work' }, base: { ref: 'main' },
  updated_at: '2026-10-31T12:00:00Z', created_at: '2026-10-31T11:00:00Z',
  html_url: 'https://github.com/example/deadline/pull/7', labels: [],
};

beforeEach(async () => {
  vi.resetModules();
  fixture.account = 'example';
  fixture.config = null;
  ({ GET } = await import('@/app/api/panel/prs/route'));
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Fixture deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const read = (signal?: AbortSignal) => GET(new Request('http://fixture.invalid/api/panel/prs?repo=example/deadline&view=list', { signal }));
function capture<T>(promise: Promise<T>) {
  const settled = vi.fn();
  void promise.then(value => settled(value), error => settled(error));
  return settled;
}

it.each([true, false])('bounds each list route independently and lets Retry recover after a hung fetch (authenticated=%s)', async authenticated => {
  fixture.account = authenticated ? 'example' : 'other';
  const request = vi.fn((_url: unknown, _init?: RequestInit): Promise<Response> => new Promise(() => {}));
  vi.stubGlobal('fetch', request);
  const first = capture(read());
  await vi.advanceTimersByTimeAsync(5_000);
  const joining = capture(read());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(first).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }));
  expect(joining).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(joining).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }));
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  request.mockImplementation(async url => String(url).endsWith('/graphql')
    ? Response.json({ data: { nodes: [] } }) : Response.json([pull]));
  const retried = await read();
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ prs: [{ number: 7 }], statsUnavailable: true });
});

it('returns a bounded route error during a stalled response body and retries without a stale validator', async () => {
  const request = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response(new ReadableStream(), { headers: { etag: '"unfinished"' } })));
  vi.stubGlobal('fetch', request);
  const result = capture(read());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }));
  request.mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).has('if-none-match')).toBe(false);
    return Response.json(String(url).endsWith('/graphql') ? { data: { nodes: [] } } : [pull]);
  });
  expect((await read()).status).toBe(200);
});

it('cancels public fallback during repository confirmation without caching a late denial', async () => {
  let finish!: (response: Response) => void;
  const metadata = new Promise<Response>(resolve => { finish = resolve; });
  let recovering = false;
  const request = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (new Headers(init?.headers).has('authorization')) return new Response(null, { status: 404 });
    if (String(url).endsWith('/repos/example/deadline')) return metadata;
    return recovering ? Response.json([pull]) : new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', request);
  const result = capture(read());
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(3); // Installation read, anonymous read, metadata confirmation.
  await vi.advanceTimersByTimeAsync(15_000);
  expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }));
  expect(request.mock.calls[2][1]?.signal?.aborted).toBe(true);
  finish(new Response(null, { status: 404 }));
  await vi.advanceTimersByTimeAsync(0);
  recovering = true;
  expect((await read()).status).toBe(200);
});

it.each(['headers', 'body'])('retains a usable list when optional GraphQL summary %s never settle', async stalled => {
  const request = vi.fn((url: unknown, _init?: RequestInit): Promise<Response> => {
    if (!String(url).endsWith('/graphql')) return Promise.resolve(Response.json([pull]));
    return stalled === 'headers' ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream()));
  });
  vi.stubGlobal('fetch', request);
  const result = capture(read());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
  const response = result.mock.calls[0][0] as Response;
  expect(await response.json()).toMatchObject({ prs: [{ number: 7, additions: null, requestedReviewers: null }], statsUnavailable: true });
});

it.each(['installation', 'token'])('bounds stalled %s resolution before the shared read and prevents late dispatch', async stage => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fixture.config = { appId: '42', privateKey, apiBaseUrl: 'https://api.github.com' };
  let finish!: (response: Response) => void;
  const hung = new Promise<Response>(resolve => { finish = resolve; });
  let recovering = false;
  const request = vi.fn(async (url: unknown, _init?: RequestInit): Promise<Response> => {
    const path = String(url);
    if (path.endsWith('/installation')) return stage === 'installation' && !recovering ? hung : Response.json({ id: 55169 });
    if (path.endsWith('/access_tokens')) return stage === 'token' && !recovering ? hung : Response.json({ token: 'fixture-token', expires_at: '2030-01-01T00:00:00Z' });
    return Response.json(path.endsWith('/graphql') ? { data: { nodes: [] } } : [pull]);
  });
  vi.stubGlobal('fetch', request);
  const result = capture(read());
  await vi.waitFor(() => expect(request.mock.calls.some(([url]) => String(url).endsWith(stage === 'installation' ? '/installation' : '/access_tokens'))).toBe(true));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }));
  const dispatched = request.mock.calls.length;
  finish(Response.json(stage === 'installation' ? { id: 55169 } : { token: 'late-token', expires_at: '2030-01-01T00:00:00Z' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(dispatched);
  recovering = true;
  expect((await read()).status).toBe(200);
});
