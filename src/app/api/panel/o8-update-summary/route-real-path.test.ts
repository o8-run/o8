import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-published-notes-route-'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.mock('server-only', () => ({}));
const request = (version: string) => new NextRequest(`http://localhost/api/panel/o8-update-summary?version=${encodeURIComponent(version)}`);
const memory = globalThis as typeof globalThis & { __o8ReleaseNotesV1?: { cache: Map<string, unknown>; pending: Map<string, unknown> } };
const route = await import('./route');
const updateState = await import('../app/update-state/route');
const { persistReleaseNotes } = await import('@/lib/app-update/release-notes');
function snapshot() {
  return ['.', ...readdirSync(directory, { recursive: true }).map(String).sort()].map(name => {
    const stat = statSync(join(directory, name));
    return { name, size: stat.size, mtime: stat.mtimeMs };
  });
}
beforeEach(() => {
  vi.stubEnv('O8_DATA_DIR', directory);
  memory.__o8ReleaseNotesV1?.cache.clear();
  vi.stubGlobal('fetch', vi.fn());
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

describe('published release notes through the real route and persisted cache', () => {
  it('GET leaves an absent data directory absent', async () => {
    const absent = join(directory, 'uninitialized', '.o8');
    vi.stubEnv('O8_DATA_DIR', absent);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.912', body: '- Unsaved public notes' }));
    const before = snapshot();
    expect(await (await route.GET(request('0.1.912'))).json()).toMatchObject({ summary: 'Unsaved public notes' });
    expect(snapshot()).toEqual(before);
  });
  it('GET leaves the full data directory unchanged on a cold cache', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.910', body: '- Published cold notes' }));
    const before = snapshot();
    const response = await route.GET(request('0.1.910'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ summary: 'Published cold notes', entries: [{ text: 'Published cold notes' }] });
    expect(snapshot()).toEqual(before);
  });
  it('GET leaves the full data directory unchanged when replacing expired notes in memory', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.911', body: '- Expired public notes' }));
    const expired = await (await route.GET(request('0.1.911'))).json();
    mkdirSync(join(directory, 'release-notes-cache'), { recursive: true });
    writeFileSync(join(directory, 'release-notes-cache/0.1.911.json'), JSON.stringify({ at: 0, notes: expired }));
    memory.__o8ReleaseNotesV1?.cache.clear();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.911', body: '- Refreshed public notes' }));
    const before = snapshot();
    expect(await (await route.GET(request('0.1.911'))).json()).toMatchObject({ summary: 'Refreshed public notes' });
    expect(snapshot()).toEqual(before);
  });
  it('reads the publisher overview and bullets without inference and persists the shared result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.904', body: '## What’s changed\n\nNavigate your work more clearly.\n\n- Clearer chat sections\n- One place for connected updates\n' }));
    const notes = await persistReleaseNotes('0.1.904');
    expect(notes).toMatchObject({ source: 'release', overview: 'Navigate your work more clearly.', summary: 'Navigate your work more clearly.',
      entries: [{ text: 'Clearer chat sections' }, { text: 'One place for connected updates' }] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('https://api.github.com/repos/hurttlocker/o8-releases/releases/tags/v0.1.904');
    memory.__o8ReleaseNotesV1?.cache.clear(); vi.mocked(fetch).mockClear();
    expect(await (await route.GET(request('0.1.904'))).json()).toEqual(notes); expect(fetch).not.toHaveBeenCalled();
  });
  it('fetches once for concurrent hovers and reuses the disk receipt after memory is cleared', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ tag_name: 'v0.1.901', published_at: '2026-10-08T12:00:00Z', body: '- Faster sidebar\n- Clear update status' }));
    const [first, second] = await Promise.all([route.GET(request('0.1.901')), persistReleaseNotes('0.1.901')]);
    expect(first.status).toBe(200); expect(second.version).toBe('0.1.901'); expect(fetch).toHaveBeenCalledTimes(1);
    const value = await first.json();
    expect(value).toMatchObject({ version: '0.1.901', source: 'release', entries: [{ text: 'Faster sidebar' }, { text: 'Clear update status' }] });
    expect(JSON.parse(readFileSync(join(directory, 'release-notes-cache/0.1.901.json'), 'utf8')).notes).toEqual(value);
    memory.__o8ReleaseNotesV1?.cache.clear(); vi.mocked(fetch).mockClear();
    expect(await (await route.GET(request('0.1.901'))).json()).toEqual(value); expect(fetch).not.toHaveBeenCalled();
  });
  it('labels the dated changelog fallback and excludes changes newer than the release', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.902', published_at: '2026-10-07T12:00:00Z', body: 'See release files.' }))
      .mockResolvedValueOnce(new Response('## 2026-10-08\n- Future change\n## 2026-10-07\n- Published change'));
    expect(await (await route.GET(request('0.1.902'))).json()).toMatchObject({ source: 'changelog', entries: [{ text: 'Published change', date: '2026-10-07' }] });
  });
  it('rejects unsafe versions without fetching and does not accept mismatched published tags', async () => {
    expect((await route.GET(request('../../commands'))).status).toBe(400); expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.1', body: '- Other release' }));
    expect((await route.GET(request('0.1.903'))).status).toBe(503);
  });
  it('does not trust a disk cache with an unrelated outbound URL', async () => {
    const file = join(directory, 'release-notes-cache/0.1.901.json');
    mkdirSync(join(directory, 'release-notes-cache'), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now(), notes: { version: '0.1.901', summary: 'Cached', entries: [], source: 'release', releaseUrl: 'https://example.test' } }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.901', body: '- Verified public release' }));
    expect((await route.GET(request('0.1.901'))).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('explicit persistence coalesces concurrent cache writes and GET reads the persisted receipt unchanged', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.913', body: '- Persisted public notes' }));
    const [notes, again] = await Promise.all([persistReleaseNotes('0.1.913'), persistReleaseNotes('0.1.913')]);
    expect(again).toEqual(notes);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(directory, 'release-notes-cache/0.1.913.json'), 'utf8')).notes).toEqual(notes);
    memory.__o8ReleaseNotesV1?.cache.clear();
    vi.mocked(fetch).mockClear();
    const before = snapshot();
    expect(await (await route.GET(request('0.1.913'))).json()).toEqual(notes);
    expect(fetch).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
  it('an available update check saves that release\'s notes on the update-state write path', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.914', body: '- Found by the update check' }));
    const response = await updateState.POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatePending: true, checkOutcome: 'available', checkedAt: new Date().toISOString(), version: '0.1.914' }) }));
    expect(response.status).toBe(200);
    const file = join(directory, 'release-notes-cache/0.1.914.json');
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
    expect(JSON.parse(readFileSync(file, 'utf8')).notes).toMatchObject({ version: '0.1.914', summary: 'Found by the update check' });
  });
});
