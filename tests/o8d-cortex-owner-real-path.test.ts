import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    // WAL readers may update shared reader marks; the DB and WAL must stay unchanged.
    return { name, mtime: stat.mtimeNs, bytes: stat.isFile() && !name.endsWith('recall-metrics.db-shm') ? readFileSync(path) : null };
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

it('native GET clears dead, expired and replaced index owners while keeping a live owner in flight', async () => {
  const { probeMetadataLockProcessIdentitySync } = await import('@/lib/worktree/metadata-lock-process-identity');
  const owner = probeMetadataLockProcessIdentitySync(process.pid);
  expect(owner.state).toBe('live');
  if (owner.state !== 'live') throw new Error('Fixture process identity unavailable');
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const path = join(directory, 'codebase-memory-live.json');
  const route = matchNativeHttpRoute('/api/cortex/codebase-memory', 'GET')!;
  const native = await route.route.load() as typeof codebase;
  const state = { version: 1, bootRan: true, inFlight: true,
    ownerPid: process.pid, ownerIdentity: owner.identity, updatedAt: Date.now(), entries: [
      { repoId: 'active', repoName: 'Active', localPath: '/fixture', status: 'indexing' },
      { repoId: 'queued', repoName: 'Queued', localPath: '/fixture', status: 'pending' },
      { repoId: 'done', repoName: 'Done', localPath: '/fixture', status: 'ready' },
    ] };
  try {
    writeFileSync(path, JSON.stringify(state));
    expect((await (await native.GET()).json()).inFlight, 'live owner must remain in flight').toBe(true);
    for (const [reason, patch] of [
      ['dead owner', { ownerPid: deadPid }],
      ['expired snapshot', { updatedAt: Date.now() - 60_000 }],
      ['replaced owner', { ownerIdentity: { ...owner.identity, startId: `${owner.identity.startId}-old` } }],
    ] as const) {
      writeFileSync(path, JSON.stringify({ ...state, ...patch }));
      const before = readFileSync(path, 'utf8');
      const result = await (await native.GET()).json();
      expect(result.inFlight, `${reason} must not remain in flight`).toBe(false);
      expect(result.entries.slice(0, 2)).toEqual([
        expect.objectContaining({ status: 'error', error: expect.stringMatching(/stale/i) }),
        expect.objectContaining({ status: 'error', error: expect.stringMatching(/stale/i) }),
      ]);
      expect(result.entries[2]).toEqual(state.entries[2]);
      expect(readFileSync(path, 'utf8'), 'GET must not mutate the snapshot').toBe(before);
    }
  } finally { rmSync(path, { force: true }); }
});

it('counts persisted live outcomes and directives through a read-only connection', async () => {
  const persisted = join(directory, 'persisted');
  mkdirSync(persisted);
  const databasePath = join(persisted, 'cortex-ide.db');
  const database = new Database(databasePath);
  // The app DB runs in WAL mode; closed cleanly, only the DB file remains.
  database.pragma('journal_mode = WAL');
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
    expect(readdirSync(persisted).filter(name => name.startsWith('cortex-ide.db'))).toEqual(['cortex-ide.db']);
    expect(await (await diagnostics.GET()).json()).toMatchObject({ outcomesCount: 2, directivesCount: 1 });
    expect(snapshot(), 'a GET must not create -wal/-shm beside cortex-ide.db').toEqual(before);
    chmodSync(persisted, 0o555);
    try {
      expect(await (await diagnostics.GET()).json(), 'a read-only data dir still counts outcomes')
        .toMatchObject({ outcomesCount: 2, directivesCount: 1 });
    } finally { chmodSync(persisted, 0o755); }
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
  const abandoned = join(directory, 'codebase-memory-live.json.2147483647.tmp');
  writeFileSync(abandoned, 'Interrupted publish');
  let releaseBinary!: (path: string) => void;
  binaryWait.mockImplementationOnce(() => new Promise(resolve => { releaseBinary = resolve; }));
  indexer.ensureCodebaseMemoryBootIndex();
  indexer.ensureCodebaseMemoryBootIndex();
  await vi.waitFor(() => expect(binaryWait).toHaveBeenCalledTimes(1));
  expect(await (await codebase.GET()).json()).toMatchObject({ bootRan: true, inFlight: true,
    entries: [{ repoId: 'fixture-repo', status: 'pending' }] });
  releaseBinary('fixture-indexer');
  await vi.waitFor(() => expect(tool).toHaveBeenCalledTimes(1));
  const live = JSON.parse(readFileSync(join(directory, 'codebase-memory-live.json'), 'utf8'));
  expect(live).toMatchObject({ ownerPid: process.pid, ownerIdentity: { version: 1 }, updatedAt: expect.any(Number) });
  expect(readdirSync(directory)).not.toContain('codebase-memory-live.json.2147483647.tmp');
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'codebase-memory-live.json'), 'utf8')).updatedAt)
    .toBeGreaterThan(live.updatedAt), { timeout: 7_000, interval: 100 });
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

