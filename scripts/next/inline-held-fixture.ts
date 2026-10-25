/** Managed local Git lane and real approvals; no account-backed worker or reviewer. */
import { execFileSync } from 'node:child_process';
import { realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PacketTaskContract } from '../../src/lib/orchestrator/types';

export async function seedInlineHeldFixture(repo: string, policyHeld = false) {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  await (await import('../../src/lib/operator/defaults')).updateOperatorDefaults({ requireApproval: policyHeld ? 'always' : 'never' });
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.test');
  git(repo, 'checkout', '-B', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'held base');
  const remote = join(repo, '..', 'inline-origin.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'main');
  const packetId = 'next-inline';
  const branch = 'fixture-inline-held';
  const { getWorktreeManager } = await import('../../src/lib/worktree/launch');
  const worktree = await getWorktreeManager(repo).create({ agentType: 'codex', taskName: packetId,
    branchName: branch, baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' });
  const cwd = realpathSync(worktree.path);
  writeFileSync(join(cwd, 'inline-change.txt'), 'owned held change\n');
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'held change');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const baseHead = git(repo, 'rev-parse', 'main');
  const { createLane, setLaneStatus } = await import('../../src/lib/lane/registry');
  const lane = createLane({ repoPath: repo, worktreePath: cwd, branch, baseBranch: 'main', runtime: 'codex',
    packetId, sessionKey: 'codex:next-inline', label: 'Held inline fixture' });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  const taskContract: PacketTaskContract = { version: 1, requirements: [{ id: 'R1', source: 'Commit a file change.',
    expectedBehavior: 'The file change is committed.', productionPath: 'inline-change.txt', verification: 'git show HEAD' }],
  processConstraints: [], smallestRoute: [{ path: 'inline-change.txt', requirements: ['R1'], reason: 'Owned file change.' }], exclusions: [] };
  const { normalizeOrchestratorMissionState } = await import('../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../src/lib/orchestrator/control-plane');
  const state = normalizeOrchestratorMissionState({ version: 2, missionId: 'inline-held-mission', repoPath: repo,
    runtime: 'codex', prompt: 'Held merge fixture', summary: 'Held merge fixture', constraints: '', packets: [{ id: packetId,
      referenceLabel: packetId, title: 'Held inline fixture', summary: 'Held inline fixture', workspaceTargetPath: repo,
      branchTarget: branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [], queueState: 'released',
      releaseState: 'pending', status: 'awaiting_review', blockedReason: null, review: null, lane: null, attemptCount: 1,
      mergeHold: !policyHeld, taskContractRequired: true, taskContractSource: 'default', taskContract, orchestratorThreadId: 'inline-held-thread' }] });
  (await import('../../src/lib/db/missions-store')).recordMission({ id: state.missionId!, repoPath: repo,
    runtime: 'codex', prompt: state.prompt, summary: state.summary, constraints: '',
    packetMeta: [{ id: packetId, title: 'Held inline fixture', referenceLabel: packetId }], missionState: state, totalWaves: 1 });
  writeOrchestratorControlPlaneState(state);
  const { recordOrchestratorReview, listApprovalsForContext } = await import('../../src/lib/approvals/store');
  recordOrchestratorReview(packetId, { approved: true, findings: [], reviewedHeadSha: head, requiresSecondPass: false,
    contractCoverageEvidence: { contractVersion: 1, headSha: head, entries: [{ requirementId: 'R1', productionPath: 'inline-change.txt' }], processEntries: [] } });
  let changeBeforeConfirm = false;
  const rejectReview = () => recordOrchestratorReview(packetId, { approved: false, findings: [{ file: 'inline-change.txt',
    severity: 'bug', description: 'Fixture review changed.', resolution: 'deferred' }], reviewedHeadSha: head, requiresSecondPass: false });
  return {
    beforeConfirm: () => { if (changeBeforeConfirm) { changeBeforeConfirm = false; rejectReview(); } },
    snapshot: () => {
      const card = listApprovalsForContext({ packetId }).find(a => a.continuation?.kind === 'lane' && a.continuation.verb === 'merge');
      return { baseHead, currentBase: git(repo, 'rev-parse', 'main'), head,
        approval: card ? { id: card.id, status: card.status, continuationStatus: card.resolution?.continuationStatus } : null };
    },
    change: async (kind: string) => {
      if (kind === 'dirty') writeFileSync(join(cwd, 'scratch.txt'), 'desktop draft\n');
      else if (kind === 'head') { writeFileSync(join(cwd, 'inline-change.txt'), 'new desktop revision\n'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'desktop revision'); }
      else if (kind === 'review') rejectReview();
      else if (kind === 'race-review') changeBeforeConfirm = true;
      else if (kind === 'governance') {
        const card = listApprovalsForContext({ packetId }).find(a => a.continuation?.kind === 'lane' && a.continuation.verb === 'merge');
        if (!card) throw new Error('Missing owned merge approval');
        (await import('../../src/lib/approvals/store')).recordApprovalAudit(card.id, 'updated', 'system', 'Owned approval annotation changed.');
      }
      else if (kind === 'contract') await (await import('../../src/lib/orchestrator/operator-mission-service/packet-patch')).patchMissionPacket(packetId, { taskContract: { ...taskContract,
        requirements: [...taskContract.requirements, { id: 'R2', source: 'A new requirement.', expectedBehavior: 'Re-review this requirement.', productionPath: 'inline-change.txt', verification: 'Inspect updated coverage.' }] } });
      else if (kind === 'runtime') setLaneStatus(lane.id, 'running', 'system', 'fixture_runtime_active');
      else if (kind === 'stop') await (await import('../../src/lib/orchestrator/operator-mission-service/packet-patch')).patchMissionPacket(packetId, { operatorStopped: true, queueState: 'held', holdIntent: 'operator' });
      else if (kind === 'restriction') (await import('../../src/lib/db/session-rules-store')).addSessionRule('inline-held-thread', 'Do not merge this fixture.', 'no_merge');
      else if (kind === 'repair-dirty') unlinkSync(join(cwd, 'scratch.txt'));
      else throw new Error('Unknown fixture change');
    },
  };
}
