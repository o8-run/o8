/**
 * Provider instances (Settings › Providers, slice 3): more than one copy of a
 * runtime, each with its own display name, binary, home directory and env.
 *
 * Storage: `~/.o8/provider-instances.json` (mode 0600) holds only non-secret
 * fields and the thread → instance bindings. Env variables go through the
 * existing ACP environment store (`acp-environment.sqlite`): ordinary values
 * in its configuration row, secrets AES-encrypted with the o8 master key, keyed
 * by `instance:<id>`. Nothing here is written to settings.toml.
 *
 * Every runtime keeps an implicit default instance (id = runtime id, no
 * overrides). Classic's single Local ACP slot (`local-acp.json`) is presented
 * as the instance `acp` and is still read and written through
 * `local-connection.ts`, so classic keeps working and no data moves.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';
import { withProviderStoreLock } from './store-lock';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { acpEnvironmentId, readAcpEnvironment, resolveAcpEnvironment, saveAcpEnvironment, type AcpEnvironmentInventory } from '@/lib/acp/connection-environment';
import { parseLocalAcpConnection, readLocalAcpConnection, type LocalAcpConnection } from '@/lib/acp/local-connection';
import type { ActiveProviderInstance } from './instance-context';

/**
 * The variable each runtime reads for its home/config directory, from
 * runtime-profile-paths.ts and worker-environment.ts. ACP agents have none.
 */
export const HOME_SELECTORS: Readonly<Record<string, string>> = {
  codex: 'CODEX_HOME',
  'claude-code': 'CLAUDE_CONFIG_DIR',
  gemini: 'GEMINI_CLI_HOME',
  hermes: 'HERMES_HOME',
  openclaw: 'OPENCLAW_STATE_DIR',
  opencode: 'OPENCODE_CONFIG_DIR',
  pi: 'PI_CODING_AGENT_DIR',
  goose: 'GOOSE_PATH_ROOT',
  qwen: 'QWEN_CODE_HOME',
  kimi: 'KIMI_HOME',
  antigravity: 'ANTIGRAVITY_HOME',
  'copilot-cli': 'COPILOT_HOME',
};

export interface ProviderInstance {
  id: string;
  runtime: string;
  name: string;
  binaryPath?: string;
  homeDir?: string;
  enabled: boolean;
  /** ACP instances only: the agent command. */
  acp?: LocalAcpConnection;
  /** The default instance of its runtime (id = runtime id); never stored. */
  default?: boolean;
}

interface Store { version: 1; instances: ProviderInstance[]; threads: Record<string, string> }

const file = () => join(getDataDir(), 'provider-instances.json');
export const LOCAL_ACP_INSTANCE = 'acp';

export function knownRuntime(runtime: string): boolean {
  return runtime === 'acp' || Object.hasOwn(ORCHESTRATOR_RUNTIMES, runtime);
}

function readStore(): Store {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>;
    return { version: 1, instances: Array.isArray(raw.instances) ? raw.instances : [],
      threads: raw.threads && typeof raw.threads === 'object' ? raw.threads : {} };
  } catch { return { version: 1, instances: [], threads: {} }; }
}

function writeStore(store: Store): void {
  mkdirSync(getDataDir(), { recursive: true });
  const temp = `${file()}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 }); renameSync(temp, file()); }
  finally { rmSync(temp, { force: true }); }
}

/** The migrated Local ACP slot, when one is saved. */
function localAcpInstance(): ProviderInstance | null {
  const connection = readLocalAcpConnection();
  return connection ? { id: LOCAL_ACP_INSTANCE, runtime: 'acp', name: connection.name, enabled: true, acp: connection, default: true } : null;
}

/** Saved instances plus the Local ACP slot. Default runtime instances are implicit. */
export function listProviderInstances(): ProviderInstance[] {
  const acp = localAcpInstance();
  return [...(acp ? [acp] : []), ...readStore().instances];
}

export function readProviderInstance(id: string): ProviderInstance | null {
  return listProviderInstances().find(instance => instance.id === id) ?? null;
}

function text(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`${label} must be one line of at most ${max} characters.`);
  return value.trim() || undefined;
}
function path(value: unknown, label: string): string | undefined {
  const parsed = text(value, 1024, label);
  if (parsed && !isAbsolute(parsed) && !parsed.startsWith('~/')) throw new Error(`${label} must be an absolute path.`);
  return parsed;
}

/** Validate user fields. `runtime` and `id` never change after creation. */
export function parseInstanceFields(input: Record<string, unknown>, runtime: string): Pick<ProviderInstance, 'name' | 'binaryPath' | 'homeDir' | 'enabled' | 'acp'> {
  const name = text(input.name, 80, 'Name');
  if (!name) throw new Error('Enter a display name.');
  const homeDir = path(input.homeDir, 'Home directory');
  if (homeDir && !HOME_SELECTORS[runtime]) throw new Error('This runtime has no home directory setting.');
  const acp = runtime === 'acp' ? parseLocalAcpConnection({ ...(input.acp as object), name }) : undefined;
  return { name, binaryPath: runtime === 'acp' ? undefined : path(input.binaryPath, 'Binary path'), homeDir,
    enabled: input.enabled !== false, ...(acp ? { acp } : {}) };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'instance';
}

export function createProviderInstance(input: Record<string, unknown>): ProviderInstance {
  const runtime = typeof input.runtime === 'string' ? input.runtime : '';
  if (!knownRuntime(runtime)) throw new Error('Unknown runtime.');
  const fields = parseInstanceFields(input, runtime);
  return withProviderStoreLock(() => {
    const store = readStore();
    const taken = new Set([...store.instances.map(i => i.id), LOCAL_ACP_INSTANCE, ...Object.keys(ORCHESTRATOR_RUNTIMES)]);
    const base = `${runtime}-${slug(fields.name)}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const instance: ProviderInstance = { id, runtime, ...fields };
    store.instances.push(instance);
    writeStore(store);
    return instance;
  });
}

