/**
 * Master Key Resolver — AES-256-GCM master encryption key source.
 *
 * Resolution order (server-side Node.js process):
 *   1. O8_MASTER_KEY env var — CI / headless override, always wins.
 *   2. macOS Keychain via `security` CLI — creates a fresh 256-bit key on
 *      first call; subsequent calls retrieve the same key. Only on darwin.
 *   3. Linux Secret Service via `secret-tool` (GNOME Keyring, KWallet, KeePassXC)
 *      for new installs, when one is running. An existing key file keeps winning.
 *   4. Persisted random key file — reproducible across restarts, used when no
 *      OS secret store is available (headless Linux, CI, other platforms).
 *
 * The Tauri commands `master_key_get` / `master_key_ensure` (src-tauri/src/lib.rs)
 * use the same native master-key resolver. Provider inventory never exposes secrets.
 *
 * The returned key is a URL-safe base64-encoded 256-bit value (no padding).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { hasEncryptedKeyValues } from '@/lib/providers/env-format';
import { execKeychainCommand } from '@/lib/providers/child-process';
import { lookupSecretSync, storeSecretSync } from '@/lib/providers/secret-service';
import Database from 'better-sqlite3';

// ── Constants ──

/** Fallback env var for non-Tauri / dev environments. */
const ENV_MASTER_KEY = 'O8_MASTER_KEY';

/** Keychain service + account — must match src-tauri/src/lib.rs constants. */
const KEYCHAIN_SERVICE = 'ai.o8.master-key';
const KEYCHAIN_ACCOUNT = 'default';

function dataDir(): string {
  return getDataDir();
}

/** Every store sharing this key must prevent first-run creation after key loss. */
function hasEncryptedStoredCredentials(): boolean {
  const providerPath = join(dataDir(), '.env.local');
  if (existsSync(providerPath) && hasEncryptedKeyValues(readFileSync(providerPath, 'utf8'))) return true;
  const acpPath = join(dataDir(), 'acp-environment.sqlite');
  if (!existsSync(acpPath)) return false;
  const db = new Database(acpPath, { readonly: true, fileMustExist: true });
  try { return Boolean(db.prepare('SELECT 1 FROM credentials LIMIT 1').get()); }
  finally { db.close(); }
}

/**
 * Read (or first-run create) a persisted random master key file at
 * ~/.o8/master-key, mode 0600. This replaces the former hardcoded all-zeros
 * "dev static key", which made AES-256-GCM encryption-at-rest worthless on any
 * platform without the macOS Keychain (SECURITY_AUDIT_2026-07-02 §MED-1). The
 * key is reproducible across restarts (persisted) but secret (random + 0600).
 */
function readOrCreateKeyFile(create: boolean): string {
  const keyPath = join(dataDir(), 'master-key');
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, 'utf-8').trim();
    if (Buffer.from(existing, 'base64url').length !== 32) throw new Error('Invalid persisted master key');
    return existing;
  }
  if (!create) throw new Error('Master key unavailable');
  if (hasEncryptedStoredCredentials()) {
    throw new Error('Encrypted credentials exist without an accessible master key');
  }
  const key = generateKey();
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  return key;
}

// ── Master key resolution ──

let _cachedKey: string | null = null;

type KeychainRead =
  | { status: 'found'; key: string }
  | { status: 'absent' }
  | { status: 'error'; detail: string };

/**
 * Read the master key directly from the macOS Keychain using the `security`
 * CLI. This is the server-side path — no Tauri IPC needed because the Next.js
 * server process runs on the same macOS machine.
 *
 * Distinguishes "entry genuinely absent" (exit 44, errSecItemNotFound — safe
 * to create a fresh key) from "read FAILED" (locked Keychain, denied ACL —
 * the entry may exist, and generating a replacement would orphan every blob
 * encrypted under it).
 */
