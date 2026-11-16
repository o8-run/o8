import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { phoneToolHandler, PHONE_TOOL_REVIEW_BUILDERS } from '@/lib/symon/execution/dispatcher';
import type { Json } from '@/lib/symon/execution/handlers/transport';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'phone-git-'))), record = join(root, 'record'), mode = join(root, 'mode'), pid = join(root, 'pid');
const repo = { id: 'git-fixture', name: 'fixture', localPath: root };
const signal = new AbortController().signal;
const call = (tool: string, args: Json = {}, abort = signal) => phoneToolHandler(tool, { repo: 'fixture', ...args }, { signal: abort }) as Promise<Json>;
const tools = ['git_status', 'git_log', 'repo_commit_diff', 'gh_pr_list', 'gh_issue_list', 'gh_issue_view', 'gh_pr_view', 'gh_triage', 'gh_issue_create', 'gh_comment'];
const args = (tool: string): Json => tool === 'repo_commit_diff' ? { repoPath: root, sha: 'HEAD' } : { number: 7, kind: 'issue', title: 'Fixture issue', body: 'Fixture body' };
const server = createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ repos: [repo] })));
beforeAll(async () => {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, '-data;$(literal)'), 'hello\n');
  writeFileSync(join(root, 'large'), 'large line\n'.repeat(6000));
  execFileSync('git', ['add', '--', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture commit'], { cwd: root });
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2); let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({args, input, cwd:process.cwd()})+'\\n');
const mode = fs.readFileSync(${JSON.stringify(mode)},'utf8');
if(mode==='sleep') { const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pid)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000); return; }
if(mode==='fail') { console.error('fixture refusal'); process.exitCode=1; return; }
if(args[0]==='repo') console.log(mode==='slug' ? '--bad/owner/extra' : 'owner/repository');
else if(args[0]==='api') console.log('[]');
else if(args[1]==='list') console.log('[]');
else if(args[1]==='view') console.log(JSON.stringify({title:'Fixture title',body:'é'.repeat(8000),comments:[],reviews:[],statusCheckRollup:[]}));
else console.log('https://github.com/owner/repository/issues/7');
});
`, { mode: 0o755 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  vi.stubEnv('O8_API_PORT', String(address.port)); vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
});
beforeEach(() => { writeFileSync(mode, 'ok'); writeFileSync(record, ''); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it.each(tools)('%s succeeds through the dispatcher and refuses an unregistered repo before spawn', async tool => {
  expect(await call(tool, args(tool))).not.toHaveProperty('error');
  writeFileSync(record, '');
  expect(await call(tool, { ...args(tool), repo: '/unregistered', ...(tool === 'repo_commit_diff' ? { repoPath: '/unregistered' } : {}) })).toHaveProperty('error');
  expect(readFileSync(record, 'utf8')).toBe('');
});
it.each(['gh_pr_list', 'gh_issue_list', 'gh_issue_view', 'gh_pr_view', 'gh_triage', 'gh_issue_create', 'gh_comment'])('%s preserves process refusals', async tool => {
  writeFileSync(mode, 'fail'); expect(await call(tool, args(tool))).toHaveProperty('error', 'fixture refusal');
});
it('passes leading dashes and shell syntax as literal write arguments', async () => {
  const text = '-flag; $(touch unwanted) `echo nope`';
  await call('gh_issue_create', { title: text, body: text }); await call('gh_comment', { number: 7, kind: 'pr', body: text });
  const records = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(records).toEqual([{ args: ['issue', 'create', '--title', text, '--body', text], input: '', cwd: root }, { args: ['pr', 'comment', '7', '--body', text], input: '', cwd: root }]);
  expect(existsSync(join(root, 'unwanted'))).toBe(false);
  expect(await call('repo_commit_diff', { repoPath: root, sha: 'HEAD', file: '-data;$(literal)' })).toMatchObject({ truncated: false, patch: expect.stringContaining('hello') });
});
it.each([{ sha: '-HEAD' }, { sha: 'HEAD;echo' }, { sha: 'HEAD', file: '../outside' }, { sha: 'missing' }])('refuses unsafe or missing diff targets %j', async values => {
  expect(await call('repo_commit_diff', { repoPath: root, ...values })).toHaveProperty('error');
});
it.each([['gh_issue_view', { number: -1 }], ['gh_pr_view', { number: '--help' }], ['gh_comment', { number: 7, kind: 'repo', body: 'x' }], ['gh_comment', { number: 7, kind: 'issue', body: '' }], ['gh_issue_create', { title: '' }], ['gh_triage', { since_hours: 721 }]])('validates %s arguments', async (tool, values) => {
  expect(await call(String(tool), values as Json)).toHaveProperty('error'); expect(readFileSync(record, 'utf8')).toBe('');
});
it('validates resolved remote slugs', async () => { writeFileSync(mode, 'slug'); expect(await call('gh_pr_view', { number: 7 })).toHaveProperty('error', "The tracked repo's GitHub remote did not resolve to owner/name"); });
it('bounds patches and GitHub bodies on UTF-8 boundaries', async () => {
  const diff = await call('repo_commit_diff', { repoPath: root, sha: 'HEAD' });
  expect(diff.truncated).toBe(true); expect(Buffer.byteLength(String(diff.patch))).toBeLessThan(16384); expect(diff.patch).toContain('truncated');
  const issue = await call('gh_issue_view', { number: 7 }); expect(issue.truncated).toBe(true);
  const data = (issue.observedData as Json).data as Json; expect(data.bodyTruncated).toBe(true); expect(Buffer.byteLength(String(data.body))).toBeLessThanOrEqual(6144); expect(data.body).not.toContain('�');
});
it('kills the process and its child on abort', async () => {
  writeFileSync(mode, 'sleep'); const controller = new AbortController();
  const waiting = call('gh_issue_list', {}, controller.signal); const rejected = expect(waiting).rejects.toThrow();
  await vi.waitFor(() => expect(existsSync(pid)).toBe(true));
  const pids = JSON.parse(readFileSync(pid, 'utf8')) as number[];
  controller.abort(); await rejected;
  await vi.waitFor(() => { for (const id of pids) expect(() => process.kill(id, 0)).toThrow(); });
});
it('reviews both writes with the resolved target and redacts credentials', async () => {
  const issue = await PHONE_TOOL_REVIEW_BUILDERS.gh_issue_create({ repo: 'fixture', title: 'Fixture title' }, { signal });
  expect(issue.summary).toContain('fixture'); expect(issue.summary).toContain('Fixture title');
  const comment = await PHONE_TOOL_REVIEW_BUILDERS.gh_comment({ repo: 'fixture', kind: 'pr', number: 7, body: 'Opening text Authorization: Bearer fixture-secret-123456789' }, { signal });
  expect(comment.summary).toContain('pull request #7 in fixture'); expect(comment.summary).toContain('Opening text'); expect(comment.summary).not.toContain('fixture-secret-123456789');
});
it.each(['symon_execute_plan', 'symon_machine_list', 'symon_machine_switch', 'symon_ledger_recent', 'symon_ledger_undo', 'symon_watch', 'symon_watch_run', 'agent_turn', 'escalate'])('%s remains deferred', async tool => { expect(await call(tool)).toEqual({ error: 'desktop_unavailable' }); });
it('retains the Git result projections and structured diff refusal codes', async () => {
  expect(await call('git_status')).toHaveProperty('status', expect.stringContaining('##'));
  expect(await call('git_log', { count: 1 })).toHaveProperty('commits', expect.stringContaining('Fixture commit'));
  expect(await call('repo_commit_diff', { repoPath: root, sha: '-HEAD' })).toMatchObject({ error: 'invalid_ref', detail: expect.any(String) });
  expect(await call('repo_commit_diff', { repoPath: root, sha: 'HEAD', file: 'missing' })).toMatchObject({ error: 'empty_result', detail: expect.any(String) });
});
it('preserves view, list and triage result envelopes and read-only REST arguments', async () => {
  expect(await call('gh_pr_list')).toMatchObject({ observedData: { source: 'github_cli', data: { count: 0, prs: [] } }, truncated: false });
  expect(await call('gh_issue_list')).toMatchObject({ observedData: { data: { count: 0, issues: [] } } });
  expect(await call('gh_pr_view', { number: 7 })).toMatchObject({ observedData: { source: 'github_cli_and_rest_api', data: { number: 7, thread: [], checks: { total: 0 }, reviewStates: { approvedCount: 0 } } } });
  expect(await call('gh_triage', { since_hours: 24 })).toMatchObject({ observedData: { data: { sinceHours: 24, counts: { total: 0 }, groups: [{ repo: 'owner/repository' }], skippedRepoCount: 0 } } });
  const records = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const api = records.filter(r => r.args[0] === 'api');
  expect(api).toHaveLength(4);
  for (const r of api) { expect(r.args.slice(0, 4)).toEqual(['api', '--method', 'GET', '--']); expect(r.args[4]).toContain('per_page=100&page=1'); }
});
