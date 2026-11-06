export interface StableReleaseEffects {
  /** The GitHub release body: next.md at the release ref, or the generated summary when it is empty. */
  prepareNotes(): string;
}

export function stableReleaseEffects(input: {
  root: string;
  version: string;
  tag: string;
  range?: string;
  notesRef?: string;
}): StableReleaseEffects;