function readKeychainKey(): KeychainRead {
  if (process.platform !== 'darwin') return { status: 'absent' };
  try {
    const out = execKeychainCommand('find-generic-password', ['-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']).trim();
    // Malformed existing entries are unavailable, never permission to replace them.
    return Buffer.from(out, 'base64url').length === 32 ? { status: 'found', key: out } : { status: 'error', detail: 'Invalid existing master key' };
  } catch (err) {
    const exitStatus = (err as { status?: number | null }).status;
    if (exitStatus === 44) return { status: 'absent' }; // errSecItemNotFound
    return {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Write (or update) the master key in the macOS Keychain.
 * Returns true on success.
 */
function writeKeychainKey(key: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execKeychainCommand('add-generic-password', ['-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', key]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically random 256-bit key as URL-safe base64 (no padding).
 */
function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Resolve the AES-256-GCM master encryption key.
 *
 * Resolution order:
 *   1. O8_MASTER_KEY env var  (CI / headless override, always wins).
 *   2. macOS Keychain via `security` CLI (creates entry on first call).
 *   3. Linux Secret Service via `secret-tool` (new installs, when running).
 *   4. Persisted random key file (reproducible across restarts, no OS store needed).
 *
 * Reads may use the in-process cache; mutations always revalidate its source.
 */
export function resolveMasterKeySync(): string {
  return _cachedKey ?? (_cachedKey = resolveBackingKey(true));
}

export class MasterKeyUnavailableError extends Error {
  readonly code = 'master_key_unavailable';
  constructor() {
    super('Master key unavailable or changed. Restore the original master key and retry. Previous keys were preserved.');
  }
}

/** Re-read the backing source without rotating an established process identity. */
export function assertMasterKeyAvailableForMutation(options: { createIfMissing?: boolean } = {}): string {
  try {
    const current = resolveBackingKey(_cachedKey === null && options.createIfMissing !== false);
    if (_cachedKey && !decodeBase64Url(current).equals(decodeBase64Url(_cachedKey))) throw new Error('Master key changed');
    _cachedKey = current;
    return current;
  } catch { throw new MasterKeyUnavailableError(); }
}

function resolveBackingKey(create: boolean): string {

  // 1. Env-var override.
  const envKey = process.env[ENV_MASTER_KEY];
  if (envKey) {
    if (Buffer.from(envKey, 'base64url').length !== 32) throw new Error('Invalid O8_MASTER_KEY');
    return envKey;
  }

  // 2. macOS Keychain (server-side direct CLI call).
  if (process.platform === 'darwin') {
    const read = readKeychainKey();

    if (read.status === 'error') {
      // The entry may EXIST but be unreadable right now (locked Keychain,
      // ACL change after an OS update). Anything we'd do silently here is
      // wrong: generating a fresh key with `add-generic-password` would
      // OVERWRITE the real entry and orphan every previously-encrypted blob;
      // falling to the dev key would re-encrypt new secrets under a
      // non-secret value. Fail loudly — feature unavailable beats silent
      // data loss. Not cached, so a later call retries.
      console.error(`[master-key] Keychain read FAILED (not "absent"): ${read.detail}`);
      throw new Error(
        `Keychain read failed — refusing to rotate or downgrade the master key. Unlock the login Keychain and retry. (${read.detail})`,
      );
    }

    let keychainKey = read.status === 'found' ? read.key : null;
    if (!keychainKey) {
      // Genuinely absent (first run) — generate and persist.
      if (existsSync(join(dataDir(), 'master-key'))) return readOrCreateKeyFile(create);
      if (hasEncryptedStoredCredentials()) throw new Error('Encrypted credentials exist without a master key');
      if (!create) throw new Error('Master key unavailable');
      const newKey = generateKey();
      if (writeKeychainKey(newKey)) {
        keychainKey = newKey;
        console.log('[master-key] Generated and stored new key in macOS Keychain');
      } else {
        const retry = readKeychainKey();
        if (retry.status === 'found') keychainKey = retry.key;
        else throw new Error('Keychain write failed; existing state preserved');
      }
    } else {
      console.log('[master-key] Resolved from macOS Keychain');
    }
    if (keychainKey) {
      return keychainKey;
    }
  }

  // 3. Linux Secret Service, when one is running.
  if (process.platform === 'linux') {
    const secretServiceKey = resolveSecretServiceKey(create);
    if (secretServiceKey) return secretServiceKey;
  }

  // 4. Persisted random key file (0600) — no OS secret store, or a key file
  //    that predates one. NEVER a hardcoded constant (§MED-1).
  return readOrCreateKeyFile(create);
}

const SECRET_SERVICE_ATTRIBUTES = { service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT } as const;
/** Non-secret marker: the key lives in the Secret Service, so never mint a file key. */
const SECRET_SERVICE_MARKER = 'master-key.secret-service';
let _loggedFileFallback = false;

/**
 * Linux Secret Service resolution. Returns null when the 0600 key file should
 * be used instead: a key file already exists (it stays authoritative and is
 * never moved), or no Secret Service is running and none was used before.
 * Throws rather than rotate when a key that lives in the service can't be read.
 */
function resolveSecretServiceKey(create: boolean): string | null {
  if (existsSync(join(dataDir(), 'master-key'))) return null;
  const marker = join(dataDir(), SECRET_SERVICE_MARKER);
  const read = lookupSecretSync(SECRET_SERVICE_ATTRIBUTES);
  if (read.status === 'found') {
    const key = read.value.trim();
    if (Buffer.from(key, 'base64url').length !== 32) throw new Error('Invalid existing master key');
    return key;
  }
  if (read.status === 'unavailable' && !existsSync(marker)) {
    if (!_loggedFileFallback) {
      _loggedFileFallback = true;
      console.warn(`[master-key] Secret Service unavailable (${read.detail}); using the 0600 key file at ${join(dataDir(), 'master-key')}`);
    }
    return null;
  }
  if (read.status !== 'absent' || existsSync(marker)) {
    // Locked collection, dismissed prompt, or a key this install stored in the
    // service and can't reach now. Minting a replacement would orphan every blob.
    const why = read.status === 'absent' ? 'the stored key is missing' : read.detail;
    console.error(`[master-key] Secret Service read FAILED (not "absent"): ${why}`);
    throw new Error(`Secret Service read failed — refusing to rotate or downgrade the master key. Unlock the keyring and retry. (${why})`);
  }
  if (hasEncryptedStoredCredentials()) throw new Error('Encrypted credentials exist without a master key');
  if (!create) throw new Error('Master key unavailable');
  const key = generateKey();
  const stored = storeSecretSync('o8 master key', SECRET_SERVICE_ATTRIBUTES, key);
  if (stored.status === 'unavailable') return null;
  if (stored.status === 'error') throw new Error(`Secret Service write failed; existing state preserved (${stored.detail})`);
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(marker, 'The o8 master key is stored in the Secret Service (service ai.o8.master-key).\n', { mode: 0o600 });
  console.log('[master-key] Generated and stored new key in the Secret Service');
  return key;
}

/**
 * Bust the in-process key cache.  Useful in tests or after a key rotation.
 */
export function clearMasterKeyCache(): void {
  _cachedKey = null;
}

// ── AES-256-GCM helpers ──

const CIPHER_ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

/** Decode a URL-safe base64 string (no padding) to a Buffer. */
function decodeBase64Url(s: string): Buffer {
  // Restore standard base64 padding and replace URL-safe chars.
  const standard = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * @returns `{ ciphertext, iv }` — both are hex strings suitable for storage.
 */
export function encryptValueSync(plaintext: string): { ciphertext: string; iv: string } {
  const keyBuf = decodeBase64Url(assertMasterKeyAvailableForMutation());
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER_ALGORITHM, keyBuf, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Append auth tag to ciphertext so it's stored together.
  const payload = Buffer.concat([encrypted, authTag]);
  return {
    ciphertext: payload.toString('hex'),
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt a value previously produced by `encryptValue`.
 *
 * @returns the plaintext, or `null` if decryption fails.
 */
export function decryptValueSync(ciphertext: string, iv: string): string | null {
  try {
    const keyBuf = decodeBase64Url(resolveMasterKeySync());
    const ivBuf = Buffer.from(iv, 'hex');
    const payload = Buffer.from(ciphertext, 'hex');
    // Last AUTH_TAG_LENGTH bytes are the auth tag.
    const encryptedBuf = payload.slice(0, payload.length - AUTH_TAG_LENGTH);
    const authTag = payload.slice(payload.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(CIPHER_ALGORITHM, keyBuf, ivBuf, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

// Async compatibility for existing database callers.
export async function resolveMasterKey(): Promise<string> { return resolveMasterKeySync(); }
export async function encryptValue(plaintext: string): Promise<{ ciphertext: string; iv: string }> { return encryptValueSync(plaintext); }
export async function decryptValue(ciphertext: string, iv: string): Promise<string | null> { return decryptValueSync(ciphertext, iv); }
