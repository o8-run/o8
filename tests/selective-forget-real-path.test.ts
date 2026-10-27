import { outcomeMemoryFingerprint } from '@/lib/cortex/outcome-identity';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TypedRow } from '@/lib/cortex/qa/types';

let dbModule: typeof import('@/lib/db');
let directivesRoute: typeof import('@/app/api/cortex/directives/route');
let outcomesRoute: typeof import('@/app/api/cortex/recent-outcomes/route');
let diagnostics: typeof import('@/app/api/cortex/diagnostics/route').GET;
let searchDirectives: typeof import('@/lib/search/directives').searchDirectives;
let recall: typeof import('@/lib/cortex/qa/recall');
let panelGateMiddleware: typeof import('@/middleware').panelGateMiddleware;
let getOrCreateLocalWorkerToken: typeof import('@/lib/auth/worker-token').getOrCreateLocalWorkerToken;
const getSqlite = () => dbModule.getSqlite();
const closeDb = () => dbModule?.closeDb();
vi.mock('@/lib/realtime/publisher', () => ({ publishCortexChange: vi.fn(async () => {}) }));
let root: string;
const repoPath = '/fixture/repository';
const projectId = 'fixture-project';
const request = (path: string, body: object) => new NextRequest(`http://localhost/api/cortex/${path}`, {
  method: 'DELETE', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function remove(kind: 'directive' | 'outcome', body: object) {
  const route = kind === 'directive' ? directivesRoute : outcomesRoute;
  const handler = (route as unknown as { DELETE?: (req: NextRequest) => Promise<Response> }).DELETE;
  expect(handler, 'The production route must expose selective DELETE').toBeTypeOf('function');
  return handler!(request(kind === 'directive' ? 'directives' : 'recent-outcomes', body));
}
function seedFact(kind: string, id: string) {
  getSqlite().prepare(`INSERT INTO facts (id, kind, content, source_kind, source_id, source_excerpt, fingerprint)
    VALUES (?, 'convention', 'forgetneedle', ?, ?, 'forgetneedle', ?)`).run(`${kind}-${id}`, kind, `${kind}:${id}`, `${kind}-${id}`);
}
beforeEach(async () => {
  closeDb(); vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'o8-selective-forget-'));
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'cortex-ide.db'));
  writeFileSync(join(root, 'ws-token'), 'fixture-operator-token');
  dbModule = await import('@/lib/db');
  directivesRoute = await import('@/app/api/cortex/directives/route');
  outcomesRoute = await import('@/app/api/cortex/recent-outcomes/route');
  diagnostics = (await import('@/app/api/cortex/diagnostics/route')).GET;
  searchDirectives = (await import('@/lib/search/directives')).searchDirectives;
  recall = await import('@/lib/cortex/qa/recall');
  panelGateMiddleware = (await import('@/middleware')).panelGateMiddleware;
  getOrCreateLocalWorkerToken = (await import('@/lib/auth/worker-token')).getOrCreateLocalWorkerToken;
  getSqlite(); recall.resetRecallCacheForTests();
});
afterEach(() => { recall.resetRecallCacheForTests(); closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function directive(id: string) {
  const response = await directivesRoute.POST(new NextRequest('http://localhost/api/cortex/directives', {
    method: 'POST', body: JSON.stringify({ id, title: id, scope: 'global', body: `forgetneedle ${id}` }),
  }));
  expect(response.status).toBe(200);
}
function outcome(id: string, project = projectId) {
  getSqlite().prepare(`INSERT INTO session_outcomes (id, project_id, repo_path, runtime, outcome, summary, memory_fingerprint, started_at, completed_at)
    VALUES (?, ?, ?, 'codex', 'succeeded', ?, ?, datetime('now'), datetime('now'))`).run(id, project, repoPath, `forgetneedle ${id}`,
      outcomeMemoryFingerprint({ projectId: project, repoPath, summary: `forgetneedle ${id}` }));
  seedFact('outcome', id);
}

describe('selective forget through persisted production routes', () => {
  it('deletes exactly one directive, its derived facts and recall cache, and updates inventory/search/counts after reopen', async () => {
    await directive('remove-rule'); await directive('keep-rule'); seedFact('directive', 'remove-rule'); seedFact('directive', 'keep-rule');
    const rows = [{ citation: { kind: 'directive', rowId: 'remove-rule', table: 'directives_fts', excerpt: 'forgetneedle' }, fields: {}, score: 1 }] as TypedRow[];
    recall.seedRecallCacheForTests({ question: 'forgetneedle', repoPath, projectId, rows, vector: [1, 0] });
    recall.setRecallDependenciesForTests({ hasEmbedding: () => true, assertSpend: async () => {}, classify: async () => ({ class: 'A', bm25Variants: ['forgetneedle'] }), retrieve: async () => [], embed: async () => [1, 0] });
    expect((await recall.recallRows('forgetneedle', repoPath, projectId)).rows).toHaveLength(1);
    const kept = readFileSync(join(root, 'directives', 'keep-rule.md'), 'utf8');
    expect((await remove('directive', { id: 'remove-rule' })).status).toBe(200);
    expect((await recall.recallRows('forgetneedle', repoPath, projectId)).rows).toEqual([]);
    expect(searchDirectives('forgetneedle').map(row => row.id)).toEqual(['directive:keep-rule']);
    expect(getSqlite().prepare('SELECT directive_id FROM directives_fts').all()).toEqual([{ directive_id: 'keep-rule' }]);
    expect(getSqlite().prepare('SELECT id FROM facts').all()).toEqual([{ id: 'directive-keep-rule' }]);
    expect(readFileSync(join(root, 'directives', 'keep-rule.md'), 'utf8')).toBe(kept);
    closeDb(); getSqlite();
    expect((await (await diagnostics()).json()).directivesCount).toBe(1);
    expect((await (await directivesRoute.GET(new NextRequest('http://localhost/api/cortex/directives'))).json()).directives.map((d: { id: string }) => d.id)).toEqual(['keep-rule']);
  });

  it('deletes an outcome only in the selected repo/project and removes FTS and facts without touching the neighbor', async () => {
    outcome('remove-outcome'); outcome('keep-outcome'); outcome('foreign-outcome', 'other-project');
    expect((await remove('outcome', { id: 'foreign-outcome', repoPath, projectId })).status).toBe(404);
    expect((await remove('outcome', { id: 'remove-outcome', repoPath: '/fixture/other', projectId })).status).toBe(404);
    expect((await remove('outcome', { id: 'remove-outcome', repoPath, projectId })).status).toBe(200);
    expect(getSqlite().prepare('SELECT outcome_id FROM outcomes_fts ORDER BY outcome_id').all()).toEqual([{ outcome_id: 'foreign-outcome' }, { outcome_id: 'keep-outcome' }]);
    expect(getSqlite().prepare('SELECT id FROM facts ORDER BY id').all()).toEqual([{ id: 'outcome-foreign-outcome' }, { id: 'outcome-keep-outcome' }]);
    closeDb(); getSqlite();
    const listed = await outcomesRoute.GET(new NextRequest(`http://localhost/api/cortex/recent-outcomes?repoPath=${encodeURIComponent(repoPath)}&projectId=${projectId}`));
    expect((await listed.json()).outcomes.map((o: { id: string }) => o.id)).toEqual(['keep-outcome']);
    expect((await (await diagnostics()).json()).outcomesCount).toBe(2);
  });

  it('refuses stale outcome and derived-memory reindex writes after a persisted forget while retaining neighboring identities', async () => {
    outcome('removed-reindex'); outcome('retained-reindex');
    expect((await remove('outcome', { id: 'removed-reindex', repoPath, projectId })).status).toBe(200);
    closeDb(); getSqlite();
    // A reindexer holding old source data can insert a source/fact or retarget
    // an existing row. Neither operation may reintroduce the forgotten ID.
    outcome('removed-reindex');
    getSqlite().prepare(`INSERT INTO facts_queue (id, source_kind, source_id) VALUES ('late-job', 'outcome', 'outcome:removed-reindex')`).run();
    getSqlite().prepare("UPDATE session_outcomes SET id = 'removed-reindex' WHERE id = 'retained-reindex'").run();
    getSqlite().prepare("UPDATE facts SET source_id = 'outcome:removed-reindex' WHERE id = 'outcome-retained-reindex'").run();
    getSqlite().prepare(`INSERT INTO facts_queue (id, source_kind, source_id) VALUES ('kept-job', 'outcome', 'outcome:retained-reindex')`).run();
    getSqlite().prepare("UPDATE facts_queue SET source_id = 'outcome:removed-reindex' WHERE id = 'kept-job'").run();
    expect(getSqlite().prepare('SELECT id FROM session_outcomes').all()).toEqual([{ id: 'retained-reindex' }]);
    expect(getSqlite().prepare('SELECT source_id FROM facts').all()).toEqual([{ source_id: 'outcome:retained-reindex' }]);
    expect(getSqlite().prepare('SELECT source_id FROM facts_queue').all()).toEqual([{ source_id: 'outcome:retained-reindex' }]);
    expect(getSqlite().prepare('SELECT outcome_id FROM outcomes_fts').all()).toEqual([{ outcome_id: 'retained-reindex' }]);
  });

  it('rolls back outcome deletion and its exclusion together when the transaction fails', async () => {
    outcome('prime-exclusion');
    expect((await remove('outcome', { id: 'prime-exclusion', repoPath, projectId })).status).toBe(200);
    outcome('rollback-outcome');
    const { readMemoryRevision } = await import('@/lib/cortex/memory-revision');
    const revision = readMemoryRevision();
    getSqlite().exec("CREATE TRIGGER fixture_refuse_outcome_forget BEFORE DELETE ON session_outcomes BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
    expect((await remove('outcome', { id: 'rollback-outcome', repoPath, projectId })).status).toBe(500);
    expect(getSqlite().prepare("SELECT id FROM forgotten_session_outcomes WHERE id = 'rollback-outcome'").get()).toBeUndefined();
    expect(getSqlite().prepare("SELECT id FROM session_outcomes WHERE id = 'rollback-outcome'").get()).toBeDefined();
    expect(getSqlite().prepare("SELECT id FROM facts WHERE source_id = 'outcome:rollback-outcome'").get()).toBeDefined();
    expect(readMemoryRevision()).toBe(revision);
  });

  it('refuses path identifiers, ambiguous directives and symlinked storage without deleting any source', async () => {
    await directive('keep-rule');
    const file = join(root, 'directives', 'keep-rule.md'), original = readFileSync(file, 'utf8');
    expect((await remove('directive', { id: '../keep-rule' })).status).toBe(400);
    writeFileSync(join(root, 'directives', 'duplicate.md'), original);
    expect((await remove('directive', { id: 'keep-rule' })).status).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe(original);
    rmSync(join(root, 'directives', 'duplicate.md'));
    if (process.platform === 'win32') return;
    const aliasSource = join(root, 'alias-source.md'); writeFileSync(aliasSource, original);
    symlinkSync(aliasSource, join(root, 'directives', 'unrelated-alias.md'));
    expect((await remove('directive', { id: 'keep-rule' })).status).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readFileSync(aliasSource, 'utf8')).toBe(original);
    rmSync(join(root, 'directives', 'unrelated-alias.md'));
    const outside = join(root, 'outside.md'); writeFileSync(outside, original.replaceAll('keep-rule', 'linked-rule'));
    symlinkSync(outside, join(root, 'directives', 'linked-rule.md'));
    expect((await remove('directive', { id: 'linked-rule' })).status).toBe(409);
    expect(readFileSync(outside, 'utf8')).toContain('linked-rule');
    rmSync(join(root, 'directives'), { recursive: true });
    mkdirSync(join(root, 'external')); writeFileSync(join(root, 'external', 'keep-rule.md'), original);
    symlinkSync(join(root, 'external'), join(root, 'directives'), 'dir');
    expect((await remove('directive', { id: 'keep-rule' })).status).toBe(409);
    expect(readFileSync(join(root, 'external', 'keep-rule.md'), 'utf8')).toBe(original);
  });

  it('supports existing underscore IDs and indexed references while preserving their original documents', async () => {
    await directive('_retained-rule');
    const unrelated = join(root, 'unrelated-directory');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'keep.txt'), 'preserved');
    if (process.platform !== 'win32') symlinkSync(unrelated, join(root, 'directives', 'ignored.md'), 'dir');
    expect((await remove('directive', { id: '_retained-rule' })).status).toBe(200);
    expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('preserved');
    const id = 'spec-ingest:fixture:section';
    const source = join(root, 'source.md'); writeFileSync(source, '# Original documentation');
    writeFileSync(join(root, 'directives', 'spec-ingest__fixture__section.md'), `---\nid: ${id}\ntitle: Reference\nscope: global\n---\nReference body`);
    getSqlite().prepare('INSERT INTO directives_fts (directive_id, title, body) VALUES (?, ?, ?)').run(id, 'Reference', 'Reference body');
    expect((await remove('directive', { id })).status).toBe(200);
    expect(readFileSync(source, 'utf8')).toBe('# Original documentation');
    expect(searchDirectives('Reference')).toEqual([]);
  });

  it('restores the directive and indexes when the SQLite delete fails', async () => {
    await directive('keep-rule');
    const original = readFileSync(join(root, 'directives', 'keep-rule.md'), 'utf8');
    seedFact('directive', 'keep-rule');
    getSqlite().exec("CREATE TRIGGER fixture_refuse_forget BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;");
    expect((await remove('directive', { id: 'keep-rule' })).status).toBe(500);
    expect(readFileSync(join(root, 'directives', 'keep-rule.md'), 'utf8')).toBe(original);
    expect(readdirSync(join(root, 'directives'))).toEqual(['keep-rule.md']);
    expect(searchDirectives('forgetneedle')).toHaveLength(1);
  });

  it('invalidates another process recall cache when the deletion commits', async () => {
    await directive('remove-rule');
    const rows = [{ citation: { kind: 'directive', rowId: 'remove-rule', table: 'directives_fts' }, fields: {} }] as TypedRow[];
    recall.seedRecallCacheForTests({ question: 'cached rule', repoPath, projectId, rows, vector: [1, 0] });
    recall.setRecallDependenciesForTests({ hasEmbedding: () => true, assertSpend: async () => {}, classify: async () => ({ class: 'A', bm25Variants: ['cached rule'] }), retrieve: async () => [], embed: async () => [1, 0] });
    expect((await recall.recallRows('cached rule', repoPath, projectId)).rows).toHaveLength(1);
    const script = join(root, 'delete-fixture.cjs');
    writeFileSync(script, `const {createRequire}=require('node:module');
      const load=createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});
      globalThis.fetch=async()=>new Response('{}');
      const {NextRequest}=load('next/server');
      const {DELETE}=load(${JSON.stringify(join(process.cwd(), 'src/app/api/cortex/directives/route.ts'))});
      DELETE(new NextRequest('http://localhost/api/cortex/directives', {method:'DELETE',body:JSON.stringify({id:'remove-rule'})}))
        .then(response=>{console.log('FORGET_STATUS='+response.status); if(response.status!==200)process.exitCode=1;});`);
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--import', join(process.cwd(), 'scripts/register-server-only-stub.mjs'), script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') },
    });
    expect(output).toContain('FORGET_STATUS=200');
    expect((await recall.recallRows('cached rule', repoPath, projectId)).rows).toEqual([]);
  });

  it('does not let an older in-flight recall refill the cache after deletion', async () => {
    await directive('remove-rule');
    const rows = [{ citation: { kind: 'directive', rowId: 'remove-rule', table: 'directives_fts' }, fields: {} }] as TypedRow[];
    let finish!: () => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    recall.setRecallDependenciesForTests({ hasEmbedding: () => true, assertSpend: async () => {},
      classify: async () => ({ class: 'A', bm25Variants: ['late rule'] }), embed: async () => [1, 0],
      retrieve: async () => {
        if (calls++ > 0) return [];
        started(); await new Promise<void>(resolve => { finish = resolve; });
        return [{ retriever: 'fts' as const, rows, durationMs: 0 }];
      },
    });
    const pending = recall.recallRows('late rule', repoPath, projectId);
    await began;
    expect((await remove('directive', { id: 'remove-rule' })).status).toBe(200);
    finish(); await pending;
    expect((await recall.recallRows('late rule', repoPath, projectId)).rows).toEqual([]);
  });

  it('keeps DELETE behind existing operator middleware and rejects remote anonymous and worker callers', async () => {
    for (const path of ['directives', 'recent-outcomes']) {
      const url = `http://localhost/api/cortex/${path}`;
      const denied = await panelGateMiddleware(new NextRequest(url, { method: 'DELETE', headers: { host: 'localhost', 'x-o8-client-addr': '198.51.100.1' } }));
      expect(denied.status).toBe(401);
      const worker = await panelGateMiddleware(new NextRequest(url, { method: 'DELETE', headers: { host: 'localhost', 'x-o8-client-addr': '198.51.100.1', authorization: `Bearer ${getOrCreateLocalWorkerToken()}` } }));
      expect(worker.status).toBe(403);
      const operatorRequest = request(path, { id: 'fixture' });
      operatorRequest.headers.set('authorization', 'Bearer fixture-operator-token');
      const local = await panelGateMiddleware(operatorRequest);
      expect(local.headers.get('x-middleware-next')).toBe('1');
    }
  });
});
