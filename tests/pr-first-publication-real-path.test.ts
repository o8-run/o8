import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}), requestRealtimeRefresh: vi.fn() }));
const root = mkdtempSync(join(tmpdir(), 'o8-pr-first-publication-'));
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'test.db'), WS_TOKEN: 'policy-operator-fixture-token', O8_SKIP_PRELAUNCH_TYPECHECK: '1' });
writeFileSync(join(root, 'mobile-device-tokens'), `${createHash('sha256').update('policy-device-fixture-token').digest('hex')}\n`);
const { createProject } = await import('@/lib/projects/store');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { dispatchSecondPassMerge } = await import('@/lib/lane/second-pass-merge-dispatch');
const { closeDb } = await import('@/lib/db');
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const repo = mkdtempSync(join(root, 'repo-')); mkdirSync(join(repo, 'src'));
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'base.txt'), 'base'); git(repo, 'add', 'base.txt'); git(repo, 'commit', '-qm', 'base');
  const project = createProject({ name: `Policy ${repo.split('/').pop()}` });
  const packetId = `pkt-${project.id}`;
  const worktree = await getWorktreeManager(repo).create({ agentType: 'codex', taskName: packetId, packetId, branchName: `fixture/${project.id}`, baseBranch: 'main', skipSetup: true, isolationPreference: 'git-worktree' });
  const lane = createLane({ repoPath: repo, projectId: project.id, branch: worktree.branch, worktreePath: worktree.path, baseBranch: 'main', runtime: 'codex', packetId });
  return { repo, worktree, lane, base: git(repo, 'rev-parse', 'main') };
}
it.each([null, 'https://github.com/example/project.git', 'https://gitlab.com/example/project.git', 'https://code.example.test/example/project.git'])('delivery guidance is true for origin %s and automatic agreement settles without merge retries', async origin => {
  const f = await fixture();
  if (origin) git(f.repo, 'remote', 'add', 'origin', origin);
  const { prFirstMergeRefusal } = await import('@/lib/lane/pr-first-delivery');
  const note = await prFirstMergeRefusal(f.lane);
  expect(note).toContain('Branch retained');
  if (!origin) { expect(note).toContain('no origin remote'); expect(note).not.toContain('open a pull request'); }
  else if (origin.includes('github.com')) { expect(note).toContain('Create PR'); expect(note).not.toContain('/api/'); }
  else if (origin.includes('gitlab.com')) { expect(note).toContain('GitLab'); expect(note).toContain('merge request'); expect(note).not.toContain('unsupported'); }
  else { expect(note).toContain('not identified'); expect(note).not.toContain('Next:'); }
  const input = { lane: f.lane, approvalId: `approval-${f.lane.id}`, reviewedHeadSha: f.base };
  const agreement = await dispatchSecondPassMerge({ ...input, trigger: 'second_pass_agreed' });
  const retry = await dispatchSecondPassMerge({ ...input, trigger: 'stall_reconcile' });
  expect(agreement).toMatchObject({ ok: false, dispatched: false, note });
  expect(retry.dispatched).toBe(false); expect(retry.note).toContain(note!);
  expect(getLaneEvents(f.lane.id).filter(event => event.verb === 'merge_dispatch_attempted')).toHaveLength(1);
  expect(getLaneEvents(f.lane.id).some(event => event.verb === 'merge_dispatch_failed')).toBe(true);
  expect(getLane(f.lane.id)?.status).toBe('awaiting_orchestrator'); expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
});
