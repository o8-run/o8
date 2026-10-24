import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { nativeReadCredentialMatches } from '@/lib/mcp/operator-handlers/shared';
import { nativeMissionReadCredentialMatches } from '@/lib/mcp/operator-mission-tools';
import { probeMetadataLockProcessIdentitySync } from '@/lib/worktree/metadata-lock-process-identity';

export const nativeReadGeneration = randomUUID();
const generation = nativeReadGeneration;
const prefix = 'o8d/mcp/v1/';
const nativeNames = new Set(['o8_status', 'get_mission_status', 'o8_task_list',
  'o8_list_repos', 'o8_list_projects', 'o8_lease_list', 'o8_lease_status', 'o8_spec_read']);
let previousPolicy = '';

// Publish authority, not a second tool catalog. The native reader still checks
// the live credential file on every call and binds this row to this process.
export function publishNativeReadPolicy(base: string, profile: string, names: string[]): void {
  try {
    if (process.env.O8D_MCP_READS !== '1' && !previousPolicy) return;
    const probe = probeMetadataLockProcessIdentitySync(process.pid);
    if (probe.state !== 'live') return;
    const token = readFileSync(join(getDataDir(), 'ws-token'), 'utf8').trim();
    const policy = JSON.stringify({ schema: 'o8/mcp/native-policy/v1', base, generation,
      pid: process.pid, identity: probe.identity,
      enabled: process.env.O8D_MCP_READS === '1' && (!process.env.WS_TOKEN?.trim() || process.env.WS_TOKEN.trim() === token)
        && nativeReadCredentialMatches(token) && nativeMissionReadCredentialMatches(token), profile,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      names: names.filter((name) => nativeNames.has(name)),
    });
    if (policy === previousPolicy) return;
    getSqlite().prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(`${prefix}policy`, policy, Date.now());
    previousPolicy = policy;
  } catch { /* Publication failure leaves native reads on the original path. */ }
}

export function publishNativeRepoReadiness(repoPath: string, state: string | undefined): void {
  if (process.env.O8D_MCP_READS !== '1') return;
  try {
    const key = `${prefix}readiness/${repoPath}`;
    getSqlite().prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify({ generation, state: state ?? null }), Date.now());
  } catch { /* Registry readers fall back if readiness publication is unavailable. */ }
}

// This is the existing bounded snapshot, with its original capture time and
// exact backend/session key. Rust cannot construct live runtime observations.
export function publishNativeStatus(base: string, sessionKey: string | undefined, snapshot: unknown): void {
  if (process.env.O8D_MCP_READS !== '1') return;
  try {
    const sqlite = getSqlite();
    const key = `${prefix}status/${JSON.stringify([base, sessionKey || ''])}`;
    sqlite.transaction(() => {
      sqlite.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(key, JSON.stringify({ generation, snapshot }), Date.now());
      sqlite.prepare('DELETE FROM app_state WHERE key IN (SELECT key FROM app_state WHERE key LIKE ? ORDER BY updated_at DESC, key LIMIT -1 OFFSET 64)')
        .run(`${prefix}status/%`);
    })();
  } catch { /* A failed publication never renews a persisted snapshot. */ }
}

export function removeNativeStatus(sourceKey: string): void {
  if (process.env.O8D_MCP_READS !== '1') return;
  try {
    getSqlite().prepare('DELETE FROM app_state WHERE key = ?').run(`${prefix}status/${sourceKey}`);
  } catch { /* Native freshness bounds still apply if pruning fails. */ }
}
