import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function processIdentity(pid: number) {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(') ');
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  const startId = fields[19];
  if (!bootId || !startId || !/^\d+$/.test(startId)) throw new Error('Window owner identity is unavailable.');
  return { bootId, startId, state: fields[0] };
}

/** Write before taking the pending marker, so every claim has an owner. */
export function writeLinuxWindowOwner(attempt: string): void {
  const { bootId, startId } = processIdentity(process.pid);
  writeFileSync(join(attempt, 'owner.json'), JSON.stringify({
    schema: 'o8/linux-window-owner/v1', pid: process.pid, bootId, startId,
  }), { mode: 0o600, flag: 'wx' });
}

/** Probe process birth, not HTTP health. Unknown evidence retains the claim. */
export function linuxWindowOwnerIsDead(attempt: string): boolean {
  let owner: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(readFileSync(join(attempt, 'owner.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    owner = value as Record<string, unknown>;
  } catch { return false; }
  if (owner.schema !== 'o8/linux-window-owner/v1' || typeof owner.pid !== 'number'
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.bootId !== 'string' || !owner.bootId
    || typeof owner.startId !== 'string' || !/^\d+$/.test(owner.startId)) return false;
  try {
    const actual = processIdentity(owner.pid);
    return actual.bootId !== owner.bootId || actual.startId !== owner.startId
      || actual.state === 'Z' || actual.state === 'X';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { process.kill(owner.pid, 0); } catch (probeError) {
        return (probeError as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    return false;
  }
}
