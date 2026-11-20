// Canonical fixture writer; the native stage must verify the resulting proof.
import { getSqlite, closeDb } from '../../src/lib/db';
import { createWorkspaceSnapshot, transitionWorkspaceSnapshot } from '../../src/lib/worktree/snapshot-state';
import { writeOrchestratorControlPlaneState } from '../../src/lib/orchestrator/control-plane';
import { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } from '../../src/lib/orchestrator/store';
import { join } from 'node:path';
const directory = process.env.CORTEX_IDE_DATA_DIR!;
try {
  const repo = join(directory,'fixture-repo'); const db=getSqlite();
  db.prepare(`INSERT INTO lanes(id,label,repo_path,worktree_path,branch,base_branch,runtime,session_key,status,ownership,packet_id,created_at,updated_at)
    VALUES ('parked-lane','Fixture parked',?,NULL,'parked-branch','main','claude','llm-chat:thoughts-parked','completed','managed','parked-packet','2026-01-01','2026-01-01')`).run(repo);
  const state = normalizeOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(),packets: [{ id: 'parked-packet',title: 'Parked fixture',branchTarget: 'main',workspaceTargetPath: repo,status: 'released',queueState: 'held',releaseState: 'released',releaseStatePayload: { source: 'read_only_completed',evidenceKind: 'read_only_no_merge_required' },orchestratorThreadId: 'thoughts-parked',lane: { tileId: 'tile',tabId: 'tab',repoPath: repo,worktreePath: join(directory,'old-worktree'),laneId: 'parked-lane',sessionKey: 'llm-chat:thoughts-parked',runtime: 'claude' } }] });
  writeOrchestratorControlPlaneState(state);
  const initial=createWorkspaceSnapshot({ repositoryUuid: 'fixture-repository',packetId: 'parked-packet',laneId: 'parked-lane',originalPath: join(directory,'old-worktree'),branch: 'parked-branch',baseCommit: 'a'.repeat(40),headCommit: 'b'.repeat(40),treeSha: 'c'.repeat(40),recoveryRef: 'refs/o8/parked',diffFingerprint: 'fixture-diff',sessionIdentities: [{ kind: 'owned-session',identity: 'llm-chat:thoughts-parked' }],creationId: 'snapshot-created',recordedAt: 100,transitionStartedAt: 100 });
  let version=initial.record.version; let expectedState: 'materialized'|'parkable'|'hibernating'|'parked'='materialized';
  for (const [index,to] of ['parkable','hibernating','parked'].entries()) {
    const result=transitionWorkspaceSnapshot({ repositoryUuid: 'fixture-repository',packetId: 'parked-packet',expectedState,expectedVersion: version,toState: to as 'parkable'|'hibernating'|'parked',transitionId: 'snapshot-' + to,recordedAt: 200+index,transitionStartedAt: 200+index,receipt: to==='parked' ? { reclaimedAvailableBytes: 4096 } : {} });
    if (!result.record) throw new Error('Missing fixture snapshot');
    version=result.record.version; expectedState=to as typeof expectedState;
  }
} finally {closeDb();}
