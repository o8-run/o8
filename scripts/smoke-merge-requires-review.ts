#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanupGovernanceSmokeRepo } from './lib/governance-smoke-cleanup';
import type * as ApprovalsStore from '../src/lib/approvals/store';
import type * as LaneCommands from '../src/lib/lane/commands';
import type * as LaneRegistry from '../src/lib/lane/registry';
import type * as HeadShaLock from '../src/lib/lane/head-sha-lock';
import type * as DurableReviewApproval from '../src/lib/lane/durable-review-approval';
import type * as MaterializationIdentity from '../src/lib/worktree/materialization-identity';
import type * as WorktreeMetaStore from '../src/lib/worktree/metadata-store';
import type * as OperatorMissionService from '../src/lib/orchestrator/operator-mission-service';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
let tempHome = '';

interface SmokeApi {
  setMergeMode: (projectId: string | null, mode: string) => void;
  createApproval: typeof ApprovalsStore.createApproval;
  listApprovalsForContext: typeof ApprovalsStore.listApprovalsForContext;
  markSecondPassAgreed: typeof ApprovalsStore.markSecondPassAgreed;
  recordApprovalAudit: typeof ApprovalsStore.recordApprovalAudit;
  dispatch: typeof LaneCommands.dispatch;
  captureWorktreeMaterializationIdentity: typeof MaterializationIdentity.captureWorktreeMaterializationIdentity;
  withWorktreeMetaTransaction: typeof WorktreeMetaStore.withWorktreeMetaTransaction;
  createLane: typeof LaneRegistry.createLane;
  submitPacketReview: typeof OperatorMissionService.submitPacketReview;
  hasDurableApprovedReview: typeof DurableReviewApproval.hasDurableApprovedReview;
  readHeadSha: typeof HeadShaLock.readHeadSha;
}

let api: SmokeApi;

type Lane = ReturnType<typeof LaneRegistry.createLane>;

interface CaseRepo {
  caseId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  packetId: string;
  sessionKey: string;
  lane: Lane;
  baseHead: string;
  markerPath: string;
  markerValue: string;
  cleanup: () => Promise<void>;
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, cwd);
}

function safeIdentifier(input: string): string {
  return input.replace(/[^A-Za-z0-9_]/g, '_');
}

function expectEqual<T>(caseName: string, actual: T, expected: T, detail: string): void {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw new Error(`${caseName}: ${detail}\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`);
  }
}

function expectTruthy(caseName: string, actual: unknown, detail: string): void {
  if (!actual) {
    throw new Error(`${caseName}: ${detail}\nexpected: truthy\nactual: ${JSON.stringify(actual)}`);
  }
}

function expectNotEqual(caseName: string, actual: string, unexpected: string, detail: string): void {
  if (actual === unexpected) {
    throw new Error(`${caseName}: ${detail}\nexpected: not ${unexpected}\nactual: ${actual}`);
  }
}

async function writeProjectLedger(projects: Array<{ id: string; name: string; repoPaths: string[] }>, activeProjectId: string): Promise<void> {
  const o8Dir = join(tempHome, '.o8');
  await mkdir(o8Dir, { recursive: true });
  await writeFile(join(o8Dir, 'projects.json'), JSON.stringify({
    projects: projects.map((project) => ({
      ...project,
      createdAt: new Date().toISOString(),
    })),
    activeProjectId,
  }, null, 2));
}

