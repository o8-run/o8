import type { DeviceControllerRoster } from './types';

export interface ControllerSnapshot { revision: number; controllers: DeviceControllerRoster[] }
type Listener = (snapshot: ControllerSnapshot) => void;
const shared = globalThis as typeof globalThis & { __o8DeviceControllerListeners?: Map<string, Set<Listener>> };
const listeners = shared.__o8DeviceControllerListeners ??= new Map();

export function subscribeControllers(root: string, listener: Listener): () => void {
  const entries = listeners.get(root) ?? new Set();
  listeners.set(root, entries); entries.add(listener);
  return () => { entries.delete(listener); if (!entries.size) listeners.delete(root); };
}

export function publishControllers(root: string, snapshot: ControllerSnapshot): void {
  for (const listener of listeners.get(root) ?? []) {
    try { listener(snapshot); } catch { /* A closed panel cannot interrupt authority. */ }
  }
}
