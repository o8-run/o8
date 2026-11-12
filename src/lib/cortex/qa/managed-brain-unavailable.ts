import type { Citation } from './types';

export const MANAGED_BRAIN_UNAVAILABLE_MESSAGE = 'Managed Brain inference is unavailable or its allowance is reached. Select Subscription in Brain settings to use a connected CLI.';

/** A managed-only request failed. Callers must surface it and never cache it. */
export class ManagedBrainUnavailableError extends Error {
  readonly code = 'managed_brain_unavailable';

  constructor(readonly citations: Citation[] = [], readonly sourcesConsidered = 0) {
    super(MANAGED_BRAIN_UNAVAILABLE_MESSAGE);
    this.name = 'ManagedBrainUnavailableError';
  }
}

