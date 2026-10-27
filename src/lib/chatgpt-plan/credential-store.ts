import 'server-only';

import { spawn } from '@/lib/providers/child-process';
import { clearSecret, lookupSecret, storeSecret } from '@/lib/providers/secret-service';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { ChatGPTPlanError, emptyPlanRecord, type PlanRecord, type PlanStore } from './types';

const SERVICE = 'ai.o8.chatgpt-plan';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const keyFor = (hostId: string, owner: string) => createHash('sha256')
  .update(JSON.stringify(['v1', hostId, owner])).digest('hex');

// Credential-bearing writes use bounded interactive commands over stdin.
// Reads/deletes pass only opaque entry names in argv. Never capture diagnostics.
function security(args: string[], input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new ChatGPTPlanError('secure_store_unavailable', 'Unlock the OS secure store and try again.', 503)); }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 2_000_000) child.kill(); });
    child.once('error', () => { clearTimeout(timer); reject(new ChatGPTPlanError('secure_store_unavailable', 'The OS secure store is unavailable.', 503)); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
    child.stdin.end(input);
  });
}

interface Manifest { version: string; count: number; digest: string }

/** One OS secret store: macOS Keychain or the Linux Secret Service. */
export interface PlanEntryStore {
  read(account: string): Promise<string | null>;
  /** Raw write; callers verify through `read`. */
  store(account: string, value: string): Promise<boolean>;
  remove(account: string): Promise<void>;
}

