import 'server-only';

import { execFileReadOnly } from '@/lib/providers/child-process';
import { access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { listRuntimeIdentitiesForServer } from '@/lib/runtime/identity-catalog';

// These are all `sqlite3 -readonly` reads of the Codex state DB: a credential-less child, so it
// runs on the read-only boundary and never takes the provider-store lock (unblocks native
// registration of /api/orchestrator/packet-transcript, see docs/operations/o8d-a1-reads.md).
const execFileAsync = promisify(execFileReadOnly);

export type CodexThreadRow = {
  id: string;
  title: string;
  cwd: string;
  updated_at: number;
  rollout_path: string;
  git_branch?: string | null;
  git_sha?: string | null;
  git_origin_url?: string | null;
  first_user_message?: string | null;
  model?: string | null;
};

export type CodexProcessBinding = {
  thread_id: string;
  process_uuid: string;
  last_ts: number;
};

export type CodexDiscoveryHome = {
  configHomeRef: string;
  identityId?: string;
};

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

export async function listCodexDiscoveryHomes(): Promise<CodexDiscoveryHome[]> {
  const identities = await listRuntimeIdentitiesForServer('codex').catch(() => []);
  const candidates: CodexDiscoveryHome[] = [
    { configHomeRef: defaultCodexHome() },
    ...identities.map((identity) => ({
      configHomeRef: identity.configHomeRef,
      identityId: identity.id,
    })),
  ];
  const canonicalIdentities = await Promise.all(identities.map(async (identity) => ({
    identityId: identity.id,
    configHomeRef: await realpath(identity.configHomeRef).catch(() => path.resolve(identity.configHomeRef)),
  })));
  const seen = new Set<string>();
  const homes: CodexDiscoveryHome[] = [];
  for (const candidate of candidates) {
    const configHomeRef = await realpath(candidate.configHomeRef)
      .catch(() => path.resolve(candidate.configHomeRef));
    if (seen.has(configHomeRef)) continue;
    seen.add(configHomeRef);
    homes.push({
      configHomeRef,
      identityId: candidate.identityId
        ?? canonicalIdentities.find((identity) => identity.configHomeRef === configHomeRef)?.identityId,
    });
  }
  return homes;
}

function codexStateDb(codexHome: string): string {
  return path.join(codexHome, 'state_5.sqlite');
}

export function codexSessionsRoot(codexHome: string): string {
  return path.join(codexHome, 'sessions');
}

export function codexShellSnapshotsRoot(codexHome: string): string {
  return path.join(codexHome, 'shell_snapshots');
}

async function codexStateExists(codexHome: string): Promise<boolean> {
  try {
    await access(codexStateDb(codexHome));
    return true;
  } catch {
    return false;
  }
}

/** Rows per sqlite3 read on an unbounded query. Text columns are capped to 512
 *  characters, so a page stays under the 2 MiB stdout buffer; one read of a real
 *  ~/.codex with 4,000+ threads overflowed it and returned no threads at all. */
const CODEX_THREAD_PAGE_SIZE = 512;

/** limit < 0 reads every unarchived thread, newest first, in pages. */
export async function queryCodexThreadsFromHome(codexHome: string, limit = 6): Promise<CodexThreadRow[]> {
  if (!(await codexStateExists(codexHome))) return [];
  const rows: CodexThreadRow[] = [];
  if (limit >= 0) {
    rows.push(...await queryCodexThreadPage(codexHome, limit, 0));
  } else {
    for (let offset = 0; ; offset += CODEX_THREAD_PAGE_SIZE) {
      const page = await queryCodexThreadPage(codexHome, CODEX_THREAD_PAGE_SIZE, offset);
      rows.push(...page);
      if (page.length < CODEX_THREAD_PAGE_SIZE) break;
    }
  }
  return rows.filter((row) => row.id && row.rollout_path && row.cwd);
}

async function queryCodexThreadPage(codexHome: string, limit: number, offset: number): Promise<CodexThreadRow[]> {
  const query = [
    'select',
    'id,',
    'substr(title, 1, 512) as title,',
    'cwd,',
    'updated_at,',
    'rollout_path,',
    "coalesce(git_branch, '') as git_branch,",
    "coalesce(git_sha, '') as git_sha,",
    "coalesce(git_origin_url, '') as git_origin_url,",
    "substr(coalesce(first_user_message, ''), 1, 512) as first_user_message,",
    "coalesce(model, '') as model",
    'from threads',
    'where archived = 0',
    'order by updated_at desc',
    `limit ${limit} offset ${offset};`,
  ].join(' ');
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', codexStateDb(codexHome), query], {
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout || '[]') as CodexThreadRow[];
}

export async function queryCodexThreadByIdFromHome(
  codexHome: string,
  threadId: string,
): Promise<CodexThreadRow | null> {
  if (!(await codexStateExists(codexHome)) || !threadId) return null;
  const escapedThreadId = threadId.replace(/'/g, "''");
  const query = [
    'select',
    'id,',
    'substr(title, 1, 512) as title,',
    'cwd,',
    'updated_at,',
    'rollout_path,',
    "coalesce(git_branch, '') as git_branch,",
    "coalesce(git_sha, '') as git_sha,",
    "coalesce(git_origin_url, '') as git_origin_url,",
    "substr(coalesce(first_user_message, ''), 1, 512) as first_user_message,",
    "coalesce(model, '') as model",
    'from threads',
    `where archived = 0 and id = '${escapedThreadId}'`,
    'limit 1;',
  ].join(' ');
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', codexStateDb(codexHome), query], {
    windowsHide: true,
    maxBuffer: 512 * 1024,
  });
  const [thread] = JSON.parse(stdout || '[]') as CodexThreadRow[];
  return thread?.id && thread.rollout_path && thread.cwd ? thread : null;
}

export async function queryCodexProcessBindings(codexHome: string): Promise<CodexProcessBinding[]> {
  if (!(await codexStateExists(codexHome))) return [];
  const query = [
    'select',
    'thread_id,',
    'process_uuid,',
    'max(ts) as last_ts',
    'from logs',
    'where thread_id is not null and process_uuid is not null',
    'group by thread_id, process_uuid',
    'order by last_ts desc;',
  ].join(' ');
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', codexStateDb(codexHome), query], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(stdout || '[]') as CodexProcessBinding[];
  } catch (error) {
    // Recent Codex state schemas omit `logs`; live thread identity can still
    // be recovered from the process's open thread-writer lock.
    if (error instanceof Error && error.message.includes('no such table: logs')) return [];
    throw error;
  }
}
