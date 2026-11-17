import 'server-only';
import { githubInstallationFetch } from './auth';
import type { GitHubPullRequestSnapshot } from './store';

interface ActorEvent {
  kind: string;
  at: string;
  actorType: string | null;
  commitSha?: string;
  enqueuerType?: string | null;
}
export interface MergeActorEvidence {
  complete: boolean;
  humanIntervention: 'human' | 'none' | 'unknown';
  events: ActorEvent[];
}

// Read the whole timeline, including queue and auto-merge actions. Unknown node
// types fail closed: the UI activity projection discards actor types and cannot
// establish absence of human intervention.
const QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    headRefOid mergedAt mergeCommit { oid }
    timelineItems(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes {
      __typename
      ... on MergedEvent { createdAt actor { __typename } commit { oid } }
      ... on AddedToMergeQueueEvent { createdAt actor { __typename } enqueuer { __typename } }
      ... on RemovedFromMergeQueueEvent { createdAt actor { __typename } enqueuer { __typename } }
      ... on AutoMergeEnabledEvent { createdAt actor { __typename } }
      ... on AutoMergeDisabledEvent { createdAt actor { __typename } }
      ... on PullRequestReview { submittedAt author { __typename } }
      ... on PullRequestCommit { commit { oid committedDate author { user { __typename } } } }
      ... on IssueComment { createdAt author { __typename } }
      ... on ClosedEvent { createdAt actor { __typename } }
      ... on HeadRefDeletedEvent { createdAt actor { __typename } }
      ... on HeadRefForcePushedEvent { createdAt actor { __typename } }
      ... on ReviewRequestedEvent { createdAt actor { __typename } }
      ... on ReviewRequestRemovedEvent { createdAt actor { __typename } }
    } }
  } }
}`;
interface Node {
  __typename: string; createdAt?: string; submittedAt?: string;
  actor?: { __typename?: string } | null; author?: { __typename?: string } | null;
  enqueuer?: { __typename?: string } | null;
  commit?: { oid?: string; committedDate?: string; author?: { user?: { __typename?: string } | null } };
}
interface Result {
  errors?: unknown[];
  data?: { repository?: { pullRequest?: {
    headRefOid: string; mergedAt: string; mergeCommit?: { oid?: string };
    timelineItems: { nodes: Array<Node | null>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  } } };
}
export async function readMergeActorEvidence(pull: GitHubPullRequestSnapshot, verdictAt: number | null): Promise<MergeActorEvidence> {
  const events: ActorEvent[] = [];
  const unknown = (): MergeActorEvidence => ({ complete: false, humanIntervention: 'unknown', events });
  if (verdictAt === null || !pull.mergedAt || !pull.headSha || !pull.mergeCommit) return unknown();
  const mergedAt = Date.parse(pull.mergedAt);
  if (!Number.isFinite(mergedAt) || verdictAt > mergedAt) return unknown();
  const [owner, name] = pull.repoFullName.split('/');
  let after: string | null = null;
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(15_000);
  try {
    // Bound work. Exceeding this cap produces unknown, never partial autonomy.
    for (let page = 0; page < 50; page++) {
      const { response } = await githubInstallationFetch(pull.repoFullName, '/graphql', {
        method: 'POST', signal,
        body: JSON.stringify({ query: QUERY, variables: { owner, name, number: pull.number, after } }),
      });
      if (!response.ok) return unknown();
      const result = await response.json() as Result;
      const pr = result.data?.repository?.pullRequest;
      if (result.errors?.length || !pr || pr.headRefOid !== pull.headSha
        || pr.mergeCommit?.oid !== pull.mergeCommit || Date.parse(pr.mergedAt) !== mergedAt) return unknown();
      for (const node of pr.timelineItems.nodes) {
        if (!node) return unknown();
        const at = node.createdAt ?? node.submittedAt ?? node.commit?.committedDate;
        // Unsupported activity could hide a human action in the interval.
        if (!at || !Number.isFinite(Date.parse(at))) return unknown();
        if (Date.parse(at) < verdictAt || Date.parse(at) > mergedAt) continue;
        events.push({ kind: node.__typename, at, actorType: (node.actor ?? node.author ?? node.commit?.author?.user)?.__typename ?? null,
          ...(['AddedToMergeQueueEvent', 'RemovedFromMergeQueueEvent'].includes(node.__typename)
            ? { enqueuerType: node.enqueuer?.__typename ?? null } : {}),
          ...(node.commit?.oid ? { commitSha: node.commit.oid } : {}) });
      }
      const info = pr.timelineItems.pageInfo;
      if (!info.hasNextPage) {
        const merge = events.find(event => event.kind === 'MergedEvent'
          && event.commitSha === pull.mergeCommit && Date.parse(event.at) === mergedAt);
        if (!merge) return unknown();
        const human = events.some(event => event.actorType === 'User' || event.enqueuerType === 'User');
        return { complete: true, humanIntervention: human ? 'human'
          : merge.actorType === 'Bot' && events.every(event => event.actorType === 'Bot'
            && (event.enqueuerType === undefined || event.enqueuerType === 'Bot')) ? 'none' : 'unknown', events };
      }
      if (!info.endCursor || cursors.has(info.endCursor)) return unknown();
      cursors.add(info.endCursor);
      after = info.endCursor;
    }
  } catch { return unknown(); }
  return unknown();
}
