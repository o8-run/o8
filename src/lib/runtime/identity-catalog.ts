import 'server-only';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { writeJsonFile } from '@/lib/fs/json';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { readPacketSessionIdentitySync } from '@/lib/runtimes/shared/owned-session/packet-identity';

const IDENTITY_CATALOG_SCHEMA = 'o8/runtime-identities/v1' as const;

export interface RuntimeIdentityRecord {
  id: string;
  runtime: string;
  label: string;
  /** Server-only. Never include this field in an API, event, or transcript. */
  configHomeRef: string;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeLaunchIdentity = Pick<RuntimeIdentityRecord, 'id' | 'label' | 'configHomeRef'>;

interface RuntimeIdentityCatalog {
  schema: typeof IDENTITY_CATALOG_SCHEMA;
  identities: RuntimeIdentityRecord[];
  selectedByRuntime: Record<string, string>;
  packetBindings: Record<string, RuntimeIdentityRecord>;
}

export interface PublicRuntimeIdentity {
  id: string;
  runtime: string;
  label: string;
  selected: boolean;
}

const catalogWriteChains = new Map<string, Promise<unknown>>();

function catalogPath(): string {
  return path.join(getDataDir(), 'runtime-identities.json');
}

function emptyCatalog(): RuntimeIdentityCatalog {
  return {
    schema: IDENTITY_CATALOG_SCHEMA,
    identities: [],
    selectedByRuntime: {},
    packetBindings: {},
  };
}

function normalizeCatalog(value: unknown): RuntimeIdentityCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('identity_catalog_malformed');
  }
  const record = value as Partial<RuntimeIdentityCatalog>;
  if (record.schema !== IDENTITY_CATALOG_SCHEMA || !Array.isArray(record.identities)) {
    throw new Error('identity_catalog_malformed');
  }
  if (!record.selectedByRuntime
    || typeof record.selectedByRuntime !== 'object'
    || Array.isArray(record.selectedByRuntime)) {
    throw new Error('identity_catalog_malformed');
  }
  const identities = record.identities;
  const validIdentities = identities.every((entry) => Boolean(
    entry
    && typeof entry.id === 'string'
    && typeof entry.runtime === 'string'
    && typeof entry.label === 'string'
    && typeof entry.configHomeRef === 'string'
    && typeof entry.createdAt === 'string'
    && typeof entry.updatedAt === 'string',
  ));
  const selectedEntries = Object.entries(record.selectedByRuntime);
  if (!validIdentities || selectedEntries.some((entry) => typeof entry[1] !== 'string')) {
    throw new Error('identity_catalog_malformed');
  }
  const selectedByRuntime = Object.fromEntries(selectedEntries) as Record<string, string>;
  const packetBindings = record.packetBindings === undefined
    ? {}
    : record.packetBindings;
  if (!packetBindings || typeof packetBindings !== 'object' || Array.isArray(packetBindings)) {
    throw new Error('identity_catalog_malformed');
  }
  const validBindings = Object.values(packetBindings).every((entry) => Boolean(
    entry
    && typeof entry.id === 'string'
    && typeof entry.runtime === 'string'
    && typeof entry.label === 'string'
    && typeof entry.configHomeRef === 'string'
    && typeof entry.createdAt === 'string'
    && typeof entry.updatedAt === 'string',
  ));
  if (!validBindings) throw new Error('identity_catalog_malformed');
  return {
    schema: IDENTITY_CATALOG_SCHEMA,
    identities,
    selectedByRuntime,
    packetBindings: packetBindings as Record<string, RuntimeIdentityRecord>,
  };
}

