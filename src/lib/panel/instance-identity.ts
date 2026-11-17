import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getDataDir } from '@/lib/data-dir-migration';

export interface InstanceIdentity {
  product: 'o8';
  instanceId: string;
  bootId: string;
  apiPort: number;
  wsPort: number;
  version: string;
}

let cached: InstanceIdentity | null = null;
let fallbackInstanceId: string | null = null;
let fallbackBootId: string | null = null;

export function instanceIdentityDataDir(): string {
  return getDataDir();
}

function readTextFile(name: string): string | null {
  try {
    const value = readFileSync(join(instanceIdentityDataDir(), name), 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeTextFileOnce(name: string, value: string): void {
  const dir = instanceIdentityDataDir();
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, name), `${value}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function deriveInstanceIdFromExistingE2eeIdentity(): string | null {
  try {
    const path = join(instanceIdentityDataDir(), 'e2ee-identity.key');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return null;
    const secretKey = Buffer.from(raw, 'base64');
    if (secretKey.length < 64) return null;
    const publicKey = secretKey.subarray(32, 64);
    // Prefer the existing mobile E2EE server identity when present so the local
    // port identity follows the install's long-lived cryptographic identity
    // without creating E2EE keys just because /api/setup/identity was read.
    return `o8-${createHash('sha256').update(publicKey).digest('hex').slice(0, 32)}`;
  } catch {
    return null;
  }
}

function resolvePersistedId(envName: string, fileName: string, fallbackKey: 'instance' | 'boot'): string {
  const fromEnv = envValue(envName);
  if (fromEnv) return fromEnv;

  const fromFile = readTextFile(fileName);
  if (fromFile) return fromFile;

  const derived = fallbackKey === 'instance' ? deriveInstanceIdFromExistingE2eeIdentity() : null;
  const generated = derived ?? randomUUID();
  try {
    writeTextFileOnce(fileName, generated);
    return readTextFile(fileName) ?? generated;
  } catch {
    if (fallbackKey === 'instance') {
      fallbackInstanceId ??= generated;
      return fallbackInstanceId;
    }
    fallbackBootId ??= generated;
    return fallbackBootId;
  }
}

export function clearInstanceIdentityCacheForTests(): void {
  cached = null;
  fallbackInstanceId = null;
  fallbackBootId = null;
}

export function getInstanceIdentity(): InstanceIdentity {
  const { apiPort, wsPort } = resolvePortInfo();
  const instanceId = resolvePersistedId('O8_INSTANCE_ID', 'instance-id', 'instance');
  const bootId = resolvePersistedId('O8_BOOT_ID', 'boot-id', 'boot');

  const next: InstanceIdentity = {
    product: 'o8',
    instanceId,
    bootId,
    apiPort,
    wsPort,
    version: packageJson.version,
  };

  cached = next;
  return next;
}

export function getCachedInstanceIdentity(): InstanceIdentity {
  return cached ?? getInstanceIdentity();
}

/** Read-only transport snapshot; admission must not initialize identity files. */
export function peekCachedInstanceIdentity(): InstanceIdentity | null {
  return cached;
}
