// Persisted fixture contracts and reservations only; never dispatches a provider.
import { randomUUID, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowAccountRefresh, holdAccountRefresh, publishReadyAccountState, withAccountStateLease } from '@/lib/auth/account-state';
import { bumpSignInEpoch, clearActiveIdentity, readSignInEpoch, writeActiveIdentity } from '@/lib/github-broker/managed';
import { getDataDir } from '@/lib/data-dir-migration';
import { contractHash, findTaskDraft, taskDraftKey, withTaskDraftLock, writeTaskDraft, type TaskDraftRecord } from '@/lib/mcp/task-draft-store';
import { readTaskExecution, reserveTaskExecution } from '@/lib/mcp/task-execution-store';

async function main() {
  if (process.argv[2] === 'sign-out') {
    await withAccountStateLease(() => {
      clearActiveIdentity();
      holdAccountRefresh();
      writeFileSync(join(getDataDir(), 'auth-signed-out-at'), new Date().toISOString());
    });
    return;
  }
  if (process.argv[2] === 'inspect') {
    console.log(JSON.stringify(readTaskExecution(findTaskDraft(process.argv[3]!))));
    return;
  }
  const accountId = 'fixture-native-task-account';
  await withAccountStateLease(() => {
    writeActiveIdentity(accountId);
    bumpSignInEpoch();
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: accountId, plan: 'free', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const key = Buffer.from(process.env.O8_NATIVE_TASK_FIXTURE_KEY!, 'base64').toString();
    const licenseKey = `${unsigned}.${sign(null, Buffer.from(unsigned), key).toString('base64url')}`;
    writeFileSync(join(getDataDir(), 'entitlement.json'), JSON.stringify({ plan: 'free', licenseKey }));
    allowAccountRefresh();
    publishReadyAccountState(accountId, readSignInEpoch()!, licenseKey);
  });
  const account = { accountId, epoch: readSignInEpoch()! };
  const contract: TaskDraftRecord['contract'] = {
    machineId: 'fixture-native-machine', projectId: randomUUID(), repoId: randomUUID(), snapshotId: randomUUID(),
    idempotencyKey: 'native-review-fixture', objective: 'Read the fixture and report evidence.',
    runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', workMode: 'read-only',
    allowedFiles: ['README.md'], evidence: ['Report the fixture contents.'],
    sealedTaskContract: {
      version: 1, requirements: [{ id: 'R1', source: 'Explicit fixture task', expectedBehavior: 'Read the fixture.',
        productionPath: 'README.md', verification: 'Report the observed contents.' }],
      smallestRoute: [{ path: 'README.md', requirements: ['R1'], reason: 'The requested fixture.' }],
      exclusions: ['No writes or extra attempts.'],
    },
  };
  const draft: TaskDraftRecord = {
    version: 1, taskId: randomUUID(), state: 'held', executionEnabled: false,
    createdAt: new Date().toISOString(), account, clientId: 'fixture-native-client', contract, contractHash: contractHash(contract),
    snapshot: { ...account, snapshotId: contract.snapshotId, machineId: contract.machineId, clientId: 'fixture-native-client',
      expiresAt: Date.now() + 60_000, repoId: contract.repoId, projectId: contract.projectId,
      repoPath: getDataDir(), revision: 'a'.repeat(40), rulesDigest: 'b'.repeat(64) },
    policy: { automaticDispatch: false, workMode: 'read-only', packetCount: 1, maxAttempts: 1, fallback: false, executionCarrier: null },
  };
  const key = taskDraftKey(accountId, draft.clientId, contract.machineId, contract.idempotencyKey);
  await withTaskDraftLock(key, async () => writeTaskDraft(key, draft));
  const { record } = await reserveTaskExecution(draft);
  console.log(JSON.stringify({ taskId: draft.taskId, contractHash: draft.contractHash, attemptId: record.attemptId, accountId }));
}
void main();
