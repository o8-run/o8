import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-cortex-owner-'));
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
// Keep the real indexer and fixture Git repo; substitute only binary availability
// and the MCP call so its in-flight transition can be observed deterministically.
vi.mock('@/lib/providers/child-process', () => import('node:child_process'));
vi.mock('@/lib/codebase-memory/binary', () => ({
  resolveCodebaseMemoryBin: () => null,
  waitForCodebaseMemoryBin: binaryWait,
}));
const tool = vi.hoisted(() => vi.fn());
const binaryWait = vi.hoisted(() => vi.fn());
vi.mock('@/lib/codebase-memory/mcp-client', () => ({ callCodebaseMemoryTool: tool }));

const codebase = await import('@/app/api/cortex/codebase-memory/route');
const diagnostics = await import('@/app/api/cortex/diagnostics/route');
const { nativeSurfaceRoutes, matchNativeHttpRoute } = await import('@/lib/ws-server/native-http-registry');

afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function snapshot() {
  return readdirSync(directory, { recursive: true }).map(String).sort().map(name => {
    const path = join(directory, name);
    const stat = statSync(path, { bigint: true });
    return { name, mtime: stat.mtimeNs, bytes: stat.isFile() ? readFileSync(path) : null };
  });
}

it('cold-data-dir GETs create nothing and never kick the indexer', async () => {
  expect(readdirSync(directory), 'route imports must create nothing').toEqual([]);
  expect(await (await codebase.GET()).json()).toEqual({ bootRan: false, inFlight: false, entries: [] });
  const result = await (await diagnostics.GET()).json();
  expect(result).toMatchObject({ ok: true, outcomesCount: 0, directivesCount: 0,
    timing: { totalSamples: 0 }, timing7d: { totalSamples: 0 } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(tool).not.toHaveBeenCalled();
  expect(readdirSync(directory), 'GET must leave a cold data directory empty').toEqual([]);
});

it('missing-data-dir GETs do not create even the data directory', async () => {
  const absent = join(directory, 'absent');
  vi.stubEnv('O8_DATA_DIR', absent);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(absent, 'cortex-ide.db'));
  try {
    await codebase.GET();
    await diagnostics.GET();
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    vi.stubEnv('O8_DATA_DIR', directory);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
  }
});

it('registers both production GET handlers and no mutation methods', async () => {
  for (const [path, surface, GET] of [
    ['/api/cortex/codebase-memory', 'settings', codebase.GET],
    ['/api/cortex/diagnostics', 'settings', diagnostics.GET],
  ] as const) {
    const route = nativeSurfaceRoutes[surface].find(route => route.path === path);
    expect(route, `${path} production GET registration`).toBeDefined();
    expect(route!.methods).toEqual(['GET']);
    expect(await route!.load()).toMatchObject({ GET });
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) expect(matchNativeHttpRoute(path, method)).toBeUndefined();
  }
});

it('counts persisted live outcomes and directives through a read-only connection', async () => {
  const persisted = join(directory, 'persisted');
  mkdirSync(persisted);
  const databasePath = join(persisted, 'cortex-ide.db');
  const database = new Database(databasePath);
  database.exec(`CREATE TABLE session_outcomes (valid_from TEXT, valid_to TEXT);
    INSERT INTO session_outcomes VALUES ('2000-01-01', NULL), ('2000-01-01', '2999-01-01'),
      ('2000-01-01', '2001-01-01'), (NULL, NULL);`);
  database.close();
  mkdirSync(join(persisted, 'directives'));
  writeFileSync(join(persisted, 'directives', 'fixture.md'), 'Fixture directive');
  writeFileSync(join(persisted, 'directives', 'ignored.tmp'), 'Not a directive');
  vi.stubEnv('O8_DATA_DIR', persisted);
  vi.stubEnv('CORTEX_IDE_DB_PATH', databasePath);
  try {
    const before = snapshot();
    expect(await (await diagnostics.GET()).json()).toMatchObject({ outcomesCount: 2, directivesCount: 1 });
    expect(snapshot()).toEqual(before);
  } finally {
    vi.stubEnv('O8_DATA_DIR', directory);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
    rmSync(persisted, { recursive: true, force: true });
  }
});

it('reads legacy timings without mutation and imports them once on the first recording', async () => {
  const legacy = join(directory, 'legacy');
  mkdirSync(legacy);
  vi.stubEnv('O8_DATA_DIR', legacy);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(legacy, 'cortex-ide.db'));
  try {
    writeFileSync(join(legacy, 'recall-metrics.json'), JSON.stringify({ version: 1, samples: [
      { label: 'fixture.legacy', durationMs: 19, timestamp: Date.now() },
    ] }));
    const before = snapshot();
    expect((await (await diagnostics.GET()).json()).timing).toMatchObject({ totalSamples: 1, p95Ms: 19 });
    expect(snapshot()).toEqual(before);
    const recorder = await import('@/lib/cortex/diagnostics');
    recorder.recordTiming({ label: 'fixture.new', durationMs: 23, timestamp: Date.now() });
    recorder.recordTiming({ label: 'fixture.new', durationMs: 29, timestamp: Date.now() });
    expect((await (await diagnostics.GET()).json()).timing).toMatchObject({ totalSamples: 3, p95Ms: 29 });
    const persisted = snapshot();
    await diagnostics.GET();
    expect(snapshot()).toEqual(persisted);
  } finally {
    vi.stubEnv('O8_DATA_DIR', directory);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
    rmSync(legacy, { recursive: true, force: true });
  }
});

