import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ execFile: vi.fn(), listening: '', unreadableCwd: new Set<string>() }));
vi.mock('@/lib/providers/child-process', async () => {
  const { promisify: custom } = await import('node:util');
  const execFile = Object.assign(() => undefined, { [custom.custom]: fixture.execFile });
  return { execFile, execFileReadOnly: execFile };
});

// Ports nothing listens on, so each probe is refused at once and the row stays a service.
const listening = (rows: Array<[pid: number, name: string, port: number]>) =>
  rows.map(([pid, name, port]) => `p${pid}\nc${name}\nn*:${port}`).join('\n');

function answer(file: string, args: string[]) {
  if (file === 'lsof' && args.includes('-sTCP:LISTEN')) return { stdout: fixture.listening, stderr: '' };
  if (file === 'netstat') {
    const ports = [...fixture.listening.matchAll(/^n\*:(\d+)$/gm)].map(match => match[1]);
    return { stdout: `Current listen queue sizes (qlen/incqlen/maxqlen)\nListen         Local Address\n${ports.map(port => `0/0/128        *.${port}`).join('\n')}`, stderr: '' };
  }
  const pids = String(args[args.indexOf('-p') + 1]).split(',');
  if (file === 'lsof') return { stdout: pids.filter(pid => !fixture.unreadableCwd.has(pid)).map(pid => `p${pid}\nn/work/app-${pid}`).join('\n'), stderr: '' };
  return { stdout: pids.map(pid => `${pid} node server-${pid}.js`).join('\n'), stderr: '' };
}

const lookups = () => fixture.execFile.mock.calls.filter(([file, args]) => file === 'ps' || (file === 'lsof' && !args.includes('-sTCP:LISTEN')));
const fullScans = () => fixture.execFile.mock.calls.filter(([file, args]) => file === 'lsof' && args.includes('-sTCP:LISTEN')).length;
const onPlatform = (platform: NodeJS.Platform) => vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);

let now = 1_000_000;
beforeEach(() => {
  vi.resetModules();
  fixture.execFile.mockReset();
  fixture.execFile.mockImplementation(async (file: string, args: string[]) => answer(file, args));
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  fixture.unreadableCwd.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/panel/ports', () => {
  it('looks up a listening process once and rescans only the listening sockets', async () => {
    fixture.listening = listening([[901, 'node', 59_991], [902, 'node', 59_992]]);
    const { GET } = await import('./route');

    const first = await (await GET()).json();
    expect(first.ports.map((p: { port: number; cwd: string }) => [p.port, p.cwd])).toEqual([[59_991, '/work/app-901'], [59_992, '/work/app-902']]);
    expect(lookups()).toHaveLength(2);

    now += 11_000;
    fixture.execFile.mockClear();
    const second = await (await GET()).json();
    expect(second.ports).toEqual(first.ports);
    expect(fixture.execFile).toHaveBeenCalledTimes(1);
    expect(lookups()).toHaveLength(0);
  });

  it('looks up a new or reused pid again', async () => {
    fixture.listening = listening([[901, 'node', 59_991]]);
    const { GET } = await import('./route');
    await GET();

    now += 11_000;
    fixture.execFile.mockClear();
    fixture.listening = listening([[901, 'python3', 59_991], [903, 'node', 59_993]]);
    await GET();
    expect(lookups().map(([file, args]) => [file, args[args.indexOf('-p') + 1]])).toEqual([['lsof', '901,903'], ['ps', '901,903']]);
  });

  it('on macOS, reuses the last scan while the listening addresses read the same', async () => {
    onPlatform('darwin');
    fixture.listening = listening([[901, 'node', 59_991]]);
    const { GET } = await import('./route');
    const first = await (await GET()).json();
    expect(fullScans()).toBe(1);

    // Unchanged listeners: netstat alone, no lsof or ps.
    for (let poll = 0; poll < 4; poll += 1) {
      now += 11_000;
      expect(await (await GET()).json()).toEqual(first);
    }
    expect(fullScans()).toBe(1);
    expect(fixture.execFile.mock.calls.filter(([file]) => file !== 'netstat')).toHaveLength(3);

    // A new listener is scanned at once.
    now += 11_000;
    fixture.listening = listening([[901, 'node', 59_991], [903, 'node', 59_993]]);
    expect((await (await GET()).json()).ports.map((p: { port: number }) => p.port)).toEqual([59_991, 59_993]);
    expect(fullScans()).toBe(2);

    // An unchanged set is still rescanned after a minute, which refreshes the probes.
    for (let poll = 0; poll < 6; poll += 1) { now += 11_000; await GET(); }
    expect(fullScans()).toBe(3);
  });

  it('looks up a process whose cwd cannot be read again only after five minutes', async () => {
    onPlatform('linux');
    fixture.unreadableCwd.add('902');
    fixture.listening = listening([[901, 'node', 59_991], [902, 'node', 59_992]]);
    const { GET } = await import('./route');
    await GET();
    expect(lookups().map(([file, args]) => [file, args[args.indexOf('-p') + 1]])).toEqual([['lsof', '901,902'], ['ps', '901,902']]);

    fixture.execFile.mockClear();
    now += 11_000;
    await GET();
    expect(lookups()).toHaveLength(0);

    fixture.execFile.mockClear();
    now += 5 * 60_000;
    await GET();
    expect(lookups().map(([file, args]) => [file, args[args.indexOf('-p') + 1]])).toEqual([['lsof', '902'], ['ps', '902']]);
  });

  it('shares one scan between requests that miss the cache together', async () => {
    fixture.listening = listening([[901, 'node', 59_991]]);
    const { GET } = await import('./route');
    const bodies = await Promise.all([GET(), GET(), GET()].map(async r => (await r).json()));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(fixture.execFile.mock.calls.filter(([, args]) => args.includes('-sTCP:LISTEN'))).toHaveLength(1);
  });

  it('classifies a redirect from its headers without using a pooled connection', async () => {
    const requests: Array<{ method?: string; path?: string; connection?: string; background?: string | string[] }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, path: request.url, connection: request.headers.connection,
        background: request.headers['x-o8-background'] });
      response.writeHead(302, { Location: '/redirect-target' });
      response.flushHeaders();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a fixture TCP port');
      fixture.listening = listening([[901, 'node', address.port]]);
      const pooledFetch = vi.spyOn(globalThis, 'fetch');
      const { GET } = await import('./route');

      const result = await (await GET()).json();

      expect(result.ports).toEqual([expect.objectContaining({ port: address.port, kind: 'page' })]);
      // A probe of o8's own port is the server's own request, not client activity.
      expect(requests).toEqual([{ method: 'GET', path: '/', connection: 'close', background: '1' }]);
      expect(pooledFetch).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
