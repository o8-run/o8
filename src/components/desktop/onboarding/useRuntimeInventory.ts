'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';

interface InventoryState {
  inventory: SetupRuntime[] | null;
  /** Settings › Providers `disabledRuntimes`: hidden from new-session pickers. */
  disabled: string[];
  loading: boolean;
  error: string | null;
  expires: number;
}
const EMPTY: InventoryState = { inventory: null, disabled: [], loading: false, error: null, expires: 0 };
let snapshot = EMPTY;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const readSnapshot = () => snapshot;
const readServerSnapshot = () => EMPTY;
function publish(next: InventoryState) { snapshot = next; listeners.forEach((listener) => listener()); }

export function invalidateRuntimeInventory() { publish(EMPTY); }

async function loadInventory(refresh = false): Promise<void> {
  if (pending) return pending;
  if (!refresh && snapshot.inventory && snapshot.expires > Date.now()) return;
  publish({ ...snapshot, loading: true, error: null });
  const request = fetch(`/api/panel/operator-defaults${refresh ? '?refresh=runtime' : ''}`, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('Could not check installed tools. Retry the scan.');
      const payload = await response.json() as { dispatchableRuntimes?: SetupRuntime[]; values?: { disabledRuntimes?: unknown } };
      if (!Array.isArray(payload.dispatchableRuntimes)) throw new Error('Runtime inventory is unavailable.');
      const disabled = Array.isArray(payload.values?.disabledRuntimes) ? payload.values.disabledRuntimes.filter((id): id is string => typeof id === 'string') : [];
      publish({ inventory: payload.dispatchableRuntimes, disabled, expires: Date.now() + 60_000, loading: false, error: null });
    }).catch((cause: unknown) => {
      publish({ ...EMPTY, error: cause instanceof Error ? cause.message : 'Runtime scan failed.' });
    });
  pending = request;
  try { await request; } finally { if (pending === request) pending = null; }
}

export function useRuntimeInventory(enabled = true) {
  const state = useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot);
  useEffect(() => { if (enabled) void loadInventory(); }, [enabled]);
  const refresh = useCallback(() => { void loadInventory(true); }, []);
  return { ...state, refresh };
}
