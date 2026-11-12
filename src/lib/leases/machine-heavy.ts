import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { withResourceLease } from './resource-lease-guard';
import { ResourceLeaseStore } from './resource-lease-service';

/** Independent of workspace, app data-dir, branch, and current directory. */
export async function withMachineLease<T>(resource: string, action: () => Promise<T>, wait = true, ownerPid = process.pid, signal?: AbortSignal): Promise<T> {
  const dir = process.env.O8_MACHINE_LEASE_DIR || path.join(os.homedir(), '.o8', 'machine-leases');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sqlite = new Database(path.join(dir, 'leases.db'));
  sqlite.pragma('busy_timeout = 5000');
  try {
    const store = new ResourceLeaseStore(sqlite);
    let lastReport = 0;
    let lastPosition: number | null | undefined;
    const result = await withResourceLease({
      resource, store, signal, pollIntervalMs: 1000, actor: 'worker',
      owner: { id: `heavy-${process.pid}`, label: resource, pid: ownerPid },
      maxWaitMs: wait ? 24 * 60 * 60_000 : 0,
      onWaiting(position, holder) {
        if (lastPosition === position && Date.now() - lastReport < 30_000) return;
        lastReport = Date.now();
        lastPosition = position;
        console.error(`Waiting for ${resource}, position ${position ?? 'unknown'}; holder ${holder?.owner.label ?? 'unknown'} (pid ${holder?.owner.pid ?? 'unknown'}).`);
      },
    }, action);
    if (result.state === 'refused') {
      throw new Error(`${result.refusal.message}${resource === 'verify-ci' ? ' Use --allow-concurrent to override.' : ''}`);
    }
    return result.value;
  } finally { sqlite.close(); }
}
