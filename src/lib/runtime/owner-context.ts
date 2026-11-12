import { AsyncLocalStorage } from 'node:async_hooks';
import { getWsBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const owner = new AsyncLocalStorage<boolean>();
export function runtimeOwnerRequired(): boolean {
  return process.env.O8_NEXT_O8D === '1' || owner.getStore() === true;
}
export function runtimeOwnerOrigin(): string { return getWsBase().replace(/^ws:/, 'http:'); }
export function operatorSteerOrigin(): string | undefined {
  return owner.getStore() === true ? runtimeOwnerOrigin() : undefined;
}

/** Stdio has no inherited app flag. Resolve the running owner per tool request. */
export async function withLiveRuntimeOwner<T>(run: () => Promise<T>): Promise<T> {
  const absentOwner = () => {
    if (process.env.O8_NEXT_O8D === '1') {
      throw new Error('Runtime owner could not be confirmed. Inspect the server before retrying.');
    }
    return owner.run(false, run);
  };
  let response: Response;
  try {
    response = await fetch(`${runtimeOwnerOrigin()}/api/runtime/owner`, {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
      signal: AbortSignal.timeout(2000), cache: 'no-store', redirect: 'error',
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    if (cause === 'ECONNREFUSED') return absentOwner();
    throw new Error('Runtime owner could not be confirmed. Inspect the server before retrying.');
  }
  if (response.status === 404) return absentOwner();
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.schema !== 'o8/runtime-owner/v1' || body.owner !== 'ws' || !Number.isInteger(body.pid)) {
    throw new Error('Runtime owner could not be confirmed. Inspect the server before retrying.');
  }
  return owner.run(true, run);
}
