import { storeSet } from '@/lib/tauri/bridge';
import {
  fetchOperatorDefaultsValues,
  invalidateOperatorDefaultsValuesSnapshot,
} from '@/lib/operator/operator-defaults-values-client';

const OPERATOR_DEFAULTS_URL = '/api/panel/operator-defaults';
const SNAPSHOT_TTL_MS = 1_000;

let snapshot: { response: Response; expiresAt: number } | null = null;
let inFlight: Promise<Response> | null = null;
let version = 0;

async function syncTauriStore(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const payload = await response.clone().json().catch(() => null) as { values?: unknown } | null;
  if (payload?.values !== undefined) {
    await storeSet('operatorDefaults', payload.values);
  }
  return response;
}

export function invalidateOperatorDefaultsSnapshot(): void {
  version += 1;
  snapshot = null;
  inFlight = null;
  invalidateOperatorDefaultsValuesSnapshot();
}

export async function fetchOperatorDefaults(
  init: RequestInit = {},
  options: { fresh?: boolean; includeRuntime?: boolean } = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    invalidateOperatorDefaultsSnapshot();
    return fetch(OPERATOR_DEFAULTS_URL, init).then(syncTauriStore);
  }
  if (options.fresh) invalidateOperatorDefaultsSnapshot();
  if (options.includeRuntime === false) {
    return fetchOperatorDefaultsValues().then(syncTauriStore);
  }
  if (snapshot && snapshot.expiresAt > Date.now()) return snapshot.response.clone();
  if (!inFlight) {
    const requestVersion = version;
    const request = fetch(OPERATOR_DEFAULTS_URL, { ...init, cache: 'no-store' }).then(async (response) => {
      if (version === requestVersion) await syncTauriStore(response);
      if (response.ok && version === requestVersion) {
        snapshot = { response: response.clone(), expiresAt: Date.now() + SNAPSHOT_TTL_MS };
      }
      return response;
    });
    inFlight = request;
    request.then(
      () => { if (inFlight === request) inFlight = null; },
      () => { if (inFlight === request) inFlight = null; },
    );
  }
  return inFlight.then((response) => response.clone());
}
