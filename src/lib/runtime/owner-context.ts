import { AsyncLocalStorage } from 'node:async_hooks';
import { getWsBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const owner = new AsyncLocalStorage<boolean>();
const stdioTool = new AsyncLocalStorage<boolean>();

export class RuntimeOwnerUnconfirmedError extends Error {
  readonly code = 'outcome_unknown';
  constructor() { super('Runtime owner could not be confirmed. Inspect the server before retrying.'); }
}

/** Keep discovery inside the tool handler's existing error boundary. */
export function withStdioRuntimeOwner<T>(run: () => Promise<T>): Promise<T> {
  return stdioTool.run(true, run);
}
export function withToolRuntimeOwner<T>(run: () => Promise<T>): Promise<T> {
  return stdioTool.getStore() === true ? withLiveRuntimeOwner(run) : run();
}
export function runtimeOwnerRequired(): boolean {
  return process.env.O8_NEXT_O8D === '1' || owner.getStore() === true;
}
export function runtimeOwnerOrigin(): string { return getWsBase().replace(/^ws:/, 'http:'); }
export function operatorSteerOrigin(): string | undefined {
  return owner.getStore() === true ? runtimeOwnerOrigin() : undefined;
}

/** Discover the running owner without weakening an explicit native requirement. */
export async function withLiveRuntimeOwner<T>(run: () => Promise<T>): Promise<T> {
  const absentOwner = () => {
    if (process.env.O8_NEXT_O8D === '1') {
      throw new RuntimeOwnerUnconfirmedError();
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
    throw new RuntimeOwnerUnconfirmedError();
  }
  if (response.status === 404) return absentOwner();
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.schema !== 'o8/runtime-owner/v1' || body.owner !== 'ws' || !Number.isInteger(body.pid)) {
    throw new RuntimeOwnerUnconfirmedError();
  }
  return owner.run(true, run);
}
