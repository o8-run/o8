import 'server-only';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { assertMasterKeyAvailableForMutation, decryptValueSync, encryptValueSync } from '@/lib/db/master-key';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { providerCredentialName } from '@/lib/providers/spawn-environment';

export interface AcpEnvironmentBinding { connectionId: string; revision: number }
export interface AcpEnvironmentVariable { name: string; secret: boolean; value?: string; configured?: boolean }
export interface AcpEnvironmentInventory extends AcpEnvironmentBinding { variables: AcpEnvironmentVariable[] }
interface Configuration { revision: number; variables: string }

export class AcpEnvironmentConflict extends Error {}

/** One saved Local ACP connection, bound to its exact executable/arguments/policy. */
export function acpEnvironmentId(connection: { command: string; args: string[]; useOpenRouter: boolean }): string {
  return createHash('sha256').update(JSON.stringify([connection.command, connection.args, connection.useOpenRouter])).digest('hex');
}

function withDatabase<T>(operation: (db: Database.Database) => T): T {
  const directory = getDataDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'acp-environment.sqlite');
  const db = new Database(path, { timeout: 1000 });
  try {
    chmodSync(path, 0o600);
    db.exec(`CREATE TABLE IF NOT EXISTS configuration (
      connection_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, variables TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (
      connection_id TEXT NOT NULL, name TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL,
      PRIMARY KEY(connection_id, name));`);
    return operation(db);
  } finally { db.close(); }
}

function inventory(db: Database.Database, connectionId: string): AcpEnvironmentInventory {
  const row = db.prepare('SELECT revision, variables FROM configuration WHERE connection_id = ?').get(connectionId) as Configuration | undefined;
  const variables = row ? JSON.parse(row.variables) as AcpEnvironmentVariable[] : [];
  return { connectionId, revision: row?.revision ?? 0, variables };
}

export function readAcpEnvironment(connectionId: string): AcpEnvironmentInventory {
  return withDatabase(db => inventory(db, connectionId));
}

// These names alter process admission, credential routing or executable discovery.
// Provider credentials continue through the existing explicit sharing/billing path.
const RESERVED = /^(?:O8_|NODE_|LD_|DYLD_|GIT_|SSH_|PYTHON|JAVA_|JDK_|BASH_|XDG_|OPENAI_|ANTHROPIC_|OPENROUTER_|CODEX_|CLAUDE_|GEMINI_|GOOGLE_|GROQ_|DEEPSEEK_|COPILOT_|GOOSE_|LLM_|ELECTRON_|NPM_|npm_)/i;
const RESERVED_NAMES = new Set(['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SHELL', 'ENV', 'PWD', 'OLDPWD', 'IFS', 'TMPDIR', 'TMP', 'TEMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', '__PROTO__', 'CONSTRUCTOR', 'PROTOTYPE']);
function parseVariables(input: unknown): AcpEnvironmentVariable[] {
  if (!Array.isArray(input) || input.length > 32) throw new Error('Use at most 32 environment variables.');
  const names = new Set<string>();
  return input.map(item => {
    const v = item as AcpEnvironmentVariable | null;
    if (!v || typeof v.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v.name)
      || RESERVED.test(v.name) || RESERVED_NAMES.has(v.name.toUpperCase()) || providerCredentialName(v.name.toUpperCase())) {
      throw new Error('Use a valid variable name outside process controls and provider credentials.');
    }
    const name = v.name.toUpperCase();
    if (names.has(name)) throw new Error('Environment variable names must be unique.');
    names.add(name);
    if (typeof v.secret !== 'boolean' || (!v.secret && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(v.name))) {
      throw new Error('Credential variables must be marked secret.');
    }
    if (v.value !== undefined && (typeof v.value !== 'string' || v.value.length > 8192 || v.value.includes('\0'))) {
      throw new Error('Use a variable value of at most 8192 characters without null bytes.');
    }
    if (!v.secret && v.value === undefined) throw new Error('Ordinary variables require a value.');
    return { name: v.name, secret: v.secret, ...(v.value !== undefined ? { value: v.value } : {}) };
  });
}

/** One SQLite transaction keeps encrypted credentials and ordinary config consistent. */
export function saveAcpEnvironment(binding: AcpEnvironmentBinding, input: unknown, beforeCommit?: () => void): AcpEnvironmentInventory {
  const variables = parseVariables(input);
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 0) throw new Error('A current environment revision is required.');
  return withProviderStoreLock(() => withDatabase(db => db.transaction(() => {
    const current = inventory(db, binding.connectionId);
    if (current.revision !== binding.revision) throw new AcpEnvironmentConflict('The connection environment changed. Reload it before saving.');
    const rows = db.prepare('SELECT name, iv, ciphertext FROM credentials WHERE connection_id = ?').all(binding.connectionId) as Array<{ name: string; iv: string; ciphertext: string }>;
    const stored = new Map(rows.map(row => [row.name, row]));
    if (variables.some(v => v.secret && v.value !== undefined)) {
      // The shared resolver must not create a replacement key while any
      // connection still has encrypted material that this key cannot open.
      const encryptedRows = db.prepare('SELECT iv, ciphertext FROM credentials').all() as Array<{ iv: string; ciphertext: string }>;
      if (encryptedRows.length) assertMasterKeyAvailableForMutation({ createIfMissing: false });
      if (encryptedRows.some(row => decryptValueSync(row.ciphertext, row.iv) === null)) throw new Error('The connection credential store is unavailable.');
    }
    const credentials = variables.filter(v => v.secret).map(v => {
      const encrypted = v.value === undefined ? stored.get(v.name) : encryptValueSync(v.value);
      if (!encrypted) throw new Error('Enter a value for each new secret.');
      return { name: v.name, iv: encrypted.iv, ciphertext: encrypted.ciphertext };
    });
    db.prepare('DELETE FROM credentials WHERE connection_id = ?').run(binding.connectionId);
    for (const credential of credentials) db.prepare('INSERT INTO credentials VALUES (?, ?, ?, ?)')
      .run(binding.connectionId, credential.name, credential.iv, credential.ciphertext);
    const masked = variables.map(v => v.secret ? { name: v.name, secret: true, configured: true } : v);
    db.prepare(`INSERT INTO configuration VALUES (?, ?, ?) ON CONFLICT(connection_id)
      DO UPDATE SET revision = excluded.revision, variables = excluded.variables`)
      .run(binding.connectionId, current.revision + 1, JSON.stringify(masked));
    beforeCommit?.();
    return { connectionId: binding.connectionId, revision: current.revision + 1, variables: masked };
  }).immediate()));
}

/** Called only for the selected Local ACP launch; never exports into process.env. */
export function resolveAcpEnvironment(connectionId: string) {
  return withDatabase(db => db.transaction(() => {
    const current = inventory(db, connectionId);
    if (current.variables.some(variable => variable.secret)) assertMasterKeyAvailableForMutation({ createIfMissing: false });
    const env: Record<string, string> = {};
    for (const variable of current.variables) {
      if (!variable.secret) { env[variable.name] = variable.value!; continue; }
      const row = db.prepare('SELECT iv, ciphertext FROM credentials WHERE connection_id = ? AND name = ?')
        .get(connectionId, variable.name) as { iv: string; ciphertext: string } | undefined;
      const value = row ? decryptValueSync(row.ciphertext, row.iv) : null;
      if (value === null) throw new Error('The connection credential store is unavailable.');
      env[variable.name] = value;
    }
    return { env, localEnvironment: { connectionId, revision: current.revision } };
  })());
}
