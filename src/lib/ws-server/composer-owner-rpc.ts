import { randomUUID } from 'node:crypto';
import type { ComposerQueueTarget, ComposerQueueStatus, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';

export const COMPOSER_RPC_FRAME_LIMIT = 100 * 1024 * 1024;
export const COMPOSER_RPC_PENDING_LIMIT = 32;
export const COMPOSER_RPC_TIMEOUT_MS = 5_000;
export interface ComposerWsIngress { kind: 'ws'; clientMutationId: string; wireJson: string }
export interface ComposerClaim { item: QueuedComposerSendRecord | null; claimToken: string | null; ingress?: ComposerWsIngress }
export interface ComposerAttempt { tokenMatches: boolean; admitted: boolean }
type Fence = { id: string; claimToken: string };
export interface ComposerOwnerParams {
  enqueue: { id: string; target: ComposerQueueTarget; intent: 'send-next' | 'steer-now'; payloadJson: string; ingress?: ComposerWsIngress };
  claim: { target: ComposerQueueTarget; intent: 'send-next' } | { id: string; intent: 'steer-now' | 'ingress' };
  promote: { target: ComposerQueueTarget; id: string };
  deferSteer: Fence & { reason: string };
  admit: Fence;
  settle: Fence & { status: Extract<ComposerQueueStatus, 'applied' | 'held'>; reason?: string };
  assertClaim: Fence;
  hold: { target: ComposerQueueTarget };
  cancel: { target: ComposerQueueTarget; id: string };
  get: { id: string; claimToken?: string };
  list: { target?: ComposerQueueTarget; withoutImages?: boolean };
  listTargets: Record<string, never>;
  listTranscript: { target: ComposerQueueTarget };
}
export interface ComposerOwnerResults {
  enqueue: { item: QueuedComposerSendRecord; disposition: 'created' | 'existing' };
  claim: ComposerClaim;
  promote: { item: QueuedComposerSendRecord };
  deferSteer: { changed: boolean }; admit: { changed: boolean }; settle: { changed: boolean };
  assertClaim: { live: boolean }; hold: { changed: boolean }; cancel: { changed: boolean };
  get: { item: QueuedComposerSendRecord | null; attempt?: ComposerAttempt };
  list: { items: QueuedComposerSendRecord[] }; listTargets: { targets: ComposerQueueTarget[] };
  listTranscript: { items: QueuedComposerSendRecord[] };
}
export type ComposerOwnerMethod = keyof ComposerOwnerParams;
const CODES = new Set(['invalid', 'conflict', 'limit', 'not_found', 'not_claimable', 'stale_epoch', 'unavailable']);
export class ComposerOwnerReplyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ComposerOwnerReplyError'; }
}
/** The call was never sent; no native mutation is implied. */
export class ComposerOwnerUnavailable extends ComposerOwnerReplyError {
  constructor(message = 'The composer owner is unavailable.') { super('unavailable', message); this.name = 'ComposerOwnerUnavailable'; }
}
/** A sent mutation may have committed. Reconcile its exact item and attempt. */
export class ComposerOwnerUnknownOutcome extends Error {
  constructor(public readonly method: ComposerOwnerMethod, public readonly requestId: string) {
    super('The composer owner reply was lost. Inspect this attempt before continuing.'); this.name = 'ComposerOwnerUnknownOutcome';
  }
}
interface Pending {
  epoch: string; method: ComposerOwnerMethod; timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void; reject(error: Error): void;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Reject malformed owner receipts before a truthy value can cross an admission fence. */
export function validComposerOwnerResult(method: ComposerOwnerMethod, value: unknown): boolean {
  if (!record(value)) return false;
  const item = (v: unknown) => record(v) && typeof v.id === 'string' && typeof v.repoPath === 'string'
    && typeof v.threadId === 'string' && typeof v.status === 'string' && record(v.payload);
  switch (method) {
    case 'admit': case 'settle': case 'deferSteer': case 'hold': case 'cancel': return typeof value.changed === 'boolean';
    case 'assertClaim': return typeof value.live === 'boolean';
    case 'enqueue': return item(value.item) && ['created', 'existing'].includes(String(value.disposition));
    case 'promote': return item(value.item);
    case 'claim': return (value.item === null && value.claimToken === null)
      || (item(value.item) && typeof value.claimToken === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.claimToken)
        && (value.ingress === undefined || (record(value.ingress) && value.ingress.kind === 'ws'
          && typeof value.ingress.clientMutationId === 'string' && typeof value.ingress.wireJson === 'string')));
    case 'get': return (value.item === null || item(value.item)) && (value.attempt === undefined
      || (record(value.attempt) && typeof value.attempt.tokenMatches === 'boolean' && typeof value.attempt.admitted === 'boolean'));
    case 'list': case 'listTranscript': return Array.isArray(value.items) && value.items.every(item);
    case 'listTargets': return Array.isArray(value.targets) && value.targets.every(target => record(target)
      && typeof target.repoPath === 'string' && typeof target.threadId === 'string');
  }
}

