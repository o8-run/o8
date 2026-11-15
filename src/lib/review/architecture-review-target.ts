import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import type { Lane } from '@/lib/lane/types';
import { laneReviewRevision, readLaneReviewDiff } from '@/lib/lane/review-source';
import { collectWorktreeDiffSnapshot } from '@/lib/worktree/diff-transport';

import { ArchitectureDeltaInputError, buildArchitectureDelta, unavailableArchitectureDelta } from './architecture-delta';

const exec = promisify(execFile);

export class ArchitectureReviewChangedError extends Error {
  constructor() { super('Review changed. Refresh the diff before loading its change map.'); }
}

function expectedRevision(params: URLSearchParams) {
  if (!params.has('expectedRevision')) return null;
  const revision = params.get('expectedRevision') ?? '';
  if (!/^[a-f0-9]{64}$/i.test(revision)) throw new ArchitectureDeltaInputError('A valid review revision is required.');
  return revision.toLowerCase();
}

function checkRevision(expected: string | null, actual: string) {
  if (expected && expected !== actual) throw new ArchitectureReviewChangedError();
}

export async function buildLaneArchitectureReviewTarget(lane: Lane, params: URLSearchParams) {
  const expected = expectedRevision(params);
  const review = await readLaneReviewDiff(lane);
  if (expected) checkRevision(expected, laneReviewRevision(lane.id, review));
  if (review.source.kind !== 'materialized') return { result: {
    ...unavailableArchitectureDelta('The change map currently requires a materialized packet workspace.'),
    ...(expected ? { reviewRevision: expected } : {}),
  } };
  const baseRef = review.diffBase.mergeBase ?? review.diffBase.comparisonRef;
  const result = await buildArchitectureDelta({ repoPath: review.source.cwd, baseRef, ...(expected ? { trackedOnly: true } : {}) });
  if (expected) checkRevision(expected, laneReviewRevision(lane.id, await readLaneReviewDiff(lane)));
  return { result: { ...result, ...(expected ? { reviewRevision: expected } : {}) }, repoPath: review.source.cwd };
}

/** A PR comparison must never quietly include the operator's working changes. */
export async function buildArchitectureReviewTarget(workspace: string, params: URLSearchParams) {
  const head = params.get('expectedHead');
  const base = params.get('base');
  if (!params.has('expectedHead') && !params.has('base')) {
    const expected = expectedRevision(params);
    if (expected) checkRevision(expected, (await collectWorktreeDiffSnapshot(workspace, null)).revision);
    const result = await buildArchitectureDelta({ repoPath: workspace });
    if (expected) checkRevision(expected, (await collectWorktreeDiffSnapshot(workspace, null)).revision);
    return { ...result, ...(expected ? { reviewRevision: expected } : {}) };
  }
  if (!head || !base || !/^[a-f0-9]{40}$/i.test(head) || !/^[a-f0-9]{40}$/i.test(base)) {
    throw new ArchitectureDeltaInputError('A full review head and base SHA are required.');
  }
  const git = async (args: string[]) => (await exec('git', ['-C', workspace, ...args], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  })).stdout.trim();
  let mergeBase: string;
  try { mergeBase = await git(['merge-base', base, head]); }
  catch { return unavailableArchitectureDelta('Fetch this pull request’s base and head commits to read its change map.'); }
  return buildArchitectureDelta({ repoPath: workspace, baseRef: mergeBase, headRef: head });
}
