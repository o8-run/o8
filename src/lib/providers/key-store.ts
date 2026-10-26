import { invalidateLaunchPolicy } from './launch-policy';
import { credentialPolicyChanged } from './policy-events';
import { warnLegacyRuntimeConfigs } from './legacy-runtime-config';
/** Persisted provider credentials, shared by ordinary Node launch paths. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { parseKeyEnv } from './env-format';
export { parseKeyEnv } from './env-format';
import { assertMasterKeyAvailableForMutation, decryptValueSync, encryptValueSync } from '@/lib/db/master-key';

import { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES } from './credential-names';
export { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES } from './credential-names';
const managedName = (name: string) => `O8_KEY_MANAGED_${name}`;
const disabledName = (name: string) => `O8_KEY_DISABLED_${name}`;
function textFile(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
function snapshot() {
  const raw = textFile(join(getDataDir(), '.env.local'));
  return { raw, values: parseKeyEnv(raw) };
}
function decode(raw: string): string {
  if (!raw.startsWith('enc:')) return raw.trim();
  const match = /^enc:([a-fA-F0-9]{24}):((?:[a-fA-F0-9]{2}){16,})$/.exec(raw);
  const plain = match ? decryptValueSync(match[2], match[1]) : null;
  if (plain === null) throw new Error('Credential store unavailable');
  return plain.trim();
}
export function assertProviderStoreAvailable(): void {
  const { values } = snapshot();
  for (const name of PROVIDER_ENV_KEYS) {
    const raw = values.get(name);
    if (raw) decode(raw);
  }
}
export function storedProviderKey(name: string): string | null {
  const { values } = snapshot();
  const raw = values.get(name);
  return raw ? decode(raw) || null : null;
}
export function providerKeyEnabled(name: string): boolean {
  const flag = snapshot().values.get(disabledName(name));
  if (flag !== undefined) return flag !== '1';
  if (name === 'OPENROUTER_API_KEY') {
    const raw = textFile(join(getDataDir(), 'providers', 'openrouter.json'));
    return !raw || JSON.parse(raw).enabled !== false;
  }
  return true;
}
/** Fresh on every use. Resolution never exports a managed secret into server state. */
export function resolveProviderKey(name: string, ambient: Record<string, string | undefined> = process.env): string | null {
  try {
    const { values } = snapshot();
    if (!providerKeyEnabled(name)) return null;
    const raw = values.get(name);
    if (values.get(managedName(name)) === '1') {
      return raw ? decode(raw) || null : null;
    }
    const candidate = ambient[name]?.trim()
      || PROVIDER_KEY_ALIASES[name]?.map(alias => ambient[alias]?.trim()).find(Boolean);
    return candidate || (raw ? decode(raw) || null : null);
  } catch { return null; }
}
export interface ProviderCredentialMaterials { values: readonly string[]; hashes: ReadonlySet<string>; lengths: ReadonlySet<number> }
let readingCredentialMaterials = false;
/** Read-only snapshot: never resolves ambient aliases or triggers legacy cleanup. */
export function providerCredentialMaterials(): ProviderCredentialMaterials {
  const materials: string[] = [];
  const hashes = new Set<string>();
  const lengths = new Set<number>();
  const { values } = snapshot();
  const decryptSaved = !readingCredentialMaterials;
  readingCredentialMaterials = true;
  try {
    for (const name of PROVIDER_ENV_KEYS) {
      for (const hash of JSON.parse(values.get(`O8_KEY_HASHES_${name}`) || '[]') as string[]) if (/^[a-f0-9]{64}$/.test(hash)) hashes.add(hash);
      for (const length of JSON.parse(values.get(`O8_KEY_LENGTHS_${name}`) || '[]') as number[]) if (Number.isSafeInteger(length) && length > 0) lengths.add(length);
      const saved = values.get(name);
      if (saved && (decryptSaved || !saved.startsWith('enc:'))) {
        const plain = decode(saved);
        if (plain) { materials.push(plain); hashes.add(createHash('sha256').update(plain).digest('hex')); lengths.add(Buffer.byteLength(plain)); }
      }
    }
  } finally { readingCredentialMaterials = !decryptSaved; }
  return { values: materials, hashes, lengths };
}
/** Durable non-secret fingerprints also suppress stale copies after rotation or removal. */
export function providerCredentialHashes(): ReadonlySet<string> { return providerCredentialMaterials().hashes; }
export function mutateProviderKey(name: string, change: { key?: string | null; enabled?: boolean }): void {
  if (!(PROVIDER_ENV_KEYS as readonly string[]).includes(name)) throw new Error('Unsupported provider key');
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // SQLite's OS lock is shared with Rust and released even after process termination.
  const lock = new Database(join(dir, '.provider-keys.lock'), { timeout: 0 });
  let temporary: string | undefined;
  let committedValues: Map<string, string> | undefined;
  try {
    lock.exec('BEGIN EXCLUSIVE');
    const { raw, values } = snapshot();
    assertMasterKeyAvailableForMutation();
    assertProviderStoreAvailable();
    const updates = new Map<string, string | null>();
    const hashes = new Set<string>(JSON.parse(values.get(`O8_KEY_HASHES_${name}`) || '[]') as string[]);
    const lengths = new Set<number>(JSON.parse(values.get(`O8_KEY_LENGTHS_${name}`) || '[]') as number[]);
    const previous = values.get(name);
    if (previous) { const plain = decode(previous); hashes.add(createHash('sha256').update(plain).digest('hex')); lengths.add(Buffer.byteLength(plain)); }
    if (change.key?.trim()) { hashes.add(createHash('sha256').update(change.key.trim()).digest('hex')); lengths.add(Buffer.byteLength(change.key.trim())); }
    if (hashes.size) updates.set(`O8_KEY_HASHES_${name}`, JSON.stringify([...hashes]));
    if (lengths.size) updates.set(`O8_KEY_LENGTHS_${name}`, JSON.stringify([...lengths]));
    if ('key' in change) {
      let encoded: string | null = null;
      if (change.key) {
        const { iv, ciphertext } = encryptValueSync(change.key.trim());
        encoded = `enc:${iv}:${ciphertext}`;
      }
      updates.set(name, encoded);
      updates.set(managedName(name), '1');
    }
    if (change.enabled !== undefined) updates.set(disabledName(name), change.enabled ? '0' : '1');
    const lines = raw.split('\n').filter(line => !updates.has(line.split('=')[0].trim()));
    for (const [key, value] of updates) if (value !== null) lines.push(`${key}=${value}`);
    invalidateLaunchPolicy();
    warnLegacyRuntimeConfigs();
    // Preserve all untouched ciphertext and unrelated lines, including comments.
    temporary = join(dir, `.provider-keys.${randomUUID()}.tmp`);
    writeFileSync(temporary, lines.join('\n'), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(dir, '.env.local'));
    committedValues = parseKeyEnv(lines.join('\n'));
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
    lock.close();
  }
  if (committedValues) { credentialPolicyChanged(); }
}