async function readCatalog(): Promise<RuntimeIdentityCatalog> {
  try {
    return normalizeCatalog(JSON.parse(await readFile(catalogPath(), 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCatalog();
    throw new Error('identity_catalog_unavailable');
  }
}

async function writeCatalog(catalog: RuntimeIdentityCatalog): Promise<void> {
  const filePath = catalogPath();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeJsonFile(filePath, catalog, { mode: 0o600 });
}

function withCatalogWrite<T>(operation: () => Promise<T>): Promise<T> {
  return chainOnKey(catalogWriteChains, catalogPath(), operation);
}

function identityId(runtime: string, configHomeRef: string): string {
  const digest = createHash('sha256').update(runtime).update('\0').update(configHomeRef).digest('hex');
  return `${runtime.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${digest.slice(0, 16)}`;
}

export async function registerRuntimeIdentity(input: {
  runtime: string;
  label: string;
  configHomeRef: string;
}): Promise<RuntimeIdentityRecord> {
  return withCatalogWrite(async () => {
    const catalog = await readCatalog();
    const now = new Date().toISOString();
    const id = identityId(input.runtime, input.configHomeRef);
    const existing = catalog.identities.find((entry) => entry.id === id);
    const identity: RuntimeIdentityRecord = existing
      ? { ...existing, label: input.label, updatedAt: now }
      : {
          id,
          runtime: input.runtime,
          label: input.label,
          configHomeRef: input.configHomeRef,
          createdAt: now,
          updatedAt: now,
        };
    catalog.identities = existing
      ? catalog.identities.map((entry) => entry.id === id ? identity : entry)
      : [...catalog.identities, identity];
    await writeCatalog(catalog);
    return identity;
  });
}

export async function selectRuntimeIdentity(runtime: string, id: string): Promise<RuntimeIdentityRecord> {
  return withCatalogWrite(async () => {
    const catalog = await readCatalog();
    const identity = catalog.identities.find((entry) => entry.id === id && entry.runtime === runtime);
    if (!identity) throw new Error('identity_not_found');
    catalog.selectedByRuntime[runtime] = identity.id;
    await writeCatalog(catalog);
    return identity;
  });
}

export async function getSelectedRuntimeIdentity(runtime: string): Promise<RuntimeIdentityRecord | null> {
  const catalog = await readCatalog();
  const selectedId = catalog.selectedByRuntime[runtime];
  if (!selectedId) return null;
  return catalog.identities.find((entry) => entry.id === selectedId && entry.runtime === runtime) ?? null;
}

/** Synchronous admission boundaries use the same persisted, validated selection. */
export function getSelectedRuntimeIdentitySync(runtime: string): RuntimeLaunchIdentity | null {
  return getRuntimeLaunchIdentitySync(runtime);
}

/** One precedence for admission and execution: explicit, saved, bound, selected. */
export function getRuntimeLaunchIdentitySync(runtime: string, packetId?: string, context: {
  identity?: RuntimeLaunchIdentity; configHome?: string; sessionRoot?: string; surfacePrefix?: string;
} = {}): RuntimeLaunchIdentity | null {
  if (context.identity) return context.identity;
  if (context.configHome) return { id: identityId(runtime, context.configHome), label: 'Explicit runtime account', configHomeRef: context.configHome };
  const sessionRoot = context.sessionRoot ?? (runtime === 'codex'
    ? process.env.CORTEX_IDE_OWNED_CODEX_ROOT || path.join(getDataDir(), 'owned-codex')
    : runtime === 'muse' ? process.env.O8_OWNED_MUSE_ROOT || path.join(getDataDir(), 'owned-muse') : undefined);
  if (packetId && sessionRoot) {
    const saved = readPacketSessionIdentitySync(sessionRoot, context.surfacePrefix ?? `${runtime}-owned:`, packetId);
    if (saved) return saved;
  }
  let catalog: RuntimeIdentityCatalog;
  try {
    catalog = normalizeCatalog(JSON.parse(readFileSync(catalogPath(), 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('identity_catalog_unavailable');
  }
  const pinned = packetId ? catalog.packetBindings[`${runtime}\0${packetId}`] : undefined;
  if (pinned) return pinned;
  const selectedId = catalog.selectedByRuntime[runtime];
  return catalog.identities.find(entry => entry.id === selectedId && entry.runtime === runtime) ?? null;
}

export async function reconcileRuntimeIdentityMutation(input:
  | { action: 'register'; runtime: string; label: string; configHomeRef: string }
  | { action: 'select'; runtime: string; identityId: string }
): Promise<RuntimeIdentityRecord | null> {
  const catalog = await readCatalog();
  if (input.action === 'register') {
    return catalog.identities.find((identity) => (
      identity.runtime === input.runtime
      && identity.label === input.label
      && identity.configHomeRef === input.configHomeRef
    )) ?? null;
  }
  if (catalog.selectedByRuntime[input.runtime] !== input.identityId) return null;
  return catalog.identities.find((identity) => (
    identity.runtime === input.runtime && identity.id === input.identityId
  )) ?? null;
}

/** Server-only identity records, including the private config-home reference. */
export async function listRuntimeIdentitiesForServer(runtime: string): Promise<RuntimeIdentityRecord[]> {
  const catalog = await readCatalog();
  return catalog.identities
    .filter((identity) => identity.runtime === runtime)
    .map((identity) => ({ ...identity }));
}

/** Resolve one opaque identity ID to its private config home without client projection. */
export async function getRuntimeIdentityForServer(
  runtime: string,
  id: string,
): Promise<RuntimeIdentityRecord | null> {
  const catalog = await readCatalog();
  const identity = catalog.identities.find((entry) => entry.runtime === runtime && entry.id === id);
  return identity ? { ...identity } : null;
}

export async function getOrPinPacketRuntimeIdentity(input: {
  runtime: string;
  packetId: string;
  fallback: { id: string; label: string; configHomeRef: string };
  preferred?: { id: string; label: string; configHomeRef: string };
}): Promise<RuntimeIdentityRecord> {
  return withCatalogWrite(async () => {
    const catalog = await readCatalog();
    const bindingKey = `${input.runtime}\0${input.packetId}`;
    const existing = catalog.packetBindings[bindingKey];
    // A server-resolved or saved-session identity is authoritative for this
    // launch. Persist it so a stale catalog binding cannot change the child.
    if (existing && (!input.preferred || (existing.id === input.preferred.id
      && existing.configHomeRef === input.preferred.configHomeRef))) return existing;
    const selectedId = catalog.selectedByRuntime[input.runtime];
    const selected = catalog.identities.find(
      (identity) => identity.id === selectedId && identity.runtime === input.runtime,
    );
    const now = new Date().toISOString();
    const binding: RuntimeIdentityRecord = {
      ...(input.preferred ?? selected ?? input.fallback),
      runtime: input.runtime,
      createdAt: now,
      updatedAt: now,
    };
    catalog.packetBindings[bindingKey] = binding;
    await writeCatalog(catalog);
    return binding;
  });
}

export async function listPublicRuntimeIdentities(): Promise<PublicRuntimeIdentity[]> {
  const catalog = await readCatalog();
  return catalog.identities.map((identity) => ({
    id: identity.id,
    runtime: identity.runtime,
    label: identity.label,
    selected: catalog.selectedByRuntime[identity.runtime] === identity.id,
  }));
}

export function resetRuntimeIdentityCatalogForTests(): void {
  catalogWriteChains.clear();
}
