import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const root = mkdtempSync(join(tmpdir(), 'o8-external-pr-'));
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'state.db'));
const input = vi.hoisted(() => ({ head: 'a'.repeat(40), base: 'b'.repeat(40) }));
const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base']);
input.base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'head']);
input.head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
const { addRepo } = await import('@/lib/repos/registry');
beforeAll(async () => { await addRepo(repo); });
vi.mock('@/lib/github-broker/auth', () => ({ githubInstallationFetch: async () => ({ response: Response.json({ number: 7, html_url: 'https://github.com/example/repo/pull/7', head: { sha: input.head }, base: { sha: input.base, ref: 'main', repo: { id: 123, full_name: 'example/repo' } } }) }) }));
vi.mock('@/lib/lane/orchestrator-backends/registry', async importOriginal => {
 const actual = await importOriginal<typeof import('@/lib/lane/orchestrator-backends/registry')>();
 const backend = { id: 'codex', label: 'Fixture reviewer', peekSession: () => ({ sessionName: 'review', status: 'ready' }), ensureSession: () => ({ sessionName: 'review', status: 'ready' }),
 async sendTurn(_repo: string, _prompt: string, emit: (v: {type: string; text: string}) => void, options?: {permissionMode?:string}) { expect(options?.permissionMode).toBe('plan'); emit({type:'text', text:'CODEX_AUTO_REVIEW: {"approved":false,"findings":[{"file":"answer.txt","severity":"note","description":"Preserve the request.","status":"deferred"}]}'}); } };
 return {...actual, getActiveReviewerBackend: () => backend, getOrchestratorBackend: () => backend};
});
vi.mock('@/lib/lane/packet-explainer-queue', () => ({ drainPacketExplainerQueue: async () => {}, enqueuePacketExplainer: async () => {}, notifyCorrectnessReviewQueued: () => {}, startPacketExplainerQueueDrain: () => () => {} }));
vi.mock('@/lib/lane/review-drain-bootstrap', () => ({ensureReviewQueueDrainStarted: vi.fn()}));
const { POST } = await import('@/app/api/tasks/adopt-pr/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const { readExternalReview, listExternalReviews } = await import('@/lib/tasks/external-review-store');
function request(token = getOrCreateWsToken()) { return new NextRequest('http://localhost/api/tasks/adopt-pr', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ repoPath: repo, pullRequest: 7 }) }); }
it('adopts once, appends immutable revisions and survives reopening the database', async () => {
  const first = await POST(request()); expect(first.status).toBe(200); const a = await first.json();
  const second = await POST(request()); const b = await second.json(); expect(b.taskId).toBe(a.taskId); expect(b.revision.id).toBe(a.revision.id);
  execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'corrected']);
  input.head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const changed = await (await POST(request())).json(); expect(changed.taskId).toBe(a.taskId); expect(changed.revision.sequence).toBe(2);
  expect(changed.state).toBe('waiting'); expect(listExternalReviews()).toHaveLength(1);
  closeDb();
  const cold = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); console.log(JSON.stringify(db.prepare('SELECT t.id,r.head_sha FROM external_pr_review_tasks t JOIN external_pr_review_revisions r ON r.id=t.current_revision_id').all())); db.close();`, join(root,'state.db')], {encoding:'utf8'});
  expect(JSON.parse(cold)[0]).toEqual({id:a.taskId,head_sha:input.head});
  expect(readExternalReview(a.taskId)?.revision.headSha).toBe(input.head);
});
it('starts the existing review path and preserves canonical findings, refusing author handoff', async () => {
 execFileSync('git', ['-C', repo, 'config', `url.${repo}/.insteadOf`, 'https://github.com/example/repo.git']);
 execFileSync('git', ['-C', repo, 'update-ref', 'refs/pull/7/head', input.head]);
 const task = listExternalReviews()[0];
 const { POST: start } = await import('@/lib/tasks/http/dispatch');
 const originalFetch = globalThis.fetch;
 vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => start(new NextRequest(url,{method:init?.method,headers:init?.headers,body:init?.body}),{params:Promise.resolve({taskId:task.taskId})}));
 try {
  const {handleTaskDispatch} = await import('@/lib/mcp/operator-handlers/task-dispatch');
  const started = await handleTaskDispatch({taskId:task.taskId}); expect(started.isError,JSON.stringify(started)).not.toBe(true);
 } finally { vi.stubGlobal('fetch',originalFetch); }
 const { drainReviewQueue } = await import('@/lib/lane/auto-review'); await drainReviewQueue();
 const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
 const packet = readOrchestratorControlPlaneState().packets.find(p => p.id === task.revision.packetId)!;
 expect(packet.review?.findings[0].resolution).toBe('deferred'); expect(packet.review?.reviewedHeadSha).toBe(input.head);
 const { correctAuthorFromReview } = await import('@/lib/orchestrator/review-author-correction');
 await expect(correctAuthorFromReview({repoPath:repo,threadId:'external',review:{packetId:packet.id,approvalId:packet.review!.auditApprovalId!, reviewedHeadSha:input.head,surfaceId:'codex-owned:reviewer',runId:'reviewer'}})).rejects.toThrow();
 const { getTaskPool } = await import('@/lib/tasks/pool');
 const pool = await getTaskPool({repoPath:repo,includeDone:true}); expect(pool.tasks.filter(t => t.externalReview)).toHaveLength(1);
}, 60000);
it('keeps the old verdict on its revision when another head is adopted', async () => {
 const old = listExternalReviews()[0]; expect(old.state).toBe('sent_back');
 execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'successor']);
 input.head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
 const next = await (await POST(request())).json(); expect(next.taskId).toBe(old.taskId); expect(next.state).toBe('waiting'); expect(next.revision.packetId).not.toBe(old.revision.packetId);
});
it('refuses worker and read-only credentials', async () => {
 const {getOrCreateLocalWorkerToken} = await import('@/lib/auth/worker-token');
 const {mintReadOnlyWorkerToken} = await import('@/lib/auth/read-only-worker-token');
 for (const token of [getOrCreateLocalWorkerToken(),mintReadOnlyWorkerToken('fixture')]) expect((await POST(request(token))).status).toBe(403);
});
it('routes CLI and MCP adoption to the same operator route', async () => {
 const original = globalThis.fetch;
 vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => POST(new NextRequest(String(url), {method:init?.method,headers:init?.headers,body:init?.body})));
 try {
  vi.stubEnv('O8_API_TOKEN',getOrCreateWsToken());
  const {handleAdoptPr} = await import('@/lib/mcp/operator-handlers/adopt-pr');
  const mcp = await handleAdoptPr({repoPath:repo,pullRequest:'https://github.com/example/repo/pull/7'});
  expect(mcp.isError).not.toBe(true);
  const {runTaskAdoptPr} = await import('../cli/src/commands/task');
  const output = vi.spyOn(process.stdout,'write').mockImplementation(() => true);
  try { expect(await runTaskAdoptPr({human:false,verbose:false},['7','--repo',repo])).toBe(0); }
  finally { output.mockRestore(); }
  expect(listExternalReviews()).toHaveLength(1);
 } finally { vi.stubGlobal('fetch', original); }
});
it('requires an affirmative operator token even on loopback', async () => { expect((await POST(request('invalid'))).status).toBe(403); });
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
