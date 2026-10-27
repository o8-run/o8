import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', async original => ({
  ...await original<typeof import('@/lib/realtime/publisher')>(),
  publishCortexChange: async () => {}, publishRealtimeMutation: async () => {},
}));
vi.mock('@/lib/runtime/inventory', async original => ({
  ...await original<typeof import('@/lib/runtime/inventory')>(),
  getRuntimeInventorySnapshot: async () => ({ agents: [] }),
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: async () => {} }));
vi.mock('@/lib/lane/report-claim-check', () => ({ startReportClaimCheck: () => {} }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-forgotten-content-')));
const repo = join(root, 'repo');
const token = 'fixture-forgotten-content-operator';
const timestamp = new Date().toISOString();
let projectA = 'forget-a', projectB = 'forget-b';
let db: typeof import('@/lib/db');
let outcomes: typeof import('@/app/api/cortex/recent-outcomes/route');
let relay: typeof import('@/lib/orchestrator/context-relay');
let recall: typeof import('@/lib/cortex/qa/recall');
let search: typeof import('@/app/api/panel/search/route');
let projectStore: typeof import('@/lib/repos/projects');
let fts: typeof import('@/lib/cortex/qa/retrievers/fts');
let legacyWriter: Database.Database;
let legacyRow: Record<string, string | null>;
const legacyColumns = ['project_id', 'repo_path', 'runtime', 'session_key', 'packet_id', 'outcome', 'summary', 'started_at', 'completed_at'];
const oldInsert = (id: string, changes: Record<string, string | null> = {}) => legacyWriter.prepare(
  `INSERT INTO session_outcomes (id, ${legacyColumns.join(',')}) VALUES (?, ${legacyColumns.map(() => '?').join(',')})`,
).run(id, ...legacyColumns.map(key => key in changes ? changes[key] : legacyRow[key]));
const packet = (suffix: string) => ({ id: `pkt-forget-${suffix}`, projectId: projectA,
  workspaceTargetPath: repo, referenceLabel: suffix, title: suffix, summary: '',
  status: 'draft', queueState: 'queued', runtime: 'codex', dependencyPacketIds: [], dependencyLabels: [],
}) as unknown as import('@/lib/orchestrator/types').OrchestratorPacket;
const erase = packet('erase'), keep = packet('keep');
const sql = () => db.getSqlite();
const apiRequest = (method: string, body?: object) => new NextRequest(
  `http://localhost/api/cortex/recent-outcomes?${new URLSearchParams({ repoPath: repo, projectId: projectA, inventory: 'true' })}`,
  { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) },
);
const inventory = async () => (await (await outcomes.GET(apiRequest('GET'))).json()).outcomes as Array<{ id: string; summary: string }>;
async function recallFromRoute() {
  const response = await search.GET(new Request(`http://localhost/api/panel/search?${new URLSearchParams({
    q: 'remember memorycanary parser decision', mode: 'recall', keywordHits: '0', workspace: repo,
  })}`));
  expect(response.status).toBe(200);
  return (await response.json()).results as Array<{ id: string; detail: string }>;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Fixture refuses network access'); }));
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'memory.db'));
  mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(root, 'ws-token'), token);
  db = await import('@/lib/db');
  projectStore = await import('@/lib/repos/projects');
  await (await import('@/lib/repos/registry')).addRepo(repo);
  projectA = (await projectStore.createProject('Forget A')).activeProjectId;
  await projectStore.setProjectRepos(projectA, [repo]);
  projectB = (await projectStore.createProject('Forget B')).activeProjectId;
  await projectStore.setProjectRepos(projectB, [repo]);
  await projectStore.setActiveProject(projectA);
  erase.projectId = projectA; keep.projectId = projectA;
  outcomes = await import('@/app/api/cortex/recent-outcomes/route');
  relay = await import('@/lib/orchestrator/context-relay');
  recall = await import('@/lib/cortex/qa/recall');
  search = await import('@/app/api/panel/search/route');
  fts = await import('@/lib/cortex/qa/retrievers/fts');
  // Substitute inference only: the HTTP search route, recall cache and FTS SQL stay real.
  recall.setRecallDependenciesForTests({ hasEmbedding: () => true, assertSpend: async () => {},
    classify: async () => ({ class: 'A', bm25Variants: ['memorycanary'] }), embed: async () => [1, 0],
    retrieve: async input => [await fts.ftsRetriever(input)],
  });
  const { registerRuntime } = await import('@/lib/runtimes');
  registerRuntime({ id: 'codex', displayName: 'Memory fixture',
    capabilities: { discover: false, readTranscript: true, launch: false, resume: false, interrupt: false,
      reviewDiffs: false, costTelemetry: false, streaming: false },
    discoverSessions: async () => [], getChangedFiles: async () => [],
    readTranscript: async key => [{ id: 'completed', role: 'assistant',
      text: `memorycanary ${key.endsWith('erase') ? 'forgotten parser choice' : 'retained neighbor choice'}`, timestamp: new Date(timestamp) }],
    launch: async () => ({ ok: false, note: 'fixture' }), resume: async () => ({ ok: false, note: 'fixture' }),
    interrupt: async () => ({ ok: false, note: 'fixture' }),
  });
  const { createLane } = await import('@/lib/lane/registry');
  for (const value of [erase, keep]) {
    createLane({ repoPath: repo, projectId: projectA, branch: 'fixture', runtime: 'codex', packetId: value.id });
    await relay.capturePacketCompletionContext(value.id, `codex:fixture-${value.referenceLabel}`);
  }
  await vi.waitFor(() => expect(sql().prepare('SELECT COUNT(*) AS count FROM session_outcomes').get()).toEqual({ count: 2 }));
  legacyWriter = new Database(join(root, 'memory.db'));
  // Emulate a ledger retained before the outcome-ID format changed. Its content is untouched.
  sql().prepare("UPDATE session_outcomes SET id = 'legacy-before-upgrade' WHERE packet_id = ?").run(erase.id);
  if ((sql().prepare('PRAGMA table_info(session_outcomes)').all() as Array<{ name: string }>).some(row => row.name === 'memory_fingerprint')) {
    sql().exec("UPDATE session_outcomes SET memory_fingerprint = NULL WHERE id = 'legacy-before-upgrade'");
  }
  legacyRow = sql().prepare('SELECT * FROM session_outcomes WHERE id = ?').get('legacy-before-upgrade') as Record<string, string | null>;
  oldInsert('legacy-shadow-before-upgrade');
  for (const id of ['legacy-before-upgrade', 'legacy-shadow-before-upgrade']) {
    const sourceId = id === 'legacy-before-upgrade' ? `outcome:${id}` : id;
    sql().prepare(`INSERT INTO facts (id, kind, content, source_kind, source_id, source_excerpt, fingerprint, repo_path)
      VALUES (?, 'convention', 'memorycanary forgotten parser choice', 'outcome', ?, 'memorycanary forgotten parser choice', ?, ?)`
    ).run(`fact-${id}`, sourceId, `fact-${id}`, repo);
    sql().prepare("INSERT INTO facts_queue (id, source_kind, source_id) VALUES (?, 'outcome', ?)").run(`queue-${id}`, sourceId);
  }
}, 120_000);
afterAll(() => { recall?.resetRecallCacheForTests(); legacyWriter?.close(); db?.closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

it('keeps pre-upgrade outcome content forgotten through identical capture, cached recall, reopen and dependent prompts', async () => {
  const before = await recallFromRoute();
  expect(before.some(row => row.detail.includes('forgotten parser choice'))).toBe(true);
  expect(before.some(row => row.detail.includes('retained neighbor choice'))).toBe(true);
  expect((await outcomes.DELETE(apiRequest('DELETE', { id: 'legacy-before-upgrade', repoPath: repo, projectId: projectA }))).status).toBe(200);
  expect(sql().prepare("SELECT id FROM facts WHERE source_kind = 'outcome'").all()).toEqual([]);
  expect(sql().prepare("SELECT id FROM facts_queue WHERE source_kind = 'outcome'").all()).toEqual([]);
  expect(oldInsert('stale-new-identity').changes).toBe(0);
  expect(oldInsert('stale-unrelated-neighbor', { packet_id: keep.id, session_key: 'codex:fixture-keep', summary: 'memorycanary unrelated retained sibling' }).changes).toBe(1);
  for (let pass = 0; pass < 2; pass += 1) {
    if (pass) { db.closeDb(); db.getSqlite(); }
    await relay.capturePacketCompletionContext(erase.id, 'codex:fixture-erase');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect.soft((await inventory()).some(row => row.summary.includes('forgotten parser choice'))).toBe(false);
    expect.soft(sql().prepare("SELECT id FROM session_outcomes WHERE summary LIKE '%forgotten parser choice%'").all()).toEqual([]);
    const recalled = await recallFromRoute();
    expect.soft(recalled.some(row => row.detail.includes('forgotten parser choice'))).toBe(false);
    expect.soft(recalled.some(row => row.detail.includes('retained neighbor choice'))).toBe(true);
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const next = { ...packet('dependent'), dependencyPacketIds: [erase.id, keep.id] };
    const prompt = await buildPacketPrompt(next, [erase, keep, next]);
    expect.soft(prompt).not.toContain('forgotten parser choice');
    expect.soft(prompt).toContain('retained neighbor choice');
  }
});

it('keeps outcome recall in the selected project when projects share the same repository', async () => {
  const insert = sql().prepare(`INSERT INTO session_outcomes
    (id, project_id, repo_path, runtime, session_key, packet_id, outcome, summary, started_at, completed_at)
    VALUES (?, ?, ?, 'codex', ?, ?, 'succeeded', ?, ?, ?)`);
  for (const project of [projectA, projectB]) insert.run(`scope-${project}`, project, repo,
    `codex:scope-${project}`, `pkt-scope-${project}`, `memorycanary ${project} private parser decision`, timestamp, timestamp);
  for (const project of [projectA, projectB, projectA]) {
    await projectStore.setActiveProject(project);
    recall.invalidateRecallCache();
    const rows = await recallFromRoute();
    expect.soft(rows.map(row => row.id)).toContain(`recall:outcome:scope-${project}`);
    const foreign = project === projectA ? projectB : projectA;
    expect.soft(rows.map(row => row.id)).not.toContain(`recall:outcome:scope-${foreign}`);
  }
});


it('scopes outcome-derived facts before candidate limits, preserving another project on the same repository', async () => {
  const { retrieveFacts } = await import('@/lib/cortex/qa/retrievers/facts');
  for (const project of [projectA, projectB]) {
    for (let index = 0; index < 40; index += 1) {
      const id = `derived-${project}-${index}`;
      sql().prepare(`INSERT INTO session_outcomes (id, project_id, repo_path, runtime, outcome, summary, started_at, completed_at)
        VALUES (?, ?, ?, 'codex', 'succeeded', 'memorycanary fact', ?, ?)`).run(id, project, repo, timestamp, timestamp);
      sql().prepare(`INSERT INTO facts (id, kind, content, source_kind, source_id, source_excerpt, fingerprint, repo_path, confidence)
        VALUES (?, 'convention', 'memorycanary fact', 'outcome', ?, 'memorycanary fact', ?, ?, 1)`)
        .run(`fact-${id}`, `outcome:${id}`, `fact-${id}`, repo);
    }
  }
  for (const project of [projectA, projectB]) {
    await projectStore.setActiveProject(project);
    const rows = (await retrieveFacts({ question: 'memorycanary', repoPath: repo, projectId: project, limit: 8 })).rows;
    expect(rows).toHaveLength(8);
    expect(rows.every(row => String(row.fields.sourceId).startsWith(`outcome:derived-${project}-`))).toBe(true);
  }
});

it('maintains fingerprints on real close-out writes while stale updates cannot move forgotten content', async () => {
  const packetId = 'close-fingerprint-packet';
  const insert = sql().prepare(`INSERT INTO session_outcomes
    (id, project_id, repo_path, packet_id, session_key, runtime, outcome, summary, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'codex:close-fingerprint', 'codex', 'succeeded', ?, ?, ?)`);
  insert.run('close-forgotten', projectA, repo, packetId, 'closed forgotten parser source', timestamp, timestamp);
  insert.run('close-retained', projectA, repo, packetId, 'closed retained parser source', timestamp, timestamp);
  expect((await outcomes.DELETE(apiRequest('DELETE', { id: 'close-forgotten', projectId: projectA, repoPath: repo }))).status).toBe(200);
  await relay.markOutcomeClosedUnmerged({ packetId, disposition: 'wontfix', summary: 'Closed deliberately after review.' });
  const retained = () => sql().prepare('SELECT outcome, summary, memory_fingerprint AS fingerprint FROM session_outcomes WHERE id = ?')
    .get('close-retained') as { outcome: string; summary: string; fingerprint: string };
  expect(retained()).toMatchObject({ outcome: 'wontfix', summary: 'Closed deliberately after review.' });
  expect(retained().fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(legacyWriter.prepare('UPDATE session_outcomes SET summary = ? WHERE id = ?')
    .run('closed forgotten parser source', 'close-retained').changes).toBe(0);
  expect(legacyWriter.prepare('UPDATE session_outcomes SET packet_id = ?, summary = ? WHERE id = ?')
    .run('moved-packet', 'closed forgotten parser source', 'close-retained').changes).toBe(0);
  expect(retained().summary).toBe('Closed deliberately after review.');

  await relay.markOutcomeClosedUnmerged({ packetId: 'close-without-ledger', disposition: 'superseded',
    summary: 'Fresh operator disposition.', lane: { id: 'close-fallback', repoPath: repo,
      branch: 'fixture', runtime: 'codex', sessionKey: 'codex:close-new', createdAt: timestamp, projectId: projectA } });
  const fallback = sql().prepare('SELECT project_id, memory_fingerprint FROM session_outcomes WHERE packet_id = ?')
    .get('close-without-ledger') as { project_id: string; memory_fingerprint: string };
  expect(fallback.project_id).toBe(projectA);
  expect(fallback.memory_fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it('upgrades an old exclusion ledger on normal database reopen before fresh or old connections write', () => {
  const upgradeRoot = join(root, 'upgrade'); mkdirSync(upgradeRoot);
  const script = join(upgradeRoot, 'upgrade.cjs');
  writeFileSync(script, `
    const assert=require('node:assert/strict');
    const load=require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});
    const Database=load('better-sqlite3');
    const core=load(${JSON.stringify(join(process.cwd(), 'src/lib/db/index.ts'))});
    let db=core.getSqlite();
    db.exec("CREATE TABLE forgotten_session_outcomes (id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL, packet_id TEXT)");
    db.prepare('INSERT INTO forgotten_session_outcomes VALUES (?,?,?)').run('old-deleted-id','fixture','old-forgotten-packet');
    const old=new Database(process.env.CORTEX_IDE_DB_PATH);
    const write=old.prepare("INSERT INTO session_outcomes (id,project_id,repo_path,packet_id,runtime,outcome,summary,started_at,completed_at) VALUES (?,'fixture','/fixture/repo',?,'codex','succeeded','memorycanary',datetime('now'),datetime('now'))");
    assert.equal(write.run('restored-before-upgrade','old-forgotten-packet').changes,1);
    core.closeDb(); db=core.getSqlite();
    assert.equal(write.run('new-id-after-upgrade','old-forgotten-packet').changes,0);
    assert.equal(write.run('unrelated-neighbor','unrelated-packet').changes,1);
    assert.deepEqual(db.prepare('SELECT id FROM session_outcomes').all(),[{id:'unrelated-neighbor'}]);
    old.close();core.closeDb();console.log('UPGRADE_GUARDS=passed');
  `);
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--import', join(process.cwd(), 'scripts/register-server-only-stub.mjs'), script], {
    cwd: process.cwd(), env: { ...process.env, O8_DATA_DIR: upgradeRoot, CORTEX_IDE_DATA_DIR: upgradeRoot,
      CORTEX_IDE_DB_PATH: join(upgradeRoot, 'upgrade.db'), TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') }, encoding: 'utf8', timeout: 30_000,
  });
  expect(output).toContain('UPGRADE_GUARDS=passed');
});
