import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLane } from '../../src/lib/lane/registry';
import { mintPacketWorkerToken } from '../../src/lib/auth/packet-worker-token';
import { getSqlite, closeDb } from '../../src/lib/db';
import { createWorkspaceSnapshot, transitionWorkspaceSnapshot } from '../../src/lib/worktree/snapshot-state';
import { spokenReviewSnapshotFingerprint } from '../../src/lib/lane/lane-diff-facts';
const directory=process.env.CORTEX_IDE_DATA_DIR!;
if(readFileSync(join(directory,'fixture-owner'),'utf8')!=='o8d-native-read/v1')throw Error('Owned fixture required');
const config=JSON.parse(readFileSync(join(directory,'lane-diff-seed.json'),'utf8'));
try{
  const repoPath=join(directory,'fixture-repo'),worktreePath=join(directory,'lane-worktree');
  const create=(packetId:string,extra={})=>createLane({repoPath,worktreePath,branch:'lane-review',baseBranch:'main',runtime:'codex',packetId,baseCommit:config.base,...extra});
  const ordinary=create('lane-packet'),large=create('large-packet',{worktreePath:join(directory,'large-worktree'),branch:'lane-large'}),legacy=create('legacy-packet'),immutable=create('immutable-packet');
  getSqlite().prepare("DELETE FROM lane_events WHERE lane_id=? AND verb='open_lane'").run(legacy.id);
  const unresolved=create('unresolved-packet',{branch:'missing-branch'});
  const missingWorktree=create('missing-worktree-packet',{worktreePath:join(directory,'gone-worktree')});
  const failed=create('failed-packet',{repoPath:join(directory,'broken-repo'),worktreePath:join(directory,'broken-repo'),branch:'broken-review'});
  const head=(args:string[])=>execFileSync('git',['-C',worktreePath,...args],{encoding:'utf8'}).trim();
  const sha=head(['rev-parse','HEAD']),tree=head(['rev-parse','HEAD^{tree}']);head(['update-ref','refs/o8/fixture-review',sha]);
  const initial=createWorkspaceSnapshot({repositoryUuid:'lane-repository',packetId:immutable.packetId!,laneId:immutable.id,originalPath:worktreePath,branch:'lane-review',baseCommit:config.base,headCommit:sha,treeSha:tree,recoveryRef:'refs/o8/fixture-review',diffFingerprint:spokenReviewSnapshotFingerprint(sha,config.base,tree),sessionIdentities:[],creationId:'lane-snapshot-created',recordedAt:100,transitionStartedAt:100});
  let version=initial.record.version,expectedState:'materialized'|'parkable'|'hibernating'|'parked'='materialized';
  for(const [index,toState] of (['parkable','hibernating','parked'] as const).entries()){
    const result=transitionWorkspaceSnapshot({repositoryUuid:'lane-repository',packetId:immutable.packetId!,expectedState,expectedVersion:version,toState,transitionId:'lane-snapshot-'+toState,recordedAt:200+index,transitionStartedAt:200+index,receipt:{}});
    if(!result.record)throw Error('Snapshot fixture failed');version=result.record.version;expectedState=toState;
  }
  writeFileSync(join(directory,'lane-diff-fixture.json'),JSON.stringify({ordinary:ordinary.id,large:large.id,legacy:legacy.id,immutable:immutable.id,unresolved:unresolved.id,missingWorktree:missingWorktree.id,failed:failed.id,worker:mintPacketWorkerToken('lane-packet'),foreign:mintPacketWorkerToken('foreign-packet')}),{mode:0o600});
}finally{closeDb();}
