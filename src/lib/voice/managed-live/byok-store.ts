import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isMetadataLockProcessIdentity, type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export type ByokEvent = Record<string, unknown>;
export interface ByokReceipt {
  version: 1; id: string; owner: string; binding: string; keyFingerprint: string;
  requestId: string; requestFingerprint: string; createdAt: number;
  providerId: string | null; state: 'connecting' | 'active' | 'closing' | 'unknown' | 'closed';
  pid: number; processIdentity: MetadataLockProcessIdentity;
  seconds: number; finalSeconds: number | null; closeRequestedAt: number | null;
  closeReason?: 'session_limit';
  cursor: number; events: Array<{ cursor: number; event: ByokEvent }>;
  seen: Record<string, string>; sent: Record<string, { digest: string; state: 'pending' | 'submitted' }>;
  delegations: string[];
}
export const byokHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const BYOK_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const BYOK_PROVIDER_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
function directory(): string {
  const root = join(getDataDir(), 'byok-voice-relay');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe voice receipt directory');
  return root;
}
function validate(value: unknown): ByokReceipt {
  const r = value as ByokReceipt;
  if (!r || r.version !== 1 || !BYOK_UUID.test(r.id) || !BYOK_UUID.test(r.requestId)
    || ![r.owner, r.binding, r.keyFingerprint, r.requestFingerprint].every(v => typeof v === 'string' && HASH.test(v))
    || !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.pid) || r.pid < 1 || !isMetadataLockProcessIdentity(r.processIdentity)
    || (r.providerId !== null && (typeof r.providerId !== 'string' || !BYOK_PROVIDER_ID.test(r.providerId)))
    || !['connecting', 'active', 'closing', 'unknown', 'closed'].includes(r.state)
    || typeof r.seconds !== 'number' || !Number.isFinite(r.seconds) || r.seconds < 0
    || (r.finalSeconds !== null && (typeof r.finalSeconds !== 'number' || !Number.isFinite(r.finalSeconds) || r.finalSeconds < r.seconds))
    || (r.state === 'closed' && r.finalSeconds === null)
    || (r.closeRequestedAt !== null && !Number.isSafeInteger(r.closeRequestedAt))
    || (r.closeReason !== undefined && r.closeReason !== 'session_limit')
    || !Number.isSafeInteger(r.cursor) || r.cursor < 0 || !Array.isArray(r.events) || r.events.length > 512
    || !Array.isArray(r.delegations) || r.delegations.length > 4096 || !r.delegations.every(v => typeof v === 'string' && v.length <= 100)
    || !r.seen || typeof r.seen !== 'object' || Array.isArray(r.seen) || Object.keys(r.seen).length > 4096
    || !Object.values(r.seen).every(v => typeof v === 'string' && HASH.test(v))
    || !r.sent || typeof r.sent !== 'object' || Array.isArray(r.sent) || Object.keys(r.sent).length > 4096
    || !Object.values(r.sent).every(v => v && HASH.test(v.digest) && ['pending', 'submitted'].includes(v.state))) throw new Error('Invalid voice receipt');
  let previous = r.cursor - r.events.length;
  for (const entry of r.events) {
    if (!entry || entry.cursor !== ++previous || !entry.event || typeof entry.event !== 'object' || Array.isArray(entry.event)) throw new Error('Invalid voice event receipt');
  }
  return r;
}
export function loadByokReceipt(id: string): ByokReceipt | null {
  if (!BYOK_UUID.test(id)) return null;
  let fd: number;
  try { fd = openSync(join(directory(), `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe voice receipt');
    const record = validate(JSON.parse(readFileSync(fd, 'utf8')));
    if (record.id !== id) throw new Error('Voice receipt mismatch');
    return record;
  } finally { closeSync(fd); }
}
export function listByokReceipts(): ByokReceipt[] {
  const files = readdirSync(directory()).filter(name => name.endsWith('.json'));
  if (files.length > 4096) throw new Error('Voice receipt capacity reached');
  return files.map(name => {
    const record = loadByokReceipt(name.slice(0, -5));
    if (!record) throw new Error('Unrecognized voice receipt');
    return record;
  });
}
/** Reserve before spending; atomic checkpoints retain ambiguous provider outcomes. */
export function saveByokReceipt(record: ByokReceipt, create = false): void {
  validate(record);
  const root = directory(); const target = join(root, `${record.id}.json`);
  const temporary = join(root, `${randomUUID()}.tmp`); const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    if (create) linkSync(temporary, target); else renameSync(temporary, target);
    if (process.platform !== 'win32') {
      const dirFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally { try { unlinkSync(temporary); } catch { /* Renamed checkpoints have no temporary path. */ } }
}
