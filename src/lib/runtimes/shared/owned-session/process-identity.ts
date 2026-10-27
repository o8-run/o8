import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity, type MetadataLockProcessProbe } from '@/lib/worktree/metadata-lock-process-identity';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';
import { probeOwnedRunProcessClaim } from './run-process-proof';
import type { ChildProcess } from 'node:child_process';

const execFileAsync = promisify(execFile);
export type OwnedIdentitySource = 'native-helper' | 'ps' | 'platform';
export type OwnedProcessEvidence = { pid?: number; processIdentity?: MetadataLockProcessIdentity;
  processIdentitySource?: OwnedIdentitySource; processIdentityRequired?: boolean };
export type OwnedIdentityProbe = { state: 'match' | 'absent' | 'mismatch' } | { state: 'unknown'; detail: string };
type OwnedProcessProbe = Exclude<MetadataLockProcessProbe, { state: 'live' }>
  | { state: 'live'; identity: MetadataLockProcessIdentity; source: OwnedIdentitySource };

export class OwnedProcessIdentityError extends Error {
  constructor(state: 'mismatch' | 'unknown') {
    super(`Owned worker process identity is ${state}; its saved run remains held without reattachment or automatic retry.`);
  }
}

/** A known exit of the exact journaled child is a post-launch outcome. Keep
 * its queued exit bookkeeping; this does not prove descendant clearance. */
export async function verifyStartedChildIdentity(
  verify: () => Promise<void>, run: OwnedRunRecord, child: ChildProcess | undefined, persisted: boolean,
): Promise<void> {
  try { await verify(); }
  catch (error) {
    if (!(error instanceof OwnedProcessIdentityError) || !persisted || run.spawnState !== 'started'
      || child?.pid !== run.pid
      || !(typeof child.exitCode === 'number' || typeof child.signalCode === 'string')) throw error;
  }
}

/** Prefer microsecond Darwin identity when the bundled helper supports it. */
async function probeNativeIdentity(pid: number): Promise<OwnedProcessProbe> {
  try {
    const { stdout } = await execFileAsync(piWriteHelperPath(), ['process-identity', String(pid)], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192, windowsHide: true,
    });
    const value: unknown = JSON.parse(stdout);
    if (isMetadataLockProcessIdentity(value) && value.platform === 'darwin' && /^kernel:\d+:\d{6}$/.test(value.startId)) {
      return { state: 'live', identity: value, source: 'native-helper' };
    }
  } catch { /* Missing helpers and unsupported old builds grant no identity. */ }
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'absent' };
  }
  return { state: 'unknown', detail: 'Kernel worker process identity is unavailable.' };
}

/** A saved source is pinned: never compare native and second-precision ps clocks. */
export async function probeOwnedProcessIdentity(pid: number, source?: OwnedIdentitySource): Promise<OwnedProcessProbe> {
  if (process.platform === 'darwin' && source !== 'ps') {
    if (source === 'platform') return { state: 'unknown', detail: 'Saved worker identity source is incompatible with this platform.' };
    const native = await probeNativeIdentity(pid);
    if (source === 'native-helper' || native.state !== 'unknown') return native;
  } else if (source && source !== (process.platform === 'darwin' ? 'ps' : 'platform')) {
    return { state: 'unknown', detail: 'Saved worker identity source is incompatible with this platform.' };
  }
  const fallback = await probeMetadataLockProcessIdentity(pid);
  return fallback.state === 'live'
    ? { ...fallback, source: process.platform === 'darwin' ? 'ps' : 'platform' } : fallback;
}

function savedIdentitySource(run: OwnedProcessEvidence): OwnedIdentitySource | undefined {
  if (run.processIdentitySource !== undefined) {
    return ['native-helper', 'ps', 'platform'].includes(run.processIdentitySource) ? run.processIdentitySource : undefined;
  }
  if (!isMetadataLockProcessIdentity(run.processIdentity)) return undefined;
  // Preserve strict cookies written before source tagging was introduced.
  return run.processIdentity.platform === 'darwin'
    ? /^kernel:\d+:\d{6}$/.test(run.processIdentity.startId) ? 'native-helper' : undefined
    : 'platform';
}

