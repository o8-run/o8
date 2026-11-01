import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The provider instance a turn runs on, resolved once when the turn starts
 * (`runWithProviderInstance`). Spawns made during that turn read it at the
 * single environment chokepoint (`childEnvironment`) and in `resolveCli`.
 * Holds the already-decrypted env, so this leaf never touches storage.
 */
export interface ActiveProviderInstance {
  id: string;
  /** Runtime id (`codex`, `claude-code`, `acp`, …), never a backend id. */
  runtime: string;
  binaryPath?: string;
  /** Selector variable to value, e.g. `{ CODEX_HOME: '/home/me/.codex-work' }`. */
  home: Record<string, string>;
  env: Record<string, string>;
  /** Provider API keys saved on this instance; they replace the shared keys for its sessions. */
  credentials?: Record<string, string>;
  acp?: { name: string; command: string; args: string[]; useOpenRouter: boolean };
  localEnvironment?: { connectionId: string; revision: number };
}

const storage = new AsyncLocalStorage<ActiveProviderInstance | null>();

export function runWithProviderInstance<T>(instance: ActiveProviderInstance | null, operation: () => T): T {
  return storage.run(instance, operation);
}

export function activeProviderInstance(runtimeId?: string): ActiveProviderInstance | null {
  const active = storage.getStore() ?? null;
  return active && (!runtimeId || active.runtime === runtimeId) ? active : null;
}

/** Variables a runtime spawn gains from the active instance; `{}` for the default instance. */
export function providerInstanceEnvironment(runtimeId: string | undefined): Record<string, string> {
  const active = runtimeId && runtimeId !== 'acp' ? activeProviderInstance(runtimeId) : null;
  return active ? { ...active.env, ...active.home } : {};
}

/** Provider API keys an instance sets; applied after the credential policy. */
export function providerInstanceCredentials(runtimeId: string | undefined): Record<string, string> {
  const active = runtimeId && runtimeId !== 'acp' ? activeProviderInstance(runtimeId) : null;
  return active?.credentials ?? {};
}
