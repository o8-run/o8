import { afterEach, describe, expect, it, vi } from 'vitest';

const resolver = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  resolveCli: resolver,
  invalidateCliCache: invalidate,
  compareCliVersions: (a: string, b: string) => {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index]! - right[index]!;
    }
    return 0;
  },
}));

import { GET } from './route';

afterEach(() => {
  resolver.mockReset(); invalidate.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('flushes discovery headers and found rows before a slower version probe completes', async () => {
  let release!: (value: unknown) => void;
  const slow = new Promise(resolve => { release = resolve; });
  resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
    if (runtimeId === 'grok') return slow;
    if (runtimeId === 'codex') return { path: '/selected/codex', version: '1.0.0', source: 'env' };
    throw new Error('not installed');
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '1.0.1' })));
  const pending = GET(new Request('http://localhost/api/setup/cli-updates', { headers: { Accept: 'text/event-stream' } }));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); })]);
    clearTimeout(timer);
    expect(response, 'discovery withheld headers until every probe finished').not.toBeNull();
    expect(response!.headers.get('content-type')).toContain('text/event-stream');
    reader = response!.body!.getReader();
    const decoder = new TextDecoder(); let text = '';
    const early = (async () => {
      while (!text.includes('"runtimeId":"codex"')) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    })();
    await Promise.race([early, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A found tool was withheld')), 3000); })]);
    clearTimeout(timer);
    expect(text).toContain('event: progress');
    expect(text).toContain('"runtimeId":"codex"');
    expect(text).not.toContain('event: result');
    release({ path: '/selected/grok', version: '1.0.0', source: 'env' });
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
    expect(text).toContain('event: result');
    expect(text).toContain('"runtimeId":"grok"');
  } finally {
    clearTimeout(timer); release({ path: '/selected/grok', version: '1.0.0', source: 'env' });
    await reader?.cancel().catch(() => {}); reader?.releaseLock(); await pending;
  }
});

it('releases the discovery heartbeat when the requesting view disconnects', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const waiting = new Promise((_, reject) => { release = () => reject(new Error('not installed')); });
  resolver.mockImplementation(() => waiting);
  const abort = new AbortController();
  const before = vi.getTimerCount();
  const response = await GET(new Request('http://localhost/api/setup/cli-updates', {
    headers: { Accept: 'text/event-stream' }, signal: abort.signal,
  }));
  const reader = response.body!.getReader();
  try {
    await reader.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver).toHaveBeenCalled();
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(before);
  } finally {
    release(); await vi.advanceTimersByTimeAsync(0);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
});

describe('GET /api/setup/cli-updates', () => {
  it('reprobes a cached unknown installed version on an explicit refresh', async () => {
    let version: string | undefined;
    resolver.mockImplementation(async () => ({ path: '/selected/codex', version, source: 'env' }));
    invalidate.mockImplementation(() => { version = '0.157.1'; });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '0.157.1' })));
    const first = await GET(new Request('http://localhost/api/setup/cli-updates?runtime=codex'));
    expect((await first.json()).tools[0].status).toBe('unknown');
    const refreshed = await GET(new Request('http://localhost/api/setup/cli-updates?runtime=codex&refresh=1'));
    expect((await refreshed.json()).tools[0].status).toBe('current');
    expect(invalidate).toHaveBeenCalledWith('codex');
  });
  it('compares the selected launch binary with a newer package release', async () => {
    resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
      if (runtimeId !== 'codex') throw new Error('not installed');
      return { path: '/selected/codex', version: '0.154.0', source: 'env', detectedAt: Date.now() };
    });
    const fetchMock = vi.fn(async () => Response.json({ version: '0.157.1' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new Request('http://localhost/api/setup/cli-updates?refresh=1'));
    const report = await response.json();
    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: 'codex', envOverride: 'O8_CODEX_BIN' }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40openai%2Fcodex/latest',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(report.tools.find((tool: { runtimeId: string }) => tool.runtimeId === 'codex')).toMatchObject({
      selectedPath: '/selected/codex',
      installedVersion: '0.154.0',
      latestVersion: '0.157.1',
      status: 'update-available',
    });
  });

  it('does not claim an update when the release check fails', async () => {
    resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
      if (runtimeId !== 'codex') throw new Error('not installed');
      return { path: '/selected/codex', version: '0.157.1', source: 'which', detectedAt: Date.now() };
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const response = await GET(new Request('http://localhost/api/setup/cli-updates?refresh=1'));
    const report = await response.json();
    expect(report.tools.find((tool: { runtimeId: string }) => tool.runtimeId === 'codex').status).toBe('unknown');
  });

  it('checks Antigravity through agy and its own release channel', async () => {
    resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
      if (runtimeId !== 'antigravity') throw new Error('not installed');
      return { path: '/selected/agy', version: '1.2.9', source: 'env', detectedAt: Date.now() };
    });
    const fetchMock = vi.fn(async () => Response.json({ tag_name: '1.2.11' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new Request('http://localhost/api/setup/cli-updates?refresh=1'));
    const report = await response.json();
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: 'antigravity', binaryName: 'agy', envOverride: 'O8_ANTIGRAVITY_BIN',
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(report.tools.find((tool: { runtimeId: string }) => tool.runtimeId === 'antigravity')).toMatchObject({
      selectedPath: '/selected/agy', installedVersion: '1.2.9', latestVersion: '1.2.11',
      status: 'update-available',
    });
  });
});

it('includes the actual OpenCode 2 binary and compares its complete prerelease channel version', async () => {
  resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
    if (runtimeId !== 'opencode') throw new Error('not installed');
    return { path: '/selected/opencode2', version: '0.0.0-beta-100', source: 'env' };
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '0.0.0-beta-200' })));
  const response = await GET(new Request('http://localhost/api/setup/cli-updates?runtime=opencode&refresh=1'));
  expect(response.status).toBe(200);
  expect((await response.json()).tools[0]).toMatchObject({ runtimeId: 'opencode', installedVersion: '0.0.0-beta-100', latestVersion: '0.0.0-beta-200', status: 'update-available' });
  expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ binaryName: 'opencode2', envOverride: 'O8_OPENCODE_BIN' }));
});
