import { currentLaneMergePolicy } from './dogfood-guard';
import { readCurrentOrigin } from '@/lib/repos/remote';
import { remoteRepositoryIdentity } from '@/lib/repos/remote-identity';
import type { Lane } from './types';

/** Read-only delivery guidance shared by direct and automatic integration paths. */
export async function prFirstMergeRefusal(lane: Pick<Lane, 'projectId' | 'repoPath'>): Promise<string | null> {
  const policy = currentLaneMergePolicy(lane.projectId);
  if (policy.mode !== 'pr_only') return null;
  const origin = await readCurrentOrigin(lane.repoPath);
  const prefix = `${policy.note} Branch retained; nothing was merged.`;
  if (origin === null) return `${prefix} This repository has no origin remote. Keep working on the branch or configure a supported remote before publishing.`;
  if (origin === undefined) return `${prefix} The origin remote could not be verified; publication is unavailable until its configuration can be read.`;
  if (!/^github\.com\/[^/]+\/[^/]+$/.test(remoteRepositoryIdentity(origin))) return `${prefix} o8 cannot open pull requests on this remote host. Publish the retained branch using that host's workflow.`;
  return `${prefix} Next: use the existing pr action (POST /api/worktrees/merge with action: "pr") to open the pull request, or use the lane create_pr action.`;
}
