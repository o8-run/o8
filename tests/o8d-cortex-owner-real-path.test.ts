import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-cortex-owner-'));
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
vi.mock('@/lib/providers/child-process', async () => {
  const childProcess = await import('node:child_process');
  // Storage telemetry launches through the read-only entrypoint.
  return { ...childProcess, execFileReadOnly: childProcess.execFile };
});

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

it('cold-data-dir GETs create nothing', async () => {
  expect(readdirSync(directory), 'route imports must create nothing').toEqual([]);
  const result = await (await diagnostics.GET()).json();
  expect(result).toMatchObject({ ok: true, outcomesCount: 0, directivesCount: 0,
    timing: { totalSamples: 0 }, timing7d: { totalSamples: 0 } });
  expect(readdirSync(directory), 'GET must leave a cold data directory empty').toEqual([]);
});

it('missing-data-dir GETs do not create even the data directory', async () => {
  const absent = join(directory, 'absent');
  vi.stubEnv('O8_DATA_DIR', absent);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(absent, 'cortex-ide.db'));
  try {
    await diagnostics.GET();
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    vi.stubEnv('O8_DATA_DIR', directory);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
  }
});

it('registers the production GET handler and no mutation methods', async () => {
  for (const [path, surface, GET] of [
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

