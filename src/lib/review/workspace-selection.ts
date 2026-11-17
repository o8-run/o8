/** The route and private admission share the same live environment predicate. */
export function isReviewWorkspaceUnselected(workspace: string | null) {
  return !workspace && !process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
}
