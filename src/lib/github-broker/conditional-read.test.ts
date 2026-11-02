import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ token: 'fixture-a' }));
vi.mock('./env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('./managed', () => ({ readManagedGithubToken: () => ({ token: state.token, installationId: 7001, accountLogin: 'example' }) }));
let githubInstallationFetch: typeof import('./auth').githubInstallationFetch;

beforeEach(async () => {
  vi.resetModules();
  state.token = 'fixture-a';
  vi.useFakeTimers();
  ({ githubInstallationFetch } = await import('./auth'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>) {
  const settled = vi.fn();
  void promise.then(value => settled({ value }), error => settled({ error }));
  return settled;
}

function sharedRead(signal?: AbortSignal) {
  return githubInstallationFetch('example/deadline', '/repos/example/deadline/pulls', { signal }, { share: true });
}
it('shares real broker reads, sends conditional validators and clones the unchanged response per consumer', async () => {
  const request = vi.fn(async () => Response.json({ number: 7 }, { headers: { etag: '"fixture"' } }));
  vi.stubGlobal('fetch', request);
  const read = () => githubInstallationFetch('example/conditional', '/repos/example/conditional/pulls/7', undefined, { share: true });
  const [one, two] = await Promise.all([read(), read()]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await one.response.json()).toEqual(await two.response.json());
  request.mockImplementationOnce(async (_url?: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('if-none-match')).toBe('"fixture"');
    return new Response(null, { status: 304 });
  });
  expect(await (await read()).response.json()).toEqual({ number: 7 });
});
it('does not share validators or cached answers across credentials and never turns a refusal into success', async () => {
  const request = vi.fn(async () => Response.json({ private: 'fixture' }, { headers: { etag: '"private"' } })); vi.stubGlobal('fetch', request);
  const read = () => githubInstallationFetch('example/scope', '/repos/example/scope/pulls/1', undefined, { share: true });
  await read(); state.token = 'fixture-b';
  request.mockImplementationOnce(async (_url?: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('if-none-match')).toBeNull(); return new Response('', { status: 401 });
  });
  await expect(read()).rejects.toThrow('(401)');
});

it('releases a joining caller at its own deadline without canceling the first consumer', async () => {
  const hung = deferred<Response>();
  const request = vi.fn((_url: unknown, _init?: RequestInit) => hung.promise);
  vi.stubGlobal('fetch', request);
  const first = sharedRead();
  await vi.advanceTimersByTimeAsync(0);
  const caller = new AbortController();
  const reason = new DOMException('Caller deadline', 'TimeoutError');
  const joining = observe(sharedRead(caller.signal));
  await vi.advanceTimersByTimeAsync(0);
  caller.abort(reason);
  await vi.advanceTimersByTimeAsync(0);
  expect(joining).toHaveBeenCalledWith({ error: reason });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
  hung.resolve(Response.json({ current: true }));
  expect(await (await first).response.json()).toEqual({ current: true });
});

it('keeps a joining consumer healthy when the initiating consumer cancels', async () => {
  const hung = deferred<Response>();
  const request = vi.fn((_url: unknown, _init?: RequestInit) => hung.promise);
  vi.stubGlobal('fetch', request);
  const caller = new AbortController();
  const first = observe(sharedRead(caller.signal));
  await vi.advanceTimersByTimeAsync(0);
  const joining = sharedRead();
  await vi.advanceTimersByTimeAsync(0);
  caller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(first).toHaveBeenCalledWith({ error: caller.signal.reason });
  expect(request.mock.calls[0][1]?.signal).not.toBe(caller.signal);
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
  hung.resolve(Response.json({ healthy: true }));
  expect(await (await joining).response.json()).toEqual({ healthy: true });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['completion', 'failure'] as const)('abandons an unobserved read and fences its late %s from a newer cached answer', async late => {
  const hung = deferred<Response>();
  const request = vi.fn((_url: unknown, _init?: RequestInit) => hung.promise);
  vi.stubGlobal('fetch', request);
  const caller = new AbortController();
  const abandoned = observe(sharedRead(caller.signal));
  await vi.advanceTimersByTimeAsync(0);
  caller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(abandoned).toHaveBeenCalledWith({ error: caller.signal.reason });
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);

  request.mockResolvedValueOnce(Response.json({ version: 'new' }, { headers: { etag: '"new"' } }));
  expect(await (await sharedRead()).response.json()).toEqual({ version: 'new' });
  hung.resolve(late === 'completion'
    ? Response.json({ version: 'old' }, { headers: { etag: '"old"' } })
    : new Response(null, { status: 503 }));
  await vi.advanceTimersByTimeAsync(0);
  request.mockImplementationOnce(async (_url, init) => {
    expect(new Headers(init?.headers).get('if-none-match')).toBe('"new"');
    return new Response(null, { status: 304 });
  });
  expect(await (await sharedRead()).response.json()).toEqual({ version: 'new' });
});

it.each(['headers', 'body'])('expires stalled shared %s even without caller signals and permits a successful retry', async stalled => {
  const request = vi.fn((_url: unknown, _init?: RequestInit): Promise<Response> => stalled === 'headers'
    ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream())));
  vi.stubGlobal('fetch', request);
  const first = observe(sharedRead());
  const joining = observe(sharedRead());
  await vi.advanceTimersByTimeAsync(30_000);
  expect(first).toHaveBeenCalledWith({ error: expect.objectContaining({ name: 'TimeoutError' }) });
  expect(joining).toHaveBeenCalledWith({ error: expect.objectContaining({ name: 'TimeoutError' }) });
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  request.mockResolvedValueOnce(Response.json({ recovered: true }));
  expect(await (await sharedRead()).response.json()).toEqual({ recovered: true });
  expect(request).toHaveBeenCalledTimes(2);
});