async function createCaseRepo(caseId: string, opts: { highRisk?: boolean; projectId?: string } = {}): Promise<CaseRepo> {
  const root = await mkdtemp(join(tmpdir(), `o8-governance-${caseId}-`));
  const repoPath = join(root, 'repo');
  await mkdir(repoPath, { recursive: true });

  // Mirror how real o8 worktrees symlink node_modules to the host repo, so the
  // merge's post-rebase `npx tsc --noEmit` resolves a real compiler. Without
  // this, npx fetches the `tsc` typosquat package and the merge typecheck fails
  // (false negative — the merge would succeed in a real repo).
  await symlink(join(repoRoot, 'node_modules'), join(repoPath, 'node_modules'), 'dir').catch(() => {});

  try {
    await git(repoPath, ['init', '-b', 'main']);
  } catch {
    await git(repoPath, ['init']);
    await git(repoPath, ['checkout', '-b', 'main']);
  }
  await git(repoPath, ['config', 'user.email', 'smoke@example.test']);
  await git(repoPath, ['config', 'user.name', 'Governance Smoke']);

  await mkdir(join(repoPath, 'src'), { recursive: true });
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({
    private: true,
    devDependencies: {
      typescript: '^5.8.2',
    },
  }, null, 2));
  await writeFile(join(repoPath, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Node',
      skipLibCheck: true,
      // Hermetic: don't auto-include the host repo's node_modules/@types (the
      // symlinked node_modules pulls in many ambient @types we don't want here).
      types: [],
    },
    include: ['src/**/*.ts'],
  }, null, 2));
  await writeFile(join(repoPath, 'src', 'index.ts'), 'export const base = "base";\n');
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'base']);
  const baseHead = await git(repoPath, ['rev-parse', 'main']);

  const branch = `lane/${caseId}`;
  await git(repoPath, ['checkout', '-b', branch]);
  const markerPath = opts.highRisk ? 'src/lib/db/schema.ts' : `src/${caseId}.ts`;
  const markerValue = `marker-${caseId}`;
  if (opts.highRisk) {
    await mkdir(join(repoPath, 'src', 'lib', 'db'), { recursive: true });
  }
  await writeFile(
    join(repoPath, markerPath),
    `export const ${safeIdentifier(caseId)} = ${JSON.stringify(markerValue)};\n`,
  );
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', `worker ${caseId}`]);
  await git(repoPath, ['checkout', 'main']);

  const worktreeBase = join(repoPath, '.cortex-worktrees');
  await mkdir(worktreeBase, { recursive: true });
  const worktreePath = join(worktreeBase, `${caseId}-wt`);
  await git(repoPath, ['worktree', 'add', worktreePath, branch]);

  const packetId = `pkt-${caseId}`;
  const sessionKey = `sess-${caseId}`;
  const worktreeId = `${caseId}-wt`;
  const materializationIdentity = await api.captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await api.captureWorktreeMaterializationIdentity(worktreeBase);
  await api.withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId,
    agentType: 'codex',
    sessionKey,
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: `Smoke ${caseId}`,
    branchName: branch,
    status: 'ready',
    isolationKind: 'git-worktree',
    materializationIdentity,
    materializationParentIdentity,
  }));

  const lane = api.createLane({
    repoPath,
    projectId: opts.projectId ?? `project-${caseId}`,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    label: `Smoke ${caseId}`,
    packetId,
    sessionKey,
    worktreePath,
    actor: 'system',
  });

  if (caseId === 'case-a') {
    const held = await api.dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    expectEqual('PR-FIRST', held.reason, 'pr_only', 'fresh project does not integrate directly');
    expectEqual('PR-FIRST', await git(repoPath, ['rev-parse', 'main']), baseHead, 'PR-first preserves main');
  }
  api.setMergeMode(lane.projectId, 'direct');
  return {
    caseId,
    repoPath,
    worktreePath,
    branch,
    packetId,
    sessionKey,
    lane,
    baseHead,
    markerPath,
    markerValue,
    cleanup: () => cleanupGovernanceSmokeRepo(root),
  };
}

async function mainHead(repo: CaseRepo): Promise<string> {
  return git(repo.repoPath, ['rev-parse', 'main']);
}

async function mainMarker(repo: CaseRepo): Promise<string> {
  return git(repo.repoPath, ['show', `main:${repo.markerPath}`]);
}

function approvalsFor(repo: CaseRepo) {
  return api.listApprovalsForContext({
    packetId: repo.packetId,
    laneId: repo.lane.id,
    sessionKey: repo.sessionKey,
    projectId: null,
  });
}

async function submitReview(repo: CaseRepo, approved: boolean): Promise<string | null> {
  const result = await api.submitPacketReview({
    packetId: repo.packetId,
    approved,
    findings: [],
  });
  return result.auditApprovalId ?? null;
}

async function assertMainUnchanged(caseName: string, repo: CaseRepo): Promise<void> {
  expectEqual(caseName, await mainHead(repo), repo.baseHead, 'local main SHA');
}

async function assertMainAdvanced(caseName: string, repo: CaseRepo): Promise<void> {
  const head = await mainHead(repo);
  expectNotEqual(caseName, head, repo.baseHead, 'local main should advance');
  expectEqual(caseName, await mainMarker(repo), `export const ${safeIdentifier(repo.caseId)} = ${JSON.stringify(repo.markerValue)};`, 'main marker content');
}

