import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

/** Mutates only the disposable host's real persisted mission store. */
export async function pullRequestGatesFixture(repo: string, change: (scenario: string) => void) {
  const { normalizeOrchestratorMissionState } = await import('../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../src/lib/orchestrator/control-plane');
  const { recordMission } = await import('../../src/lib/db/missions-store');
  const mission = normalizeOrchestratorMissionState({ version: 2, missionId: 'fixture-pr-mission', repoPath: repo,
    runtime: 'codex', prompt: 'PR fixture', summary: 'PR fixture', constraints: '', packets: [
      { id: 'next-pr-unwired', workspaceTargetPath: repo, branchTarget: 'fixture-8', status: 'awaiting_review' },
      { id: 'next-pr-drift', workspaceTargetPath: repo, branchTarget: 'fixture-9', status: 'awaiting_review' },
    ] });
  const persist = () => {
    recordMission({ id: mission.missionId!, repoPath: repo, runtime: 'codex', prompt: mission.prompt,
      summary: mission.summary ?? '', constraints: mission.constraints ?? '', packetMeta: mission.packets.map(p => ({ id: p.id, title: p.title, referenceLabel: p.referenceLabel })),
      missionState: mission, totalWaves: 1 });
    writeOrchestratorControlPlaneState(mission);
  };
  persist();
  let worktree: string | undefined;
  return {
    state: async () => Response.json({ mission }),
    control: async (request: NextRequest) => {
      const body = await request.json() as { packet?: 'held' | 'blocked'; worktree?: boolean; owner?: 'worktree'; scenario?: string };
      if (body.scenario) change(body.scenario);
      if (['corrupt-review-source', 'corrupt-repair-source', 'missing-packet-branch'].includes(body.scenario ?? '')) {
        const state = normalizeOrchestratorMissionState({ ...mission, missionId: 'fixture-corrupt-source-mission', packets: [{
          id: 'fixture-corrupt-source-held', workspaceTargetPath: repo, branchTarget: 'other-name', status: 'archived',
          mergeHold: true, reviewSource: { pullRequest: 7, headSha: 'a'.repeat(40) },
        }] });
        recordMission({ id: state.missionId!, repoPath: repo, runtime: 'codex', prompt: state.prompt, summary: state.summary ?? '',
          constraints: '', packetMeta: [], missionState: state, totalWaves: 1 });
        const raw = JSON.parse(JSON.stringify(state)) as { packets: Array<Record<string, unknown>> };
        delete raw.packets[0].reviewSource;
        if (body.scenario === 'missing-packet-branch') delete raw.packets[0].branchTarget;
        else raw.packets[0][body.scenario === 'corrupt-review-source' ? 'reviewSource' : 'repairSource'] = { pullRequest: 7, headSha: 'damaged' };
        const { getSqlite } = await import('../../src/lib/db');
        getSqlite().prepare('UPDATE missions SET archived_at = ?, mission_state_json = ? WHERE id = ?').run(Date.now(), JSON.stringify(raw), state.missionId);
      }
      if (['corrupt-registry', 'legacy-null', 'legacy-empty'].includes(body.scenario ?? '')) {
        const state = normalizeOrchestratorMissionState({ ...mission, missionId: 'fixture-availability-mission', packets: [{
          id: 'fixture-availability-held', workspaceTargetPath: repo, branchTarget: 'fixture-7', status: 'archived',
          mergeHold: true, reviewSource: { pullRequest: 7, headSha: 'a'.repeat(40) },
        }] });
        recordMission({ id: state.missionId!, repoPath: repo, runtime: 'codex', prompt: state.prompt, summary: state.summary ?? '',
          constraints: '', packetMeta: [], missionState: state, totalWaves: 1 });
        const { getSqlite } = await import('../../src/lib/db');
        getSqlite().prepare('UPDATE missions SET archived_at = ?, mission_state_json = ? WHERE id = ?')
          .run(Date.now(), body.scenario === 'corrupt-registry' ? '{' : body.scenario === 'legacy-empty' ? '' : null, state.missionId);
      }
      if (body.scenario === 'unrelated-draft') {
        const state = normalizeOrchestratorMissionState({ ...mission, missionId: 'fixture-draft-mission', packets: [
          { id: 'fixture-unassigned-draft', queueState: 'draft', status: 'draft' },
        ] });
        recordMission({ id: state.missionId!, repoPath: repo, runtime: 'codex', prompt: state.prompt,
          summary: state.summary ?? '', constraints: '', packetMeta: [], missionState: state, totalWaves: 1 });
      }
      const controlPath = join(process.env.O8_DATA_DIR!, 'orchestrator-state.json');
      if (body.scenario === 'corrupt-control') writeFileSync(controlPath, '{');
      if (body.scenario === 'invalid-control-shape') writeFileSync(controlPath, JSON.stringify({ version: 1, mission: { packets: null } }));
      if (body.scenario === 'absent-control') rmSync(controlPath);
      if (body.scenario === 'owner-unavailable') {
        const missing = join(repo, '..', 'missing-owner');
        const state = normalizeOrchestratorMissionState({ ...mission, missionId: 'fixture-missing-mission', repoPath: missing,
          packets: [{ id: 'fixture-unavailable-held', workspaceTargetPath: missing, branchTarget: 'fixture-7', status: 'awaiting_review',
            mergeHold: true, reviewSource: { pullRequest: 7, headSha: 'a'.repeat(40) } }] });
        recordMission({ id: state.missionId!, repoPath: missing, runtime: 'codex', prompt: state.prompt, summary: state.summary,
          constraints: '', packetMeta: [{ id: state.packets[0].id, title: state.packets[0].title, referenceLabel: state.packets[0].referenceLabel }], missionState: state, totalWaves: 1 });
      }
      if (body.scenario === 'foreign-repo') {
        const foreign = join(repo, '..', 'foreign-repo');
        mkdirSync(foreign);
        execFileSync('git', ['init', '-q', foreign]);
        execFileSync('git', ['-C', foreign, 'remote', 'add', 'origin', 'https://github.com/other/repo.git']);
        const packet = normalizeOrchestratorMissionState({ ...mission, packets: [{ id: 'fixture-foreign-held',
          workspaceTargetPath: foreign, branchTarget: 'fixture-7', status: 'awaiting_review', mergeHold: true,
          reviewSource: { pullRequest: 7, headSha: 'a'.repeat(40) } }] }).packets[0];
        mission.packets.push(packet); persist();
      }
      if (body.worktree && !worktree) {
        execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture base']);
        const target = join(repo, '..', 'linked-pr-worktree');
        execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'fixture-linked', target]);
        worktree = realpathSync(target);
      }
      if (body.packet || ['held', 'blocked', 'archived-held', 'fork-collision', 'explicit-pr-other-branch'].includes(body.scenario ?? '')) {
        const held = body.packet === 'held' || ['held', 'archived-held'].includes(body.scenario ?? '');
        const blocked = body.packet === 'blocked' || body.scenario === 'blocked';
        const packet = normalizeOrchestratorMissionState({ ...mission, packets: [{
          id: 'next-pr-controlled', workspaceTargetPath: body.owner === 'worktree' ? worktree : repo,
          branchTarget: body.scenario === 'explicit-pr-other-branch' ? 'other-name' : 'fixture-7',
          status: body.scenario === 'archived-held' ? 'archived' : blocked ? 'blocked' : 'awaiting_review', mergeHold: held,
          blockedReason: blocked ? 'Fixture blocked packet' : null,
          ...(body.scenario === 'fork-collision' ? {} : { reviewSource: { pullRequest: 7, headSha: 'a'.repeat(40) } }),
        }] }).packets[0];
        mission.packets = [...mission.packets.filter(p => p.id !== packet.id), packet];
        persist();
      }
      if (['runtime-live', 'runtime-unknown'].includes(body.scenario ?? '')) {
        const { createLane, updateLane } = await import('../../src/lib/lane/registry');
        const sessionKey = body.scenario === 'runtime-live' ? 'codex-owned:pr-merge-fixture' : 'codex:fixture-operator';
        if (body.scenario === 'runtime-live') {
          const directory = join(process.env.O8_DATA_DIR!, 'owned-codex', 'fixture-session');
          process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(process.env.O8_DATA_DIR!, 'owned-codex');
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, 'session.json'), JSON.stringify({ surfaceId: sessionKey,
            activeRun: { pid: process.pid, processIdentityRequired: false } }));
        }
        const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'fixture-7', runtime: 'codex', sessionKey });
        updateLane(lane.id, { prNumber: 7, status: 'completed' });
      }
      return Response.json({ ok: true, repo, worktree });
    },
  };
}
