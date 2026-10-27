/** Shared public state used by the broker and its UI consumers. */
export class GitHubOrgNotCoveredError extends Error {
  readonly code = 'github_org_not_covered';
  constructor() { super("GitHub sign-in doesn't cover organization repos yet"); this.name = 'GitHubOrgNotCoveredError'; }
}
export function assertGitHubOrgCoverage(data: unknown): void {
  if (data && typeof data === 'object' && 'code' in data && data.code === 'github_org_not_covered') throw new GitHubOrgNotCoveredError();
}