it('handles immediate cancellation without leaving an unobserved shared rejection', async () => {
  const { sharedConditionalGitHubRead } = await import('./conditional-read');
  const caller = new AbortController();
  const result = observe(sharedConditionalGitHubRead('immediate-cancel', () => new Promise(() => {}), { signal: caller.signal }));
  caller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result).toHaveBeenCalledWith({ error: caller.signal.reason });
  expect(vi.getTimerCount()).toBe(0);
});

it('does not let a late abandoned response body replace a newer validator', async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const old = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { headers: { etag: '"old"' } });
  const request = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(old));
  vi.stubGlobal('fetch', request);
  const caller = new AbortController();
  const abandoned = observe(sharedRead(caller.signal));
  await vi.advanceTimersByTimeAsync(0);
  caller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(abandoned).toHaveBeenCalledWith({ error: caller.signal.reason });
  request.mockResolvedValueOnce(Response.json({ version: 'new' }, { headers: { etag: '"new"' } }));
  await sharedRead();
  body.enqueue(new TextEncoder().encode('{"version":"old"}'));
  body.close();
  await vi.advanceTimersByTimeAsync(0);
  request.mockImplementationOnce(async (_url, init) => {
    expect(new Headers(init?.headers).get('if-none-match')).toBe('"new"');
    return new Response(null, { status: 304 });
  });
  expect(await (await sharedRead()).response.json()).toEqual({ version: 'new' });
});

it('rejects an already canceled consumer even when a fresh snapshot is cached', async () => {
  const { sharedConditionalGitHubRead } = await import('./conditional-read');
  const request = vi.fn(async () => Response.json({ version: 1 }));
  await sharedConditionalGitHubRead('cached-abort', request, { maxAgeMs: 120_000 });
  const caller = new AbortController(); caller.abort();
  await expect(sharedConditionalGitHubRead('cached-abort', request, { maxAgeMs: 120_000, signal: caller.signal })).rejects.toBe(caller.signal.reason);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['invalid JSON', 'HTTP failure'])('drops validators after %s and shares the next successful retry', async failure => {
  const request = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(Response.json({ version: 1 }, { headers: { etag: '"old"' } })));
  vi.stubGlobal('fetch', request);
  await sharedRead();
  request.mockResolvedValueOnce(failure === 'invalid JSON' ? new Response('{broken') : new Response(null, { status: 503 }));
  await expect(sharedRead()).rejects.toThrow();
  request.mockImplementationOnce(async (_url, init) => {
    expect(new Headers(init?.headers).has('if-none-match')).toBe(false);
    return Response.json({ version: 2 });
  });
  const recovered = await Promise.all([sharedRead(), sharedRead()]);
  expect(await Promise.all(recovered.map(item => item.response.json()))).toEqual([{ version: 2 }, { version: 2 }]);
  expect(request).toHaveBeenCalledTimes(3);
});