export async function probeOwnedRunIdentity(run: OwnedProcessEvidence): Promise<OwnedIdentityProbe> {
  if (!run.pid || !Number.isSafeInteger(run.pid) || run.pid <= 0) return { state: 'unknown', detail: 'Worker PID is unavailable.' };
  const source = savedIdentitySource(run);
  const actual = await probeOwnedProcessIdentity(run.pid, source);
  if (actual.state !== 'live') return actual;
  if (!isMetadataLockProcessIdentity(run.processIdentity)) return { state: 'unknown', detail: 'Worker start identity was not persisted.' };
  if (!source || source !== actual.source) return { state: 'unknown', detail: 'Worker identity source was not persisted or changed.' };
  return { state: sameMetadataLockProcessIdentity(actual.identity, run.processIdentity) ? 'match' : 'mismatch' };
}

/** A missing root must not grant group signal authority to a legacy record. */
export async function probeOwnedSignalIdentity(run: OwnedProcessEvidence): Promise<OwnedIdentityProbe> {
  if (!isMetadataLockProcessIdentity(run.processIdentity) || run.processIdentity.platform !== process.platform
    || !savedIdentitySource(run)) {
    return { state: 'unknown', detail: 'Worker start identity and source were not persisted.' };
  }
  return probeOwnedRunIdentity(run);
}

/** Never settle or retry an unidentified survivor as though it were a dead run. */
export async function assertOwnedSessionProcessIdentity(session: OwnedSessionRecord, runtimeId: string): Promise<void> {
  const run = session.activeRun;
  if (run?.supervisor) return; // The daemon validates its original child and persisted ownership on attach.
  if (!run || run.spawnState === 'prepared' || run.finishedAt || run.tmuxSession
    || process.platform === 'win32' || !session.packetId
    || (runtimeId !== 'codex' && run.detachMode !== 'detached' && !run.processIdentityRequired && !run.processIdentity)
    || (run.processIdentityRequired === false && !run.processIdentity)) return;
  const proof = await probeOwnedRunIdentity(run);
  if (proof.state === 'mismatch' || proof.state === 'unknown') throw new OwnedProcessIdentityError(proof.state);
}

export async function captureOwnedRunIdentity(session: OwnedSessionRecord, runtimeId: string, run: OwnedRunRecord): Promise<void> {
  if (!session.packetId || process.platform === 'win32' || run.detachMode !== 'detached') return;
  run.processIdentityRequired = true;
  let unavailable: Exclude<OwnedProcessProbe, { state: 'live' }> = { state: 'unknown', detail: 'Process identity capture did not complete.' };
  const sources: Array<OwnedIdentitySource | undefined> = process.platform === 'darwin' ? [undefined, 'ps'] : [undefined];
  for (const source of sources) {
    const proof = await probeOwnedProcessIdentity(run.pid, source);
    if (proof.state !== 'live') { unavailable = proof; continue; }
    if (!run.processMarker) return;
    const claim = await probeOwnedRunProcessClaim({ pid: run.pid, marker: run.processMarker, rootPid: run.pid });
    if (claim.state !== 'match') return;
    const again = await probeOwnedProcessIdentity(run.pid, proof.source);
    if (again.state !== 'live') { unavailable = again; continue; }
    if (proof.source !== again.source || !sameMetadataLockProcessIdentity(proof.identity, again.identity)) return;
    run.processIdentity = proof.identity;
    run.processIdentitySource = proof.source;
    return;
  }
  run.processIdentityRequired = false;
  delete run.processIdentity;
  delete run.processIdentitySource;
  const reason = unavailable.state === 'unknown' ? unavailable.detail : 'Worker exited before identity capture completed.';
  console.warn(`[owned-store] ${runtimeId} packet start identity unavailable; retaining legacy process controls for run ${run.id}: ${reason}`);
}
