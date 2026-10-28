import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), serve: vi.fn(), config: vi.fn(), access: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ accessSync: mocks.access, constants: { X_OK: 1 } }));
vi.mock('./serve.js', () => ({ runServe: mocks.serve }));
vi.mock('../config.js', () => ({ resolveConfig: mocks.config, resolveCliDataDir: () => '/fixture', resolveCliTokenFiles: () => ['/fixture/ws-token'] }));
import { runNext } from './next.js';

const config = (port = 49123) => ({ apiBase: `http://127.0.0.1:${port}`, dataDir: '/fixture',
  token: 'fixture-operator', source: { token: 'data-dir' } });
let health: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ['O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN']) vi.stubEnv(key, '');
  mocks.config.mockReturnValue(config());
  mocks.serve.mockResolvedValue(0);
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
  health = vi.fn().mockResolvedValue(Response.json({ product: 'o8' }));
  vi.stubGlobal('fetch', health);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('o8 next standalone launcher', () => {
  it('defaults to the installed binary and reuses a healthy local server', async () => {
    expect(await runNext([])).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledWith('/Applications/o8.app/Contents/MacOS/o8-next',
      ['--enable-next', '--app-shell', '--server', config().apiBase, '--shell-state', '/fixture/next-shell.json'],
      expect.objectContaining({ shell: false, env: expect.objectContaining({ O8_NEXT_API_TOKEN: 'fixture-operator' }) }));
    expect(health).toHaveBeenCalledWith(`${config().apiBase}/api/setup/identity`, expect.objectContaining({ redirect: 'error' }));
    expect(mocks.serve).not.toHaveBeenCalled();
  });

  it('starts serve before launch and reloads its published port and credential', async () => {
    health.mockRejectedValueOnce(new Error('refused'));
    mocks.serve.mockImplementation(async () => { mocks.config.mockReturnValue({ ...config(49124), token: 'new-fixture-token' }); return 0; });
    expect(await runNext(['--binary', '/fixture/native'])).toBe(0);
    expect(mocks.serve).toHaveBeenCalledWith({ human: true, verbose: false }, undefined, []);
    expect(mocks.spawn).toHaveBeenCalledWith('/fixture/native', expect.arrayContaining(['http://127.0.0.1:49124']),
      expect.objectContaining({ env: expect.objectContaining({ O8_NEXT_API_TOKEN: 'new-fixture-token' }) }));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Starting o8 serve'));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('o8 serve stop'));
  });

  it('does not launch a window when startup fails', async () => {
    health.mockRejectedValue(new Error('refused'));
    mocks.serve.mockRejectedValue(new Error('startup deadline'));
    await expect(runNext([])).rejects.toThrow(/Could not start.*startup deadline/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a non-o8 health response and requires health after serve returns', async () => {
    health.mockResolvedValue(Response.json({ product: 'other' }));
    await expect(runNext([])).rejects.toThrow(/healthy/);
    expect(mocks.serve).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('keeps explicit fixture launches attach-only', async () => {
    await runNext(['--enable-next', '--binary', '/fixture/native', '--app-shell', '--server', 'http://127.0.0.1:49125']);
    expect(mocks.serve).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
  });

  it('reports a missing binary before starting a server', async () => {
    mocks.access.mockImplementationOnce(() => { throw new Error('missing'); });
    await expect(runNext([])).rejects.toThrow(/native binary/);
    expect(mocks.serve).not.toHaveBeenCalled();
  });
});
