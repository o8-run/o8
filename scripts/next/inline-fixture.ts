/** Owned text hunks and a deliberately unreviewed lane; merge must run its gates. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorPacket } from '../../src/lib/orchestrator/types';
export async function seedInlineFixture(repo: string, committed = false) {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('checkout', '-B', 'main');
  const lines = Array.from({ length: 120 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
  writeFileSync(join(repo, 'changed.ts'), lines.join('\n') + '\n'); writeFileSync(join(repo, 'other.txt'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'fixture base');
  if (committed) git('branch', '-m', 'fixture-base');
  git('checkout', '-b', 'fixture-inline');
  for (const index of [9, 59, 109]) lines[index] = `export const line${index + 1} = 999;`;
  writeFileSync(join(repo, 'changed.ts'), lines.join('\n') + '\n'); writeFileSync(join(repo, 'other.txt'), 'after\n');
  if (committed) { git('add', '.'); git('commit', '-qm', 'fixture committed changes'); }
  await (await import('../../src/lib/repos/registry')).addRepo(repo);
  const { createLane, setLaneStatus } = await import('../../src/lib/lane/registry');
  const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'fixture-inline', baseBranch: committed ? 'fixture-base' : 'main', runtime: 'codex', packetId: 'next-inline', label: 'Inline fixture' });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  const { writeOrchestratorControlPlaneState } = await import('../../src/lib/orchestrator/control-plane');
  const { createEmptyOrchestratorMissionState } = await import('../../src/lib/orchestrator/store');
  const packet = { id: 'next-inline', referenceLabel: 'next-inline', title: 'Inline fixture', summary: 'Unreviewed fixture', workspaceTargetPath: repo,
    branchTarget: 'fixture-inline', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
    status: 'awaiting_review', blockedReason: null, lane: null, review: null, attemptCount: 1 } as OrchestratorPacket;
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'inline-fixture', repoPath: repo, runtime: 'codex', packets: [packet], updatedAt: new Date().toISOString() });
}
