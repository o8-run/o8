import { normalizeRequestedRuntime } from '@/lib/agents/routing';
import { readProviderInstance, resolveProviderInstanceLaunch, type ProviderInstance } from '@/lib/providers/instances';
import { runWithProviderInstance } from '@/lib/providers/instance-context';

/** Explicit pins never fall back to the default provider instance. */
export function delegationInstance(body: Record<string, unknown>): ProviderInstance | null {
  if (body.instanceId === undefined) return null;
  if (typeof body.instanceId !== 'string' || !body.instanceId.trim()) throw new Error('instanceId must be a non-empty provider instance id.');
  const instance = readProviderInstance(body.instanceId.trim());
  if (!instance) throw new Error('Unknown provider instance id. Choose an existing instance; no worker was started.');
  if (!instance.enabled) throw new Error('This provider instance is disabled; no worker was started.');
  if (body.runtime != null && body.runtime !== '' && normalizeRequestedRuntime(body.runtime) !== instance.runtime) {
    throw new Error('The provider instance does not match the requested runtime; no worker was started.');
  }
  return instance;
}

export function withDelegationInstance<T>(instance: ProviderInstance | null, operation: () => T): T {
  if (!instance) return operation();
  const configuration = resolveProviderInstanceLaunch(null, instance.runtime, instance.id);
  return runWithProviderInstance(configuration, operation);
}
