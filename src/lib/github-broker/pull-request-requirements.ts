import 'server-only';

import { githubInstallationFetch } from './auth';
import { GitHubReadScopeChangedError } from './read-scope';
import { GitHubRequestDeferredError } from './request-budget';

export interface PullRequestRequirements {
  /** Check-run names GitHub requires on this head; null when GitHub did not say. */
  requiredChecks: string[] | null;
  /** Required commit statuses on this head with their state, which the check-run read does not include. */
  requiredStatuses: Array<{ context: string; state: string }>;
  /** True when the base branch merges through a merge queue; null when unknown. */
  mergeQueue: boolean | null;
  inMergeQueue: boolean;
}

export const UNKNOWN_REQUIREMENTS: PullRequestRequirements = { requiredChecks: null, requiredStatuses: [], mergeQueue: null, inMergeQueue: false };

const QUERY = `query PullRequestRequirements($owner: String!, $name: String!, $number: Int!, $base: String!, $head: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $base) { id }
    pullRequest(number: $number) { isInMergeQueue }
    object(oid: $head) { ... on Commit { statusCheckRollup { contexts(first: 100) {
      pageInfo { hasNextPage }
      nodes {
        __typename
        ... on CheckRun { name isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
      }
    } } } }
  }
}`;

type Context = { __typename?: string; name?: string; context?: string; state?: string; isRequired?: boolean } | null;
type Payload = { errors?: unknown[]; data?: { repository?: {
  mergeQueue?: { id?: string } | null;
  pullRequest?: { isInMergeQueue?: boolean } | null;
  object?: { statusCheckRollup?: { contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: Context[] } } | null } | null;
} | null } };

/**
 * Which checks GitHub itself requires before this head can merge, and whether
 * the base branch uses a merge queue. Optional checks, such as advisory scanners,
 * must not hold a merge that GitHub would accept. The read is bound to the head
 * the caller already holds. Any failure answers "unknown", and the merge gate then
 * treats every check run as required.
 */
export async function readPullRequestRequirements(repo: string, number: number, base: string, head: string, authorizedScope?: string): Promise<PullRequestRequirements> {
  const [owner, name] = repo.split('/');
  if (!owner || !name || !base || !head) return UNKNOWN_REQUIREMENTS;
  try {
    const { response, scope, anonymous } = await githubInstallationFetch(repo, '/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(18_000),
      body: JSON.stringify({ query: QUERY, variables: { owner, name, number, base, head } }),
    });
    if (authorizedScope && scope !== authorizedScope) {
      void response.body?.cancel().catch(() => {});
      throw new GitHubReadScopeChangedError('GitHub authorization changed while reading merge requirements. Retry.', anonymous);
    }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return UNKNOWN_REQUIREMENTS; }
    const payload = await response.json() as Payload;
    const repository = payload.data?.repository;
    const contexts = repository?.object?.statusCheckRollup?.contexts;
    // No rollup yet means GitHub has not named any requirement; that is unknown, not "none".
    if (payload.errors?.length || !repository?.pullRequest || !contexts || !Array.isArray(contexts.nodes) || contexts.pageInfo?.hasNextPage) return UNKNOWN_REQUIREMENTS;
    const required = contexts.nodes.filter((node): node is NonNullable<Context> => Boolean(node?.isRequired));
    return {
      requiredChecks: [...new Set(required.flatMap(node => node.__typename === 'CheckRun' && node.name ? [node.name] : []))].sort(),
      requiredStatuses: required.flatMap(node => node.__typename === 'StatusContext' && node.context ? [{ context: node.context, state: node.state ?? 'PENDING' }] : []),
      mergeQueue: Boolean(repository.mergeQueue?.id), inMergeQueue: Boolean(repository.pullRequest.isInMergeQueue),
    };
  } catch (error) {
    if (error instanceof GitHubReadScopeChangedError || error instanceof GitHubRequestDeferredError) throw error;
    return UNKNOWN_REQUIREMENTS;
  }
}
