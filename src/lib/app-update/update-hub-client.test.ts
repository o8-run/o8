import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAllUpdates, registerAppUpdateCheck, refreshCliUpdateView, synchronizeConnectedClis } from './update-hub-client';

const record = (runtimeId: string, status = 'current') => ({ runtimeId, label: runtimeId, status, installedVersion: '2.0.1',
  latestVersion: '2.0.2', selectedPath: `/fixture/${runtimeId}`, updateUrl: 'https://example.test' });
const report = (status = 'current') => ({ tools: [record('codex', status), record('claude-code', 'not-installed'), record('grok', 'not-installed')] });
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
describe('the connected CLI synchronization gate', () => {
  it('shares one check and updates only installed connected providers before verifying the final report', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('update-available')))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded' })).mockResolvedValueOnce(Response.json(report()));
    await Promise.all([synchronizeConnectedClis('codex'), synchronizeConnectedClis('codex')]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"runtime":"codex"}' });
  });
  it.each(['failed', 'outdated', 'disappeared'])('rejects a %s final check without claiming CLI success', async failure => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('update-available')))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded' }))
      .mockResolvedValueOnce(failure === 'failed' ? new Response(null, { status: 503 }) : Response.json(report(failure === 'outdated' ? 'update-available' : 'not-installed')));
    await expect(synchronizeConnectedClis('codex')).rejects.toThrow();
  });
  it('rejects incomplete reports and unavailable release checks without running an installer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools: [] }));
    await expect(synchronizeConnectedClis('codex')).rejects.toThrow('incomplete');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('unknown')));
    await expect(synchronizeConnectedClis('codex')).rejects.toThrow('release');
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('rejects duplicate discovery rows before selecting an installation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools: [record('codex', 'update-available'), record('codex', 'current')] }));
    await expect(synchronizeConnectedClis('codex')).rejects.toThrow('incomplete');
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('updates the explicitly chosen CLI when another release is unknown', async () => {
    const tools = [record('codex', 'unknown'), record('claude-code', 'update-available'), record('grok', 'not-installed')];
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools }))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded' }))
      .mockResolvedValueOnce(Response.json({ tools: tools.map(t => t.runtimeId === 'claude-code' ? { ...t, status: 'current' } : t) }));
    await synchronizeConnectedClis('claude-code');
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe('{"runtime":"claude-code"}');
  });
  it('keeps an installer refusal local to the selected tool', async () => {
    const tools = [record('codex', 'update-available'), record('claude-code', 'update-available')];
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools }))
      .mockResolvedValueOnce(Response.json({ error: 'Active sessions' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ tools }));
    await expect(synchronizeConnectedClis('codex')).rejects.toThrow('Active sessions');
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST').map(([, options]) => options?.body))
      .toEqual(['{"runtime":"codex"}']);
  });
  it('requires a named tool before checking or updating anything', async () => {
    await expect(synchronizeConnectedClis()).rejects.toThrow('Choose a tool'); expect(fetch).not.toHaveBeenCalled();
  });
  it('updates only the requested CLI even when another provider is unverifiable', async () => {
    const tools = [record('codex', 'update-available'), record('claude-code', 'unknown'), record('grok', 'not-installed')];
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools }))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded' }))
      .mockResolvedValueOnce(Response.json({ tools: tools.map(t => t.runtimeId === 'codex' ? { ...t, status: 'current' } : t) }));
    await synchronizeConnectedClis('codex');
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST').map(([, options]) => options?.body))
      .toEqual(['{"runtime":"codex"}']);
  });
  it('does not reinstall a requested CLI that is already current', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report()));
    await synchronizeConnectedClis('codex');
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBeUndefined();
  });
  it('keeps a read-only refresh separate from the install action', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('update-available')));
    await refreshCliUpdateView(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBeUndefined();
  });
});

describe('explicit app and CLI update checks', () => {
  it('checks both sources once for simultaneous clicks without running an installer', async () => {
    const app = vi.fn(async () => ({ version: null }));
    const unregister = registerAppUpdateCheck(app);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report()));
    try {
      expect(await Promise.all([checkAllUpdates(), checkAllUpdates()])).toEqual([
        { hasUpdates: false, incomplete: false }, { hasUpdates: false, incomplete: false },
      ]);
      expect(app).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/setup/cli-updates?refresh=1');
      expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
    } finally { unregister(); }
  });
  it.each(['app', 'cli'])('reports an available %s update', async source => {
    const unregister = registerAppUpdateCheck(async () => ({ version: source === 'app' ? '0.1.902' : null }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report(source === 'cli' ? 'update-available' : 'current')));
    try { expect(await checkAllUpdates()).toEqual({ hasUpdates: true, incomplete: false }); }
    finally { unregister(); }
  });
  it.each(['unknown', 'failed', 'missing'])('does not report all current when a CLI check is %s', async state => {
    const unregister = registerAppUpdateCheck(async () => ({ version: null }));
    vi.mocked(fetch).mockResolvedValueOnce(state === 'failed' ? new Response(null, { status: 503 })
      : Response.json(state === 'missing' ? { tools: [] } : report('unknown')));
    try { expect((await checkAllUpdates()).incomplete).toBe(true); }
    finally { unregister(); }
  });
  it('retains the latest checker when an earlier owner unmounts and marks app errors incomplete', async () => {
    const old = registerAppUpdateCheck(async () => ({ version: '0.1.900' }));
    const current = registerAppUpdateCheck(async () => { throw new Error('unavailable'); });
    old(); vi.mocked(fetch).mockResolvedValueOnce(Response.json(report()));
    expect(await checkAllUpdates()).toEqual({ hasUpdates: false, incomplete: true });
    current(); vi.mocked(fetch).mockResolvedValueOnce(Response.json(report()));
    expect((await checkAllUpdates()).incomplete).toBe(true);
  });
  it('ignores uninstalled tools and the retired CLI when deciding whether updates are ready', async () => {
    const unregister = registerAppUpdateCheck(async () => ({ version: null }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools: [...report().tools, record('gemini', 'update-available')] }));
    try { expect(await checkAllUpdates()).toEqual({ hasUpdates: false, incomplete: false }); }
    finally { unregister(); }
  });
});
