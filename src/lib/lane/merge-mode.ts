export type LaneMergeMode = 'direct' | 'pr_only';

export interface LaneMergePolicy {
  mode: LaneMergeMode;
  note: string | null;
}

export const DOGFOOD_PR_ONLY_NOTE =
  'PR-only dogfood mode is active — merge to main is blocked. Open a PR; a human merges.';
