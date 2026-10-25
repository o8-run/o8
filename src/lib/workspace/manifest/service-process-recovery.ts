import 'server-only';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { probeOwnedProcessIdentity, probeOwnedSignalIdentity, type OwnedProcessEvidence } from '@/lib/runtimes/shared/owned-session/process-identity';
import { acquireMetadataTransactionLease, releaseMetadataTransactionLease } from '@/lib/worktree/metadata-transaction-lease';
import { sameMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export interface WorkspaceServiceGroup {
  group: number;
  shutdownGraceMs: number;
  members: OwnedProcessEvidence[];
}
export interface WorkspaceServiceProcessState {
  supervisor?: OwnedProcessEvidence;
  groups?: WorkspaceServiceGroup[];
  state: string;
  error?: string;
  cleanupUnconfirmed?: boolean;
  finishedAt?: string;
  teardown?: { state: string; error?: string; finishedAt?: string } | null;
}
const execute = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const held = () => new Error('Workspace process group ownership or settlement is unconfirmed; retain the worktree and leases.');
async function processRows(): Promise<Array<{ pid: number; group: number }>> {
  const { stdout } = await execute('ps', ['ax', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').filter(line => line.trim()).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) throw held();
    return match[3].startsWith('Z') ? [] : [{ pid: Number(match[1]), group: Number(match[2]) }];
  });
}
async function ownedRows(group: WorkspaceServiceGroup) {
  const rows = (await processRows()).filter(row => row.group === group.group);
  if (!rows.length) return rows;
  for (const member of group.members) {
    if (rows.some(row => row.pid === member.pid) && (await probeOwnedSignalIdentity(member)).state === 'match') return rows;
  }
  throw held(); // An occupied reused group without a surviving cookie grants no signal authority.
}

async function supervisorRunning(supervisor: OwnedProcessEvidence): Promise<boolean> {
  const identity = await probeOwnedSignalIdentity(supervisor);
  if (identity.state === 'unknown') throw held();
  if (identity.state !== 'match') return false;
  // Birth cookies can outlive execution: a zombie still matches until its
  // parent reaps it. processRows excludes zombies and also catches a process
  // reaped after the cookie probe, before deciding recovery is unnecessary.
  return (await processRows()).some(row => row.pid === supervisor.pid);
}

/** Recover only a dead exact supervisor; never replay repository teardown commands. */
export async function recoverWorkspaceServiceGroups<T extends WorkspaceServiceProcessState>(
  directory: string,
  read: () => Promise<T | null>,
  write: (state: T) => Promise<void>,
): Promise<void> {
  const initial = await read();
  if (!initial?.supervisor) return; // Legacy receipts stay held by normal stop timeout.
  if (await supervisorRunning(initial.supervisor)) return;
  // SQLite identity leases serialize fresh processes and recover a killed stopper's claim.
  const lease = await acquireMetadataTransactionLease(directory);
  try {
    const state = await read();
    if (!state?.supervisor || !Array.isArray(state.groups)) throw held();
    if (await supervisorRunning(state.supervisor)) return;
    for (const group of state.groups) {
      if (!Number.isSafeInteger(group.group) || group.group <= 1 || !Array.isArray(group.members) || !group.members.length
        || !Number.isSafeInteger(group.shutdownGraceMs) || group.shutdownGraceMs < 0 || group.shutdownGraceMs > 60_000) throw held();
    }
    if (!state.groups.length && ['failed', 'stopped'].includes(state.state) && !state.cleanupUnconfirmed) return;
    state.state = 'stopping';
    state.cleanupUnconfirmed = true;
    state.error = 'Workspace supervisor exited before lifecycle settlement.';
    if (state.teardown?.state !== 'completed' && state.teardown?.state !== 'failed') {
      state.teardown = { ...state.teardown, state: 'failed', error: 'Workspace teardown was interrupted and will not be replayed.', finishedAt: new Date().toISOString() };
    }
    await write(state);
    for (const group of state.groups) {
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        const trusted = { ...group, members: [...group.members] };
        const rows = await ownedRows(trusted);
        if (!rows.length) break;
        // Keep descendant cookies before signaling the leader, including across stopper crashes.
        const source = group.members[0].processIdentitySource;
        const captured = [...group.members];
        for (const row of rows) {
          const proof = await probeOwnedProcessIdentity(row.pid, source);
          if (proof.state !== 'live' || !source || proof.source !== source) throw held();
          const saved = trusted.members.find(member => member.pid === row.pid);
          if (saved && (!saved.processIdentity || !sameMetadataLockProcessIdentity(saved.processIdentity, proof.identity))) throw held();
          const member = { pid: row.pid, processIdentity: proof.identity, processIdentitySource: proof.source };
          if (!saved) captured.push(member);
        }
        // New observations grant no authority if the original trusted group died
        // during the asynchronous probes or persistence boundary.
        if (!(await ownedRows(trusted)).length) break;
        group.members = captured;
        await write(state);
        if (!(await ownedRows(trusted)).length) break;
        try { process.kill(-group.group, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        await pause(signal === 'SIGTERM' ? group.shutdownGraceMs : 25);
      }
      let quiet = false;
      for (let count = 0; count < 40; count++) {
        if (!(await ownedRows(group)).length) { quiet = true; break; }
        await pause(25);
      }
      if (!quiet) throw held();
    }
    state.groups = [];
    state.state = 'failed';
    state.cleanupUnconfirmed = false;
    state.finishedAt = new Date().toISOString();
    await write(state);
  } finally { releaseMetadataTransactionLease(lease); }
}