async function caseA(): Promise<void> {
  const repo = await createCaseRepo('case-a');
  try {
    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'orchestrator' });
    expectEqual('CASE A', result.ok, false, 'never-reviewed orchestrator merge result.ok');
    expectTruthy('CASE A', result.approvalId, 'approval card id');
    await assertMainUnchanged('CASE A', repo);
    expectEqual(
      'CASE A',
      approvalsFor(repo).some((approval) => approval.toolName === 'orchestrator_review' && approval.status === 'approved'),
      false,
      'no approved orchestrator_review row should exist',
    );
  } finally {
    await repo.cleanup();
  }
}

async function caseB(): Promise<void> {
  const repo = await createCaseRepo('case-b');
  try {
    await submitReview(repo, true);
    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'orchestrator' });
    expectEqual('CASE B', result.ok, true, 'approved orchestrator merge result.ok');
    await assertMainAdvanced('CASE B', repo);
  } finally {
    await repo.cleanup();
  }
}

async function caseC(): Promise<void> {
  const repo = await createCaseRepo('case-c');
  try {
    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'user' });
    expectEqual('CASE C', result.ok, true, 'user merge result.ok');
    await assertMainAdvanced('CASE C', repo);
  } finally {
    await repo.cleanup();
  }
}

async function caseD(): Promise<void> {
  const repo = await createCaseRepo('case-d');
  try {
    await submitReview(repo, true);
    const reviewedHead = await api.readHeadSha(repo.worktreePath, repo.lane.repoPath);
    await writeFile(
      join(repo.worktreePath, 'src', 'case-d-rerun.ts'),
      'export const case_d_rerun = "new-head";\n',
    );
    await git(repo.worktreePath, ['add', '-A']);
    await git(repo.worktreePath, ['commit', '-m', 'rerun new head']);
    const currentHead = await api.readHeadSha(repo.worktreePath, repo.lane.repoPath);
    expectNotEqual('CASE D', currentHead, reviewedHead, 'worktree HEAD should move after review');

    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'orchestrator' });
    expectEqual('CASE D', result.ok, false, 'stale approved review merge result.ok');
    expectTruthy('CASE D', result.approvalId, 'approval card id');
    await assertMainUnchanged('CASE D', repo);
  } finally {
    await repo.cleanup();
  }
}

async function caseE(): Promise<void> {
  const repo = await createCaseRepo('case-e', { projectId: 'project-lane' });
  try {
    await writeProjectLedger([
      { id: 'project-lane', name: 'Lane Project', repoPaths: [repo.repoPath] },
      { id: 'project-other', name: 'Other Project', repoPaths: [] },
    ], 'project-lane');
    await submitReview(repo, true);
    await writeProjectLedger([
      { id: 'project-lane', name: 'Lane Project', repoPaths: [repo.repoPath] },
      { id: 'project-other', name: 'Other Project', repoPaths: [] },
    ], 'project-other');

    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'orchestrator' });
    expectEqual('CASE E', result.ok, true, 'cross-project approved merge result.ok');
    await assertMainAdvanced('CASE E', repo);
  } finally {
    await repo.cleanup();
  }
}

async function caseF(): Promise<void> {
  const repo = await createCaseRepo('case-f');
  try {
    await submitReview(repo, false);
    const approval = api.createApproval({
      source: 'test',
      runtime: 'codex',
      agent: 'Governance Smoke',
      sessionKey: repo.sessionKey,
      title: 'Regex-truthy audit event',
      description: 'Pending lane card with a truthy orchestrator_review audit event.',
      summary: 'Regex-truthy audit event',
      risk: 'high',
      metadata: {
        Packet: repo.packetId,
        Lane: repo.lane.id,
      },
    });
    api.recordApprovalAudit(approval.id, 'orchestrator_review', 'orchestrator', 'Approved, ready to merge.', {
      approved: true,
      reviewer: 'orchestrator',
    });

    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'orchestrator' });
    expectEqual('CASE F', result.ok, false, 'rejected review plus truthy audit event result.ok');
    expectTruthy('CASE F', result.approvalId, 'approval card id');
    await assertMainUnchanged('CASE F', repo);
  } finally {
    await repo.cleanup();
  }
}

