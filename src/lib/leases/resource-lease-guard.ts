import 'server-only';

import type { ResourceLeaseStore } from './resource-lease-service';
import {
  withResourceLeaseStore,
  type ResourceLeaseGuardInput,
  type ResourceLeaseGuardResult,
} from './resource-lease-guard-core';

export * from './resource-lease-guard-core';

/** Server callers may omit the store; it then defaults to the application database's. */
export async function withResourceLease<T>(
  input: Omit<ResourceLeaseGuardInput, 'store'> & { store?: ResourceLeaseStore },
  action: () => Promise<T>,
): Promise<ResourceLeaseGuardResult<T>> {
  const store = input.store ?? (await import('./resource-lease-default-store')).getResourceLeaseStore();
  return withResourceLeaseStore({ ...input, store }, action);
}
