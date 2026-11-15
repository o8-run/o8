// One line appended to every GitHub release body so readers know where
// the next release is announced.
export const RELEASE_FOLLOW_LINE =
  'Release notes and dev clips post first on X: follow [@o8dotrun](https://x.com/o8dotrun).';

export function withReleaseFollowLine(notes) {
  return `${notes}\n\n${RELEASE_FOLLOW_LINE}`;
}
