import 'server-only';

import { githubInstallationFetch } from './auth';
import { GitHubReadScopeChangedError } from './read-scope';

export interface PullRequestRequirements {
  /** Check names GitHub requires on this pull request; null when GitHub did not say. */
  requiredChecks: string[] | null;
  /** True when the base branch merges through a merge queue; null when unknown. */
  mergeQueue: boolean | null;
  inMergeQueue: boolean;
}

const UNKNOWN: PullRequestRequirements = { requiredChecks: null, mergeQueue: null, inMergeQueue: false };

const QUERY = `query PullRequestRequirements($owner: String!, $name: String!, $number: Int!, $base: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $base) { id }
    pullRequest(number: $number) {
      isInMergeQueue
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { name isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context isRequired(pullRequestNumber: $number) }
        }
      } } } } }
    }
  }
}`;

type Payload = { errors?: unknown[]; data?: { repository?: {
  mergeQueue?: { id?: string } | null;
  pullRequest?: { isInMergeQueue?: boolean; commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { contexts?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: Array<{ name?: string; context?: string; isRequired?: boolean } | null>;
  } } | null } }> } } | null;
} | null } };

/**
 * Which checks GitHub itself requires before this pull request can merge, and
 * whether its base branch uses a merge queue. Optional checks, such as advisory
 * scanners, must not hold a merge that GitHub would accept. Any failure to read
 * this answers "unknown", and the merge gate then treats every check as required.
 */
export async function readPullRequestRequirements(repo: string, number: number, base: string, authorizedScope?: string): Promise<PullRequestRequirements> {
  const [owner, name] = repo.split('/');
  if (!owner || !name || !base) return UNKNOWN;
  try {
    const { response, scope, anonymous } = await githubInstallationFetch(repo, '/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(18_000),
      body: JSON.stringify({ query: QUERY, variables: { owner, name, number, base } }),
    });
    if (authorizedScope && scope !== authorizedScope) {
      void response.body?.cancel().catch(() => {});
      throw new GitHubReadScopeChangedError('GitHub authorization changed while reading merge requirements. Retry.', anonymous);
    }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return UNKNOWN; }
    const payload = await response.json() as Payload;
    const repository = payload.data?.repository;
    if (payload.errors?.length || !repository?.pullRequest) return UNKNOWN;
    const contexts = repository.pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    const nodes = contexts?.nodes;
    const required = !contexts ? [] : !Array.isArray(nodes) || contexts.pageInfo?.hasNextPage ? null
      : nodes.flatMap(node => node?.isRequired && (node.name || node.context) ? [(node.name || node.context)!] : []);
    return { requiredChecks: required ? [...new Set(required)].sort() : null,
      mergeQueue: Boolean(repository.mergeQueue?.id), inMergeQueue: Boolean(repository.pullRequest.isInMergeQueue) };
  } catch (error) {
    if (error instanceof GitHubReadScopeChangedError) throw error;
    return UNKNOWN;
  }
}