async function caseG(): Promise<void> {
  const repo = await createCaseRepo('case-g', { highRisk: true });
  try {
    const approvalId = await submitReview(repo, true);
    expectTruthy('CASE G', approvalId, 'orchestrator review approval id');
    const reviewApproval = approvalsFor(repo).find((approval) => approval.id === approvalId);
    expectEqual('CASE G', reviewApproval?.args?.requiresSecondPass, true, 'high-risk approval requires second pass');
    expectEqual('CASE G', reviewApproval?.args?.secondPassAgreed, false, 'second pass starts unagreed');

    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'orchestrator' });
    expectEqual('CASE G', result.ok, false, 'high-risk first-pass-only merge result.ok');
    expectTruthy('CASE G', result.approvalId, 'approval card id');
    await assertMainUnchanged('CASE G', repo);
    expectEqual('CASE G', await api.hasDurableApprovedReview(repo.lane), false, 'first-pass high-risk review is not durable approval');
  } finally {
    await repo.cleanup();
  }
}

async function caseH(): Promise<void> {
  const repo = await createCaseRepo('case-h', { highRisk: true });
  try {
    const approvalId = await submitReview(repo, true);
    expectTruthy('CASE H', approvalId, 'orchestrator review approval id');
    api.markSecondPassAgreed(approvalId!);
    expectEqual('CASE H', await api.hasDurableApprovedReview(repo.lane), true, 'second-pass agreement makes review durable');

    const result = await api.dispatch({ verb: 'merge', laneId: repo.lane.id, actor: 'orchestrator' });
    expectEqual('CASE H', result.ok, true, 'high-risk second-pass-agreed merge result.ok');
    await assertMainAdvanced('CASE H', repo);
  } finally {
    await repo.cleanup();
  }
}

async function main(): Promise<void> {
  tempHome = await mkdtemp(join(tmpdir(), 'o8-governance-home-'));
  const tempDataDir = process.env.CORTEX_IDE_DATA_DIR || await mkdtemp(join(tmpdir(), 'o8-governance-data-'));
  process.env.HOME = tempHome;
  process.env.CORTEX_IDE_DATA_DIR = tempDataDir;
  process.env.O8_DATA_DIR = tempDataDir;
  process.env.PATH = `${join(repoRoot, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`;

  // Server-only modules (@/lib/db et al.) are imported below; run this script
  // with NODE_OPTIONS=--conditions=react-server so the `server-only` guard
  // resolves to a no-op instead of throwing (see CLAUDE.md / smoke pattern).
  const [
    approvalsStore,
    laneCommands,
    laneRegistry,
    operatorMissionService,
    headShaLock,
    durableReviewApproval,
    materializationIdentity,
    worktreeMetaStore,
  ] = await Promise.all([
    import('@/lib/approvals/store'),
    import('@/lib/lane/commands'),
    import('@/lib/lane/registry'),
    import('@/lib/orchestrator/operator-mission-service'),
    import('@/lib/lane/head-sha-lock'),
    import('@/lib/lane/durable-review-approval'),
    import('@/lib/worktree/materialization-identity'),
    import('@/lib/worktree/metadata-store'),
  ]);
  const { getSqlite } = await import('@/lib/db');
  const { projectMergeModeKey } = await import('@/lib/lane/project-merge-mode-migration');
  api = {
    setMergeMode: (projectId, mode) => {
      getSqlite().prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(projectMergeModeKey(projectId ?? 'default'), mode, Date.now());
    },
    createApproval: approvalsStore.createApproval,
    listApprovalsForContext: approvalsStore.listApprovalsForContext,
    markSecondPassAgreed: approvalsStore.markSecondPassAgreed,
    recordApprovalAudit: approvalsStore.recordApprovalAudit,
    dispatch: laneCommands.dispatch,
    createLane: laneRegistry.createLane,
    submitPacketReview: operatorMissionService.submitPacketReview,
    hasDurableApprovedReview: durableReviewApproval.hasDurableApprovedReview,
    readHeadSha: headShaLock.readHeadSha,
    captureWorktreeMaterializationIdentity: materializationIdentity.captureWorktreeMaterializationIdentity,
    withWorktreeMetaTransaction: worktreeMetaStore.withWorktreeMetaTransaction,
  };

  await caseA();
  await caseB();
  await caseC();
  await caseD();
  await caseE();
  await caseF();
  await caseG();
  await caseH();
  console.log('smoke-merge-requires-review passed: 8/8 cases');
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