it('startup kicks exactly one real boot pass and publishes pending, indexing and error state', async () => {
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '--allow-empty', '-m', 'Fixture']);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: 'fixture-repo', name: 'Fixture', localPath: repo, addedAt: new Date().toISOString(),
  }] }));
  let finish!: (value: { ok: boolean; error: string; durationMs: number }) => void;
  tool.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const indexer = await import('@/lib/codebase-memory/indexer');
  let releaseBinary!: (path: string) => void;
  binaryWait.mockImplementationOnce(() => new Promise(resolve => { releaseBinary = resolve; }));
  indexer.ensureCodebaseMemoryBootIndex();
  indexer.ensureCodebaseMemoryBootIndex();
  await vi.waitFor(() => expect(binaryWait).toHaveBeenCalledTimes(1));
  expect(await (await codebase.GET()).json()).toMatchObject({ bootRan: true, inFlight: true,
    entries: [{ repoId: 'fixture-repo', status: 'pending' }] });
  releaseBinary('fixture-indexer');
  await vi.waitFor(() => expect(tool).toHaveBeenCalledTimes(1));
  const route = matchNativeHttpRoute('/api/cortex/codebase-memory', 'GET')!;
  const native = await route.route.load() as typeof codebase;
  expect(await (await native.GET()).json()).toEqual(indexer.getIndexState());
  expect(await (await native.GET()).json()).toMatchObject({ bootRan: true, inFlight: true,
    entries: [{ repoId: 'fixture-repo', status: 'indexing' }] });
  const before = snapshot();
  await native.GET();
  expect(snapshot()).toEqual(before);
  finish({ ok: false, error: 'Fixture index failure', durationMs: 12 });
  await vi.waitFor(() => expect(indexer.getIndexState().inFlight).toBe(false));
  expect(await (await native.GET()).json()).toEqual(indexer.getIndexState());
  expect(await (await native.GET()).json()).toMatchObject({ entries: [{ status: 'error', error: 'Fixture index failure' }] });
  indexer.ensureCodebaseMemoryBootIndex();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(tool).toHaveBeenCalledTimes(1);
});

it('native diagnostics sees each newly recorded timing without a GET flush', async () => {
  const recorder = await import('@/lib/cortex/diagnostics');
  expect((await (await diagnostics.GET()).json()).timing.totalSamples).toBe(0);
  recorder.recordTiming({ label: 'fixture.owner', durationMs: 37, timestamp: Date.now() });
  const before = snapshot();
  const result = await (await diagnostics.GET()).json();
  expect(result.timing).toMatchObject({ totalSamples: 1, p95Ms: 37,
    byLabel: [{ label: 'fixture.owner', samples: 1 }] });
  expect(result.timing7d).toMatchObject({ totalSamples: 1, p95Ms: 37 });
  expect(snapshot()).toEqual(before);
});

it('native diagnostics reads probe counters published by the Next startup owner', async () => {
  const { startCortexDiagnosticsPublisher } = await import('@/lib/cortex/diagnostics-state');
  const { readProcessCwdsForPids, readProcessCwdProbeDiagnostics } = await import('@/lib/runtime/process-cwd-snapshot');
  startCortexDiagnosticsPublisher();
  await readProcessCwdsForPids([]);
  expect((await (await diagnostics.GET()).json()).processCwdProbe).toEqual(readProcessCwdProbeDiagnostics());
  expect((await (await diagnostics.GET()).json()).processCwdProbe.emptyRequestSkips).toBe(1);
});

it('native bootstrap cannot start another indexer or publish over the owner', async () => {
  vi.stubGlobal('__o8NativeCortexReader', false);
  try {
    const { markNativeCortexReader } = await import('@/lib/cortex/owner-process');
    const { startCortexDiagnosticsPublisher } = await import('@/lib/cortex/diagnostics-state');
    const indexer = await import('@/lib/codebase-memory/indexer');
    const before = snapshot();
    const calls = tool.mock.calls.length;
    markNativeCortexReader();
    startCortexDiagnosticsPublisher();
    indexer.ensureCodebaseMemoryBootIndex();
    expect(await indexer.indexAllRepos()).toEqual(await (await codebase.GET()).json());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(tool).toHaveBeenCalledTimes(calls);
    expect(snapshot()).toEqual(before);
  } finally { vi.unstubAllGlobals(); }
});
