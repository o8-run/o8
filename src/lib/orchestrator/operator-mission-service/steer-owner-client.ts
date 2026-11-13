import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getWsBase } from '@/lib/panel/api-port';
import { ControlPlaneLockTimeoutError } from '@/lib/orchestrator/control-plane';
import { SteerPacketUnavailableError, type SteerPacketInput } from './steer';
import type { correctWorkers } from '@/lib/orchestrator/worker-corrections';
import type { correctAuthorFromReview } from '@/lib/orchestrator/review-author-correction';

type Operation = { kind: 'steer'; input: SteerPacketInput } | { kind: 'deliver'; eventId: string }
  | { kind: 'correct'; input: Parameters<typeof correctWorkers>[0] }
  | { kind: 'review-correct'; input: Parameters<typeof correctAuthorFromReview>[0] };
/** Whole operations cross this boundary; caller closures and held locks never do. */
export async function callSteerOwner<T>(operation: Operation): Promise<T> {
  let response: Response;
  let body;
  try {
    response = await fetch(`${getWsBase().replace(/^ws:/, 'http:')}/api/orchestrator/steer-owner`, {
      method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(operation), cache: 'no-store', redirect: 'error',
    });
    body = await response.json();
  } catch {
    throw new SteerPacketUnavailableError('Steer result is unconfirmed. Inspect the worker before retrying.', 'outcome_unknown');
  }
  if (!response.ok) {
    if (body?.errorClass === 'SteerPacketUnavailableError'
      && ['pre_effect', 'terminal', 'outcome_unknown'].includes(body.phase)) {
      throw new SteerPacketUnavailableError(body.error, body.phase);
    }
    const error = body?.errorClass === 'ControlPlaneLockTimeoutError'
      ? new ControlPlaneLockTimeoutError(body.waitTimeoutMs ?? 0) : new Error(body?.error || 'Steer owner refused the operation.');
    if (typeof body?.code === 'string') Object.assign(error, { code: body.code });
    throw error;
  }
  if (body?.ok !== true || !body.result || typeof body.result !== 'object') {
    throw new SteerPacketUnavailableError('Steer receipt is unconfirmed. Inspect the worker before retrying.', 'outcome_unknown');
  }
  return body.result as T;
}