const keychainEntries: PlanEntryStore = {
  async read(account) {
    const result = await security(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
    if (result.code === 44) return null;
    if (result.code !== 0) throw new ChatGPTPlanError('secure_store_unavailable', 'Unlock the OS secure store and try again.', 503);
    return result.output.trim();
  },
  async store(account, value) {
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const command = `add-generic-password -U -a ${account} -s ${SERVICE} -X ${hex}`;
    // security's interactive parser truncates large commands. Each protected
    // chunk is small; a protected manifest is published only after verification.
    if (command.length > 1_900) throw new ChatGPTPlanError('secure_store_write_failed', 'The secure-store command exceeded its limit.', 503);
    return (await security(['-i'], `${command}\n`)).code === 0;
  },
  async remove(account) {
    await security(['delete-generic-password', '-a', account, '-s', SERVICE]).catch(() => {});
  },
};

const LINUX_UNAVAILABLE = 'ChatGPT plan sign-in on Linux needs a running Secret Service, such as GNOME Keyring or KWallet.';

/** Linux: freedesktop Secret Service through libsecret's secret-tool. */
export const secretServiceEntries: PlanEntryStore = {
  async read(account) {
    const result = await lookupSecret({ service: SERVICE, account });
    if (result.status === 'absent') return null;
    if (result.status === 'found') return result.value.trim();
    throw new ChatGPTPlanError('secure_store_unavailable', result.status === 'unavailable' ? LINUX_UNAVAILABLE : 'Unlock the OS secure store and try again.', 503);
  },
  async store(account, value) {
    const result = await storeSecret(`o8 ChatGPT plan ${account.slice(0, 12)}`, { service: SERVICE, account }, value);
    if (result.status === 'unavailable') throw new ChatGPTPlanError('secure_store_unavailable', LINUX_UNAVAILABLE, 503);
    return result.status === 'ok';
  },
  async remove(account) {
    await clearSecret({ service: SERVICE, account });
  },
};

/** The OS secret store for this platform. There is no file fallback. */
export function platformEntries(platform: NodeJS.Platform = process.platform): PlanEntryStore {
  if (platform === 'darwin') return keychainEntries;
  if (platform === 'linux') return secretServiceEntries;
  throw new ChatGPTPlanError('secure_store_unavailable', 'ChatGPT plan sign-in needs the macOS Keychain or a Linux Secret Service.', 503);
}

function manifest(value: string): Manifest {
  const parsed = JSON.parse(value) as Manifest;
  if (!/^[0-9a-f-]{36}$/.test(parsed.version) || !Number.isSafeInteger(parsed.count) || parsed.count < 1 || parsed.count > 1_024 || !/^[0-9a-f]{64}$/.test(parsed.digest)) throw new Error();
  return parsed;
}

/** There is deliberately no environment-key, encrypted-file, or plaintext fallback. */
export class OsPlanStore implements PlanStore {
  constructor(
    private readonly directory = join(getDataDir(), 'chatgpt-plan'),
    private readonly entries?: PlanEntryStore,
  ) {}

  private get store(): PlanEntryStore { return this.entries ?? platformEntries(); }

  private async readEntry(account: string): Promise<string | null> { return this.store.read(account); }

  private async writeEntry(account: string, value: string): Promise<void> {
    if (!await this.store.store(account, value) || await this.store.read(account) !== value) {
      throw new ChatGPTPlanError('secure_store_write_failed', 'ChatGPT credentials could not be saved securely.', 503);
    }
  }

  async hostId(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'host-id');
    try { await writeFile(path, `urn:uuid:${randomUUID()}`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const id = await readFile(path, 'utf8');
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(id)) throw new ChatGPTPlanError('host_id_invalid', 'The saved ChatGPT host registration is invalid.');
    return id;
  }

  async locked<T>(owner: string, action: () => Promise<T>): Promise<T> {
    // The OS secret store is user global. Copies retaining the same host ID must also
    // share the same rotation lock, regardless of their profile directory.
    const locks = join(getDataDir({}), 'chatgpt-plan-locks');
    await mkdir(locks, { recursive: true, mode: 0o700 });
    const path = join(locks, `${keyFor(await this.hostId(), owner)}.lock`);
    const until = Date.now() + 20_000;
    // Do not reclaim a lock on age alone: an interrupted rotating refresh is
    // uncertain. A stale lock requires explicit recovery, rather than replay.
    while (true) {
      try { await mkdir(path, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= until) throw new ChatGPTPlanError('credential_busy', 'ChatGPT credentials are busy or need recovery. No inference was started.', 503);
        await delay(50);
      }
    }
    try { return await action(); }
    finally { await rm(path, { recursive: true, force: true }); }
  }

  async read(owner: string): Promise<PlanRecord> {
    const account = keyFor(await this.hostId(), owner);
    const index = await this.readEntry(account);
    if (index === null) return emptyPlanRecord(owner);
    try {
      const selected = manifest(index);
      const chunks: Buffer[] = [];
      for (let part = 0; part < selected.count; part += 1) {
        const value = await this.readEntry(`${account}-${selected.version}-${part}`);
        if (value === null || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error();
        chunks.push(Buffer.from(value, 'base64'));
      }
      const bytes = Buffer.concat(chunks);
      if (createHash('sha256').update(bytes).digest('hex') !== selected.digest) throw new Error();
      const record = JSON.parse(bytes.toString('utf8')) as PlanRecord;
      if (record.owner !== owner || !Number.isSafeInteger(record.generation) || !Array.isArray(record.registrations)) throw new Error();
      return record;
    } catch (error) {
      if (error instanceof ChatGPTPlanError) throw error;
      throw new ChatGPTPlanError('secure_store_invalid', 'The saved ChatGPT connection could not be read.', 503);
    }
  }

  async write(owner: string, record: PlanRecord): Promise<void> {
    if (record.owner !== owner) throw new ChatGPTPlanError('account_mismatch', 'The connection belongs to another o8 account.', 403);
    const account = keyFor(await this.hostId(), owner);
    const previous = await this.readEntry(account);
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    const count = Math.ceil(bytes.length / 512);
    if (count > 1_024) throw new ChatGPTPlanError('secure_store_full', 'The ChatGPT connection record is too large.', 503);
    const version = randomUUID();
    const written: string[] = [];
    let publicationAttempted = false;
    try {
      for (let part = 0; part < count; part += 1) {
        const key = `${account}-${version}-${part}`;
        await this.writeEntry(key, bytes.subarray(part * 512, (part + 1) * 512).toString('base64'));
        written.push(key);
      }
      publicationAttempted = true;
      await this.writeEntry(account, JSON.stringify({ version, count, digest: createHash('sha256').update(bytes).digest('hex') } satisfies Manifest));
      if (previous) {
        const old = manifest(previous);
        for (let part = 0; part < old.count; part += 1) await this.store.remove(`${account}-${old.version}-${part}`).catch(() => {});
      }
    } finally {
      // An interrupted index write may have committed. Keep encrypted chunks
      // on that uncertain path so an index can never point to deleted data.
      if (!publicationAttempted) for (const key of written) await this.store.remove(key).catch(() => {});
    }
  }
}
