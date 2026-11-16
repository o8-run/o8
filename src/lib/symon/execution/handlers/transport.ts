import { setTimeout as delay } from 'node:timers/promises';
import { getApiBase, resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export type Args = Readonly<Record<string, unknown>>;
export type Json = Record<string, unknown>;
export const str = (a: Args, k: string, fallback = ''): string => typeof a[k] === 'string' ? a[k] as string : fallback;
export const trim = (a: Args, k: string): string => str(a, k).trim();
export const rows = (a: Json, k: string): Json[] => Array.isArray(a[k]) ? a[k] as Json[] : [];
export function required(a: Args, k: string): string {
  const value = trim(a, k);
  if (!value) throw new Error(`${k} is required`);
  return value;
}
export const pause = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal });

/** Same bearer and routes as the classic bridge. Resolve lazily: importing is inert. */
export async function request(path: string, signal: AbortSignal, body?: Json, host = false, correlated = false): Promise<Json> {
  const base = host ? `http://127.0.0.1:${resolvePortInfo().wsPort}` : getApiBase();
  const deadline = Date.now() + 300_000;
  for (;;) {
    signal.throwIfAborted();
    let payload: Json;
    let status: number;
    try {
      const response = await fetch(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(path === '/api/cortex/ask/answer' ? 90_000 : 20_000)]),
        redirect: 'error',
      });
      status = response.status;
      if (!response.ok) throw new HttpRefusal(`o8 ${path} error (${status})`);
      payload = await response.json() as Json;
    } catch (error) {
      signal.throwIfAborted();
      if (!correlated || error instanceof HttpRefusal || Date.now() >= deadline) throw error;
      await pause(750, signal);
      continue;
    }
    const receipt = (payload.result ?? payload) as Json;
    if (!correlated || !(status === 202 || receipt.inProgress === true || receipt.status === 'in_progress')) return payload;
    if (Date.now() >= deadline) throw new Error(`o8 ${path} is still running after 300s; reuse the same mutation id`);
    await pause(750, signal);
  }
}
class HttpRefusal extends Error {}
