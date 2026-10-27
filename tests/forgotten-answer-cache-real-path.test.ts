import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { TypedRow } from '@/lib/cortex/qa/types';

const gate = vi.hoisted(() => ({ block: false, entered: () => {}, release: Promise.resolve(), readsLeft: 0, afterRead: null as null | (() => void) }));
vi.mock('@/lib/cortex/memory-revision', async original => {
  const actual = await original<typeof import('@/lib/cortex/memory-revision')>();
  return { ...actual, readMemoryRevision: () => {
    const value = actual.readMemoryRevision();
    if (gate.readsLeft > 0 && --gate.readsLeft === 0) gate.afterRead?.();
    return value;
  } };
});
vi.mock('@/lib/cortex/qa/classifier', () => ({
  classifyQuestion: async () => ({ class: 'A', bm25Variants: ['memorycanary'] }),
  classifyQuestionForRecall: async () => ({ class: 'A', bm25Variants: ['memorycanary'] }),
}));
vi.mock('@/lib/cortex/qa/llm/gemini-embed', async original => ({
  ...await original<typeof import('@/lib/cortex/qa/llm/gemini-embed')>(),
  hasEmbeddingRoute: () => true,
  embedQuestion: async () => { if (gate.block) { gate.entered(); await gate.release; } return [1, 0]; },
}));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
vi.mock('@/lib/cortex/qa/composer', async original => ({
  ...await original<typeof import('@/lib/cortex/qa/composer')>(),
  composeClassA: async (_question: string, _repo: string, rows: TypedRow[], emit: (kind: string, payload: unknown) => void) => {
    emit('token', { text: rows.map(row => row.fields.summary ?? row.fields.content ?? row.fields.body ?? '').join('\n') });
    emit('done', {});
  },
}));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-forgotten-answer-')));
const repo = join(root, 'repo');
let db: typeof import('@/lib/db');
let route: typeof import('@/app/api/cortex/ask/route');
let ask: typeof import('@/lib/cortex/qa/ask');
let projectId: string;
const token = 'fixture-memory-answer-operator';
const request = (question: string) => new NextRequest('http://localhost/api/cortex/ask', {
  method: 'POST', body: JSON.stringify({ question, repoPath: repo, projectId }),
});
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Fixture refuses external provider access'); }));
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'memory.db'));
  mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(root, 'ws-token'), token);
  db = await import('@/lib/db');
  await (await import('@/lib/repos/registry')).addRepo(repo);
  const projects = await import('@/lib/repos/projects');
  projectId = (await projects.createProject('Answer cache project')).activeProjectId;
  await projects.setProjectRepos(projectId, [repo]);
  route = await import('@/app/api/cortex/ask/route');
  ask = await import('@/lib/cortex/qa/ask');
}, 120_000);
afterAll(() => { db?.closeDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each([['stream', 'embedding'], ['answer', 'embedding'], ['stream', 'scope'], ['answer', 'scope']] as const)('does not replay forgotten content after cross-process deletion during semantic lookup: %s / %s', async (mode, timing) => {
  const label = `${mode}-${timing}`;
  ask.invalidateAnswerCache();
  const sql = db.getSqlite();
  const removed = `cache-forgotten-${label}`, kept = `cache-retained-${label}`;
  const insert = sql.prepare(`INSERT INTO session_outcomes
    (id, project_id, repo_path, packet_id, runtime, outcome, summary, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'codex', 'succeeded', ?, datetime('now'), datetime('now'))`);
  insert.run(removed, projectId, repo, removed, `memorycanary forgotten ${label} parser fact`);
  insert.run(kept, projectId, repo, kept, `memorycanary retained ${label} parser fact`);
  const first = await (await route.POST(request(`What did the memorycanary parser decide ${label}?`))).text();
  expect(first).toContain(`forgotten ${label} parser fact`);
  expect(first).toContain(`retained ${label} parser fact`);
  await new Promise<void>(resolve => setImmediate(resolve));
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  gate.block = true; gate.entered = entered; gate.release = new Promise<void>(resolve => { release = resolve; });
  let deletions = 0;
  const forget = () => {
    const script = join(root, `forget-${label}.cjs`);
    writeFileSync(script, `globalThis.fetch=async()=>{throw new Error('Fixture refuses network access')};
      const load=require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});
      const {NextRequest}=load('next/server');
      const {DELETE}=load(${JSON.stringify(join(process.cwd(), 'src/app/api/cortex/recent-outcomes/route.ts'))});
      DELETE(new NextRequest('http://localhost/api/cortex/recent-outcomes', {method:'DELETE',
        headers:{authorization:'Bearer ${token}'},body:JSON.stringify(${JSON.stringify({ id: removed, repoPath: repo, projectId })})}))
        .then(response=>{console.log('FORGET_STATUS='+response.status);if(response.status!==200)process.exitCode=1});`);
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--import', join(process.cwd(), 'scripts/register-server-only-stub.mjs'), script], {
      cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') }, encoding: 'utf8', timeout: 30_000,
    });
    expect(output).toContain('FORGET_STATUS=200');
    deletions += 1;
  };
  gate.block = timing === 'embedding';
  if (timing === 'scope') { gate.readsLeft = 3; gate.afterRead = forget; }
  const pending = mode === 'stream'
    ? route.POST(request(`Recall the memorycanary parser decisions ${label}?`)).then(response => response.text())
    : ask.askCortex(`Recall the memorycanary parser decisions ${label}?`, repo, { projectId }).then(result => result.answer);
  try {
    if (timing === 'embedding') { await began; forget(); gate.block = false; release(); }
    const answer = await pending;
    expect(deletions).toBe(1);
    expect(answer).not.toContain(`forgotten ${label} parser fact`);
    expect(answer).toContain(`retained ${label} parser fact`);
  } finally { gate.block = false; gate.readsLeft = 0; gate.afterRead = null; release(); }
});
