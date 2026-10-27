/** Identity and recall epoch carried by flattened memory fragments. Never stores forgotten text. */
export interface OutcomeMemoryProvenance {
  /** Exact ledger identity; provider exit and transcript timestamps can differ. */
  sourceOutcomeId?: string;
  sourceOutcomeFingerprint?: string;
  /** Recall revision when correction-derived fragments were assembled. */
  memoryRevision?: string;
}
