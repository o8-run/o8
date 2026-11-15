import { DOGFOOD_PR_ONLY_NOTE, currentLaneMergePolicy } from './dogfood-guard';
import { readCurrentOrigin } from '@/lib/repos/remote';
import { detectGitProvider } from '@/lib/git-providers/detect';
import type { Lane } from './types';

/** Read-only delivery guidance shared by direct and automatic integration paths. */
export async function prFirstMergeRefusal(lane: Pick<Lane, 'projectId' | 'repoPath'>): Promise<string | null> {
  const policy = currentLaneMergePolicy(lane.projectId);
  if (policy.mode !== 'pr_only') return null;
  const origin = await readCurrentOrigin(lane.repoPath);
  const prefix = `${policy.note === DOGFOOD_PR_ONLY_NOTE ? 'PR-only dogfood mode is active; direct integration is blocked.' : policy.note} Branch retained; nothing was merged.`;
  if (origin === null) return `${prefix} This repository has no origin remote. Keep working on the branch or configure a supported remote before publishing.`;
  if (origin === undefined) return `${prefix} The origin remote could not be verified; publication is unavailable until its configuration can be read.`;
  const provider = detectGitProvider(origin);
  if (provider?.kind === 'gitlab') return `${prefix} For this GitLab remote, the lane Create PR action cannot create a merge request. Open a merge request in GitLab from the retained branch.`;
  if (!provider) return `${prefix} o8 has not identified a pull-request provider for this origin. Keep the branch and use your host's workflow.`;
  return `${prefix} Next: choose Create PR (pr), or use the lane create_pr action, to open the pull request.`;
}