it('records 1000 timings with a cached WAL writer, bounded cost and at most 1000 persisted rows', async () => {
  const timings = join(directory, 'bounded-timings');
  vi.stubEnv('O8_DATA_DIR', timings);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(timings, 'cortex-ide.db'));
  const recorder = await import('@/lib/cortex/diagnostics');
  let close: ReturnType<typeof vi.spyOn> | undefined;
  let prepare: ReturnType<typeof vi.spyOn> | undefined;
  try {
    recorder.recordTiming({ label: 'fixture.warm', durationMs: 1, timestamp: Date.now() });
    close = vi.spyOn(Database.prototype, 'close');
    prepare = vi.spyOn(Database.prototype, 'prepare');
    const started = performance.now();
    for (let index = 0; index < 1000; index++) {
      recorder.recordTiming({ label: `fixture.bounded.${index}`, durationMs: index, timestamp: Date.now() });
    }
    const elapsed = performance.now() - started;
    expect(close.mock.calls.length, '1000 recordings must reuse the open write handle').toBe(0);
    expect(prepare.mock.calls.length, 'hot recordings must reuse prepared statements').toBe(0);
    expect(elapsed, '1000 hot timing recordings must finish within 500ms').toBeLessThan(500);
    console.info(`[timing-writer] 1000 hot recordings: ${elapsed.toFixed(1)}ms`);
    close.mockRestore();
    prepare.mockRestore();
    const database = new Database(join(timings, 'recall-metrics.db'), { readonly: true, fileMustExist: true });
    try {
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
      expect((database.prepare('SELECT COUNT(*) AS count FROM samples').get() as { count: number }).count).toBeLessThanOrEqual(1000);
      expect(database.prepare('SELECT label FROM samples ORDER BY id DESC LIMIT 1').get()).toEqual({ label: 'fixture.bounded.999' });
    } finally { database.close(); }
    const result = await (await diagnostics.GET()).json();
    expect(result.timing.totalSamples).toBeGreaterThanOrEqual(900);
    expect(result.timing.totalSamples).toBeLessThanOrEqual(1000);
  } finally {
    close?.mockRestore();
    prepare?.mockRestore();
    vi.stubEnv('O8_DATA_DIR', directory);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
    rmSync(timings, { recursive: true, force: true });
  }
});

it('a timings GET with no live writer creates no -wal/-shm and reads from a read-only dir', async () => {
  const warm = join(directory, 'warm-timings');
  mkdirSync(warm);
  // Another process recorded these timings in WAL mode and has exited cleanly.
  const previous = new Database(join(warm, 'recall-metrics.db'));
  previous.pragma('journal_mode = WAL');
  previous.exec('CREATE TABLE samples (id INTEGER PRIMARY KEY, label TEXT, duration_ms REAL, timestamp REAL, errored INTEGER)');
  previous.prepare('INSERT INTO samples (label, duration_ms, timestamp, errored) VALUES (?, ?, ?, 0)').run('fixture.warm-read', 41, Date.now());
  previous.close();
  vi.stubEnv('O8_DATA_DIR', warm);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(warm, 'cortex-ide.db'));
  try {
    const before = readdirSync(warm).sort();
    expect(before).toEqual(['recall-metrics.db']);
    const bytes = readFileSync(join(warm, 'recall-metrics.db'));
    expect((await (await diagnostics.GET()).json()).timing).toMatchObject({ totalSamples: 1, p95Ms: 41 });
    expect(readdirSync(warm).sort(), 'a timings GET must not create -wal/-shm beside the DB').toEqual(before);
    expect(readFileSync(join(warm, 'recall-metrics.db')).equals(bytes)).toBe(true);
    chmodSync(warm, 0o555);
    try {
      expect((await (await diagnostics.GET()).json()).timing, 'a read-only data dir still reports its samples')
        .toMatchObject({ totalSamples: 1 });
    } finally { chmodSync(warm, 0o755); }
  } finally {
    vi.stubEnv('O8_DATA_DIR', directory);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
    rmSync(warm, { recursive: true, force: true });
  }
});

it('drops busy timing writes without throwing, logs once and recovers after the lock clears', async () => {
  const timings = join(directory, 'busy-timings');
  vi.stubEnv('O8_DATA_DIR', timings);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(timings, 'cortex-ide.db'));
  const recorder = await import('@/lib/cortex/diagnostics');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let lock: Database.Database | undefined;
  try {
    recorder.recordTiming({ label: 'fixture.before-lock', durationMs: 1, timestamp: Date.now() });
    lock = new Database(join(timings, 'recall-metrics.db'));
    lock.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 2; index++) {
      expect(() => recorder.recordTiming({ label: 'fixture.dropped', durationMs: 1, timestamp: Date.now() })).not.toThrow();
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith('[recall-metrics] Could not persist timing.');
    lock.exec('ROLLBACK');
    recorder.recordTiming({ label: 'fixture.after-lock', durationMs: 1, timestamp: Date.now() });
    expect((await (await diagnostics.GET()).json()).timing).toMatchObject({ totalSamples: 2 });
  } finally {
    if (lock?.inTransaction) lock.exec('ROLLBACK');
    lock?.close();
    warn.mockRestore();
    vi.stubEnv('O8_DATA_DIR', directory);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
    rmSync(timings, { recursive: true, force: true });
  }
});

it('native diagnostics reads probe counters published by the Next startup owner', async () => {
  const { startCortexDiagnosticsPublisher } = await import('@/lib/cortex/diagnostics-state');
  const { readProcessCwdsForPids, readProcessCwdProbeDiagnostics } = await import('@/lib/runtime/process-cwd-snapshot');
  writeFileSync(join(directory, 'cortex-process-cwd.json.2147483647.tmp'), 'Interrupted publish');
  startCortexDiagnosticsPublisher();
  expect(readdirSync(directory)).not.toContain('cortex-process-cwd.json.2147483647.tmp');
  const before = snapshot();
  startCortexDiagnosticsPublisher();
  expect(snapshot(), 'unchanged probe counters must not rewrite the snapshot').toEqual(before);
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