/** Correlation only: no retry, recovery, SQL or provider dispatch lives here. */
export class ComposerOwnerRequests {
  private epoch: string | null = null;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly send: (frame: string) => void) {}
  attach(epoch: string | null): void {
    if (this.epoch !== epoch) this.disconnect();
    this.epoch = epoch;
  }
  disconnect(): void {
    this.epoch = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer); pending.reject(new ComposerOwnerUnknownOutcome(pending.method, id));
    }
    this.pending.clear();
  }
  request<M extends ComposerOwnerMethod>(method: M, params: ComposerOwnerParams[M]): Promise<ComposerOwnerResults[M]> {
    if (!this.epoch) return Promise.reject(new ComposerOwnerUnavailable());
    if (this.pending.size >= COMPOSER_RPC_PENDING_LIMIT) return Promise.reject(new ComposerOwnerUnavailable('The composer owner request limit was reached.'));
    const epoch = this.epoch, requestId = randomUUID();
    let frame: string;
    try { frame = JSON.stringify({ v: 1, kind: 'composer-queue-request', epoch, requestId, method, params }) + '\n'; }
    catch { return Promise.reject(new ComposerOwnerReplyError('invalid', 'The composer owner request could not be encoded.')); }
    if (Buffer.byteLength(frame) > COMPOSER_RPC_FRAME_LIMIT) return Promise.reject(new ComposerOwnerReplyError('limit', 'The composer owner request exceeds its frame limit.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId); reject(new ComposerOwnerUnknownOutcome(method, requestId));
      }, COMPOSER_RPC_TIMEOUT_MS);
      this.pending.set(requestId, { epoch, method, timer, resolve: value => resolve(value as ComposerOwnerResults[M]), reject });
      try { this.send(frame); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(error instanceof ComposerOwnerUnavailable ? error : new ComposerOwnerUnknownOutcome(method, requestId));
      }
    });
  }
  receive(value: unknown): boolean {
    if (!record(value) || value.kind !== 'composer-queue-response') return false;
    if (value.v !== 1 || typeof value.epoch !== 'string' || typeof value.requestId !== 'string' || value.requestId.length > 128
      || typeof value.ok !== 'boolean') throw Error('Invalid composer owner response');
    const pending = this.pending.get(value.requestId);
    // A timed-out request must not resurrect an executor or complete another call.
    if (!pending) return true;
    if (value.epoch !== pending.epoch) throw Error('Stale composer owner response');
    if (!value.ok && (!record(value.error) || typeof value.error.code !== 'string' || !CODES.has(value.error.code)
      || typeof value.error.message !== 'string' || value.error.message.length > 4096)) throw Error('Invalid composer owner error');
    if (value.ok && !validComposerOwnerResult(pending.method, value.result)) throw Error('Invalid composer owner result');
    clearTimeout(pending.timer); this.pending.delete(value.requestId);
    if (value.ok) pending.resolve(value.result);
    else { const error = value.error as { code: string; message: string }; pending.reject(new ComposerOwnerReplyError(error.code, error.message)); }
    return true;
  }
}