export function updateProviderInstance(id: string, input: Record<string, unknown>): ProviderInstance {
  if (id === LOCAL_ACP_INSTANCE) throw new Error('Edit the Local ACP slot through its connection form.');
  return withProviderStoreLock(() => {
    const store = readStore();
    const index = store.instances.findIndex(i => i.id === id);
    if (index < 0) throw new Error('That instance no longer exists.');
    const current = store.instances[index];
    const next: ProviderInstance = { ...current, ...parseInstanceFields({ ...current, ...input }, current.runtime) };
    // Env is keyed by instance id (`instance:<id>`), so a changed ACP command keeps its env.
    store.instances[index] = next;
    writeStore(store);
    return next;
  });
}

/** Deletes the instance, its env and secrets, and its thread bindings. */
export function deleteProviderInstance(id: string): boolean {
  if (id === LOCAL_ACP_INSTANCE || Object.hasOwn(ORCHESTRATOR_RUNTIMES, id)) throw new Error('Default instances cannot be deleted.');
  return withProviderStoreLock(() => {
    const store = readStore();
    if (!store.instances.some(i => i.id === id)) return false;
    const environment = readAcpEnvironment(instanceEnvironmentId(id));
    const commit = () => {
      store.instances = store.instances.filter(i => i.id !== id);
      for (const [thread, bound] of Object.entries(store.threads)) if (bound === id) delete store.threads[thread];
      writeStore(store);
    };
    if (environment.revision > 0) saveAcpEnvironment(environment, [], commit);
    else commit();
    return true;
  });
}

export function instanceEnvironmentId(id: string): string {
  if (id === LOCAL_ACP_INSTANCE) {
    const connection = readLocalAcpConnection();
    if (!connection) throw new Error('Save a Local ACP connection first.');
    return acpEnvironmentId(connection);
  }
  return `instance:${id}`;
}

export function readInstanceEnvironment(id: string): AcpEnvironmentInventory {
  return readAcpEnvironment(instanceEnvironmentId(id));
}

/** Same validation and encryption as the Local ACP env editor. */
export function saveInstanceEnvironment(id: string, revision: number, variables: unknown): AcpEnvironmentInventory {
  if (!readProviderInstance(id)) throw new Error('That instance no longer exists.');
  return saveAcpEnvironment({ connectionId: instanceEnvironmentId(id), revision }, variables);
}

export function threadProviderInstance(threadId: string | null | undefined): string | null {
  return threadId ? readStore().threads[threadId] ?? null : null;
}

/** Bind a thread to an instance, or clear it with `null` (the default instance). */
export function bindThreadProviderInstance(threadId: string, instanceId: string | null): void {
  if (!/^[\w:.-]{1,200}$/.test(threadId)) throw new Error('Invalid thread id.');
  withProviderStoreLock(() => {
    const store = readStore();
    if (instanceId && !store.instances.some(i => i.id === instanceId) && instanceId !== LOCAL_ACP_INSTANCE) throw new Error('That instance no longer exists.');
    if (instanceId && instanceId !== LOCAL_ACP_INSTANCE) store.threads[threadId] = instanceId;
    else delete store.threads[threadId];
    writeStore(store);
  });
}

function expandHome(value: string): string {
  return value.startsWith('~/') ? join(process.env.HOME || '', value.slice(2)) : value;
}

/**
 * The launch context for a turn: null for the default instance, so default
 * sessions behave exactly as before. Throws when the bound instance is gone
 * or disabled, rather than silently running on another account.
 */
export function resolveProviderInstanceLaunch(threadId: string | null | undefined, runtime: string): ActiveProviderInstance | null {
  const id = threadProviderInstance(threadId);
  if (!id) return null;
  const instance = readProviderInstance(id);
  if (!instance) throw new Error('This chat\'s provider instance was deleted. Pick another runtime to continue.');
  if (instance.runtime !== runtime) return null;
  if (!instance.enabled) throw new Error(`${instance.name} is turned off in Settings › Providers.`);
  const environmentId = instanceEnvironmentId(instance.id);
  const { env, localEnvironment } = resolveAcpEnvironment(environmentId);
  const selector = HOME_SELECTORS[instance.runtime];
  return {
    id: instance.id, runtime: instance.runtime,
    ...(instance.binaryPath ? { binaryPath: expandHome(instance.binaryPath) } : {}),
    home: selector && instance.homeDir ? { [selector]: expandHome(instance.homeDir) } : {},
    env, ...(instance.acp ? { acp: instance.acp, localEnvironment } : {}),
  };
}
