import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

it('preserves overlapping panel mutations, interleaved reads and valid on-disk JSON with Next absent', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-ledger-concurrency-')));
  const file = join(root, 'projects.json');
  const projects = Array.from({ length: 8 }, (_, index) => ({ id: `legacy-${index}`, name: `Legacy ${index}`,
    repoPaths: [], createdAt: '2026-01-01T00:00:00.000Z', color: '#5b8db8' }));
  writeFileSync(file, JSON.stringify({ projects, activeProjectId: projects[0].id }), { mode: 0o600 });
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    server = await startParityReference({ directory: root, productFrontDoor: true, nativeHttp: true, o8d: false,
      preload: join(process.cwd(), 'tests/fixtures/projects-ledger-slow-write.cjs') });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const call = async (path = '', method = 'GET', body?: unknown) => {
      const response = await fetch(origin + '/api/panel/projects' + path, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const refused = await fetch(origin + '/api/panel/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(61) }) });
    expect(refused.status).toBe(400); // A rejected mutation must not poison the queue.
    const invalid: string[] = []; let samples = 0;
    sampler = setInterval(() => {
      samples += 1;
      try { JSON.parse(readFileSync(file, 'utf8')); } catch (error) { invalid.push(String(error)); }
    }, 1);
    const reads: Array<{ projects: Array<{ id: string }> }> = [];
    const reader = (async () => { for (let index = 0; index < 12; index += 1) reads.push(await call()); })();
    await Promise.all([
      call('', 'POST', { name: 'Created A' }), call('', 'POST', { name: 'Created B' }),
      call('/legacy-0', 'PATCH', { name: 'Renamed A' }), call('/legacy-1', 'PATCH', { name: 'Renamed B' }),
      call('/legacy-2', 'PATCH', { color: '#7fa68f' }), call('/legacy-3', 'PATCH', { color: '#a39565' }),
      call('/legacy-4', 'PATCH', { color: '#a37b7b' }), call('/active', 'POST', { projectId: 'legacy-5' }),
    ]);
    await reader;
    clearInterval(sampler); sampler = undefined;
    const final = await call();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    for (const ledger of [disk, final]) {
      for (const [id, expected] of [['legacy-0', { name: 'Renamed A' }], ['legacy-1', { name: 'Renamed B' }],
        ['legacy-2', { color: '#7fa68f' }], ['legacy-3', { color: '#a39565' }], ['legacy-4', { color: '#a37b7b' }]] as const) {
        expect.soft(ledger.projects.find((project: { id: string }) => project.id === id)).toMatchObject(expected);
      }
      expect.soft(ledger.projects.map((project: { name: string }) => project.name)).toEqual(expect.arrayContaining(['Created A', 'Created B']));
      // Creates also select their new project; verify a subsequent explicit switch.
    }
    await call('/active', 'POST', { projectId: 'legacy-5' });
    expect((await call()).activeProjectId).toBe('legacy-5');
    expect(JSON.parse(readFileSync(file, 'utf8')).activeProjectId).toBe('legacy-5');
    expect.soft(reads.every(ledger => projects.every(project => ledger.projects.some(row => row.id === project.id)))).toBe(true);
    expect(samples).toBeGreaterThan(0);
    expect.soft(invalid).toEqual([]);
  } finally {
    clearInterval(sampler); await server?.stop(); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it('shares the queue with public repo repoints while preserving raw path-writer records', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-ledger-repoint-')));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync } = await import('node:fs');
    const paths = ['old', 'next', 'last'].map(name => join(root, name));
    for (const path of paths) { mkdirSync(path); execFileSync('git', ['init', '-q', path]); }
    server = await startParityReference({ directory: root, productFrontDoor: true, nativeHttp: true, o8d: false,
      preload: join(process.cwd(), 'tests/fixtures/projects-ledger-slow-write.cjs') });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const call = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch(origin + path, { method, headers, body: JSON.stringify(body) });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    };
    const { repo } = await call('/api/panel/repos', { action: 'add', localPath: paths[0] });
    const { project } = await call('/api/projects', { name: 'Linked', repoIds: [repo.id] });
    const file = join(root, 'projects.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    const linked = ledger.projects.find((entry: { id: string; sqliteProjectId?: string }) => entry.id === project.id || entry.sqliteProjectId === project.id);
    expect(linked).toBeDefined();
    linked.repoPaths = [paths[0], ` ${paths[0]} `, paths[1], 17]; linked.opaque = { keep: true };
    ledger.opaque = 'keep'; ledger.projects.push(null, { broken: true });
    writeFileSync(file, JSON.stringify(ledger));
    await call('/api/panel/repos', { action: 'update', id: repo.id, localPath: paths[1] });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.opaque).toBe('keep');
    expect(raw.projects).toContainEqual({ broken: true }); expect(raw.projects).toContain(null);
    expect(raw.projects.find((entry: { id: string } | null) => entry?.id === linked.id)).toMatchObject({ opaque: { keep: true }, repoPaths: [paths[1], 17] });
    // Existing higher-level project normalization is unchanged; retain ordinary
    // records for the overlapping mutation proof after the raw preservation proof.
    raw.projects = raw.projects.filter((entry: { id?: string } | null) => entry?.id);
    raw.projects.find((entry: { id: string }) => entry.id === linked.id).repoPaths = [paths[1]];
    writeFileSync(file, JSON.stringify(raw));
    const repoint = call('/api/panel/repos', { action: 'update', id: repo.id, localPath: paths[2] });
    await vi.waitFor(() => expect(existsSync(join(root, 'repoint-ready'))).toBe(true));
    const colour = call(`/api/panel/projects/${linked.id}`, { color: '#a39565' }, 'PATCH');
    await new Promise(resolve => setTimeout(resolve, 100));
    writeFileSync(join(root, 'repoint-release'), 'release');
    await Promise.all([repoint, colour]);
    const final = JSON.parse(readFileSync(file, 'utf8'));
    expect(final.projects.find((entry: { id: string }) => entry.id === linked.id)).toMatchObject({ repoPaths: [paths[2]], color: '#a39565' });
  } finally { await server?.stop(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
