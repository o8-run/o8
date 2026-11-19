import { composerOwnerRequest, type ComposerOwnerTransport } from '@/lib/orchestrator/composer-owner-client';
import { ComposerOwnerUnknownOutcome, ComposerOwnerUnavailable } from './composer-owner-rpc';

/** The owner may have committed. Do not settle, defer, or dispatch on uncertainty. */
export class ComposerAttemptUncertain extends Error {
  constructor() { super('Composer admission is unconfirmed. Inspect the chat before sending again.'); this.name = 'ComposerAttemptUncertain'; }
}

/** Private attempt fence, never exposed on a public queue item or provider wire. */
export class ComposerExecutorAttempt {
  admitted = false;
  constructor(readonly id: string, private readonly claimToken: string,
    private readonly request: ComposerOwnerTransport = composerOwnerRequest) {}

  async assertLive(): Promise<void> {
    let live: boolean;
    try { live = (await this.request('assertClaim', { id: this.id, claimToken: this.claimToken })).live; }
    catch (error) {
      // This read cannot have admitted a turn; normal exact-attempt defer is safe.
      if (error instanceof ComposerOwnerUnknownOutcome) throw new ComposerOwnerUnavailable();
      throw error;
    }
    if (!live) throw new Error('The queued message was cancelled or held before execution.');
  }
  private async reconcile() {
    try {
      const result = await this.request('get', { id: this.id, claimToken: this.claimToken });
      if (!result.attempt || (result.item && result.item.id !== this.id) || (result.attempt.tokenMatches && result.item?.status !== 'dispatching')) throw new ComposerAttemptUncertain();
      return result;
    }
    catch { throw new ComposerAttemptUncertain(); }
  }
  async admit(): Promise<boolean> {
    try {
      const changed = (await this.request('admit', { id: this.id, claimToken: this.claimToken })).changed;
      if (changed) this.admitted = true;
      return changed;
    }
    catch (error) {
      if (!(error instanceof ComposerOwnerUnknownOutcome)) throw error;
      const state = await this.reconcile();
      if (!state.attempt?.tokenMatches) return false;
      if (state.attempt.admitted) { this.admitted = true; return true; }
      try {
        const changed = (await this.request('admit', { id: this.id, claimToken: this.claimToken })).changed;
        if (changed) { this.admitted = true; return true; }
        // The original admit may have committed after the non-admitted read.
        const raced = await this.reconcile();
        if (raced.attempt?.tokenMatches && raced.attempt.admitted) { this.admitted = true; return true; }
        return false;
      }
      catch (retryError) {
        if (!(retryError instanceof ComposerOwnerUnknownOutcome)) throw retryError;
        const retried = await this.reconcile();
        if (!retried.attempt?.tokenMatches) return false;
        if (retried.attempt.admitted) { this.admitted = true; return true; }
        throw new ComposerAttemptUncertain();
      }
    }
  }
  async settle(status: 'applied' | 'held', reason?: string): Promise<boolean> {
    try { return (await this.request('settle', { id: this.id, claimToken: this.claimToken, status, ...(reason ? { reason } : {}) })).changed; }
    catch (error) {
      if (!(error instanceof ComposerOwnerUnknownOutcome)) throw error;
      const state = await this.reconcile();
      // A settled row has invalidated the token. A newer attempt is never touched.
      if (!state.attempt?.tokenMatches) return false;
      throw new ComposerAttemptUncertain();
    }
  }
  async defer(reason: string): Promise<boolean> {
    return (await this.request('deferSteer', { id: this.id, claimToken: this.claimToken, reason })).changed;
  }
}
