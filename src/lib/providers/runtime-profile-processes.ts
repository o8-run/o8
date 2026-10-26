import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync, sameMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { canonicalProfilePath, profileContains } from './runtime-profile-paths';
import type { ChildMetadataRedaction } from './spawn-environment';

const directory = () => join(getDataDir(), 'runtime-profile-processes');
const issue = '#4340 (https://github.com/hurttlocker/o8/issues/4340)';
const selectors = new Set(['HOME', 'USERPROFILE', 'HERMES_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']);
// Private scopes survive only in this process, never in a plaintext receipt.
// After restart, an opaque live API scope refuses reuse conservatively.
const privateScopes = new Map<string, { serialized: string; profiles: string[] }>();
interface ProfileRecord {
  version: number; owner: string; runtimeId?: string; pid: number; processIdentity: unknown;
  profiles: string[]; apiAllowedAtLaunch: boolean; redactedProfiles?: number[];
  redactedEnvironment?: Array<{ name: string; value: string }>;
}
function protectedRecord(record: ProfileRecord, metadata?: ChildMetadataRedaction, newLaunch = false): ProfileRecord {
  const legacy = record.version === 1;
  const selector = newLaunch && metadata?.names.some(name => selectors.has(name.toUpperCase()));
  const redacted = new Set(record.redactedProfiles ?? []);
  const marker = metadata?.redact('[redacted]') ?? '[redacted]';
  const profiles = record.profiles.map((profile, index) => {
    if (legacy || selector || metadata && metadata.redact(profile) !== profile) redacted.add(index);
    return redacted.has(index) ? marker : profile;
  });
  const variables = record.redactedEnvironment ?? (legacy ? [{ name: 'legacy-profile', value: marker }]
    : metadata?.names.map(name => ({ name, value: marker })) ?? []);
  return { version: 2, owner: 'o8', runtimeId: record.runtimeId, pid: record.pid, processIdentity: record.processIdentity,
    apiAllowedAtLaunch: record.apiAllowedAtLaunch, profiles, redactedProfiles: [...redacted],
    ...(redacted.size ? { redactedEnvironment: variables.map(variable => ({ name: metadata?.redact(variable.name) ?? variable.name, value: marker })) } : {}) };
}
function readRecord(file: string, metadata?: ChildMetadataRedaction): { record: ProfileRecord; scopes: string[] | null } | null {
  let raw: string; let record: ProfileRecord;
  try { raw = readFileSync(file, 'utf8'); record = JSON.parse(raw); } catch { return null; }
  if (![1, 2].includes(record?.version) || record.owner !== 'o8' || !Array.isArray(record.profiles)
    || record.profiles.some(profile => typeof profile !== 'string')) return null;
  const cached = privateScopes.get(file);
  let scopes: string[] | null = cached?.serialized === raw ? cached.profiles : record.redactedProfiles?.length ? null : record.profiles;
  const safe = protectedRecord(record, metadata); const serialized = JSON.stringify(safe);
  if (raw !== serialized) {
    // Scrub before filtering by API mode or PID: a dead/silent child can leak too.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
    catch { throw new Error('Runtime launch refused: a private profile receipt could not be scrubbed.'); }
    finally { try { unlinkSync(temporary); } catch { /* replacement already consumed it */ } }
    if (scopes) privateScopes.set(file, { serialized, profiles: scopes });
  }
  if (safe.redactedProfiles?.length && !scopes) scopes = null;
  return { record: safe, scopes };
}

/** Only an explicit launch receipt establishes historical API permission. */
export function assertNoRecordedApiProfileChild(profiles: readonly string[], metadata?: ChildMetadataRedaction): void {
  if (!profiles.length || !existsSync(directory())) return;
  for (const name of readdirSync(directory())) {
    if (!name.endsWith('.json')) continue;
    const loaded = readRecord(join(directory(), name), metadata);
    if (!loaded) continue;
    const { record, scopes } = loaded;
    if (record.apiAllowedAtLaunch !== true || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || !isMetadataLockProcessIdentity(record.processIdentity)) continue;
    if (scopes && !profiles.some(profile => scopes.some(other => profileContains(profile, other) || profileContains(other, profile)))) continue;
    const probe = probeMetadataLockProcessIdentitySync(record.pid);
    if (probe.state === 'absent') continue;
    if (probe.state === 'live' && !sameMetadataLockProcessIdentity(probe.identity, record.processIdentity)) continue;
    throw new Error(`An o8-recorded API child is still running, or its exit cannot be verified, on a selected or private profile. Stop that child before retrying. See ${issue}.`);
  }
}

/** Persist scopes only after removing saved local credential values. */
export function recordRuntimeProfileChild(result: unknown, runtimeId: string | undefined, profiles: readonly string[], env: Record<string, string>, metadata?: ChildMetadataRedaction): void {
  if (!profiles.length || !result || typeof result !== 'object') return;
  const candidate = result as { child?: unknown; pid?: number; once?: (event: string, listener: () => void) => unknown; onExit?: (listener: () => void) => unknown; kill?: () => unknown };
  if (candidate.child) return recordRuntimeProfileChild(candidate.child, runtimeId, profiles, env, metadata);
  if (!candidate.pid || typeof candidate.once !== 'function' && typeof candidate.onExit !== 'function') return;
  const probe = probeMetadataLockProcessIdentitySync(candidate.pid);
  if (probe.state !== 'live') return;
  const file = join(directory(), `${randomUUID()}.json`);
  try {
    mkdirSync(directory(), { recursive: true, mode: 0o700 });
    const policy = env.O8_CHILD_CREDENTIAL_POLICY ? JSON.parse(env.O8_CHILD_CREDENTIAL_POLICY) : {};
    const scopes = profiles.map(canonicalProfilePath);
    const record = protectedRecord({ version: 2, owner: 'o8', runtimeId: runtimeId ?? 'acp', pid: candidate.pid,
      processIdentity: probe.identity, profiles: scopes, apiAllowedAtLaunch: policy.apiAllowed === true }, metadata, true);
    const serialized = JSON.stringify(record);
    writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
    if (record.redactedProfiles?.length) privateScopes.set(file, { serialized, profiles: scopes });
  } catch {
    candidate.kill?.();
    throw new Error('Runtime launch refused: its profile process receipt could not be saved.');
  }
  const cleanup = () => { privateScopes.delete(file); try { unlinkSync(file); } catch { /* stale receipts are checked against process birth */ } };
  if (candidate.once) candidate.once('close', cleanup);
  else candidate.onExit!(cleanup);
}
