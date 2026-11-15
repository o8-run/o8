import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { normalizeReviewerPrSource, type ReviewerPrSource } from '@/lib/orchestrator/reviewer-pr-source-types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketCreationBaseAuthority } from '@/lib/lane/packet-creation-base';

const execFileAsync = promisify(execFile);
export class ReviewerPrInputError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function validateReviewPullRequest(body: Record<string, unknown>): number | undefined {
  if (body.reviewPullRequest === undefined) return undefined;
  const number = body.reviewPullRequest;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new ReviewerPrInputError('invalid_review_pull_request', 'reviewPullRequest must be a positive integer.');
  }
  if (body.readOnly !== true || body.checkoutMode === 'shared' || body.isolate === false) {
    throw new ReviewerPrInputError('invalid_review_mode', 'A PR review requires readOnly: true and an isolated checkout.');
  }
  return number;
}

export function validateRepairPullRequest(body: Record<string, unknown>): number | undefined {
  if (body.repairPullRequest === undefined) return undefined;
  const source = normalizeReviewerPrSource({ pullRequest: body.repairPullRequest, headSha: body.expectedRepairHeadSha });
  if (!source || body.reviewPullRequest !== undefined || body.readOnly === true || body.checkoutMode === 'shared' || body.isolate === false) {
    throw new ReviewerPrInputError('invalid_repair_source', 'A repair requires a PR number, exact head SHA and an editable isolated checkout.');
  }
  return source.pullRequest;
}

export class StaleRepairHeadError extends Error {
  readonly code = 'stale_pr_head';
  constructor() { super('The PR head changed after these checks were selected. Refresh the checks before starting a repair.'); }
}

/** Fetch on the host before the read-only worker starts. Keep a packet-specific GC root. */
export async function resolveReviewerPrSource(input: {
  repoPath: string; packetId: string; pullRequest: number; existing?: ReviewerPrSource;
}): Promise<ReviewerPrSource> {
  if (!/^pkt-(?:delegate|pr-review)-[a-f0-9]{16}$/.test(input.packetId)) throw new Error('Invalid reviewer packet identity.');
  try {
    if (input.existing) {
      const source = normalizeReviewerPrSource(input.existing);
      if (!source || source.pullRequest !== input.pullRequest) throw new Error('Reviewer source changed.');
      await execFileAsync('git', ['cat-file', '-e', `${source.headSha}^{commit}`], { cwd: input.repoPath, timeout: 5_000 });
      return source;
    }
    const ref = `refs/o8/review-inputs/${input.packetId}`;
    await execFileAsync('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin',
      `refs/pull/${input.pullRequest}/head:${ref}`], { cwd: input.repoPath, timeout: 30_000 });
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: input.repoPath, timeout: 5_000 });
    const source = normalizeReviewerPrSource({ pullRequest: input.pullRequest, headSha: stdout.trim() });
    if (!source) throw new Error('Invalid PR head.');
    return source;
  } catch {
    // Git errors can contain credential-bearing remote URLs. Keep the public error bounded.
    throw new ReviewerPrSourceError('The requested PR head could not be fetched or its pinned commit is unavailable. No reviewer was launched.');
  }
}
export class ReviewerPrSourceError extends Error {}

export function reviewerCreationBase(input: {
  repoPath: string; packetId: string; branch: string; baseBranch: string; source: ReviewerPrSource;
}): PacketCreationBaseAuthority {
  return { repoPath: input.repoPath, packetId: input.packetId, branch: input.branch,
    baseBranch: input.baseBranch, baseCommit: input.source.headSha };
}

/** Relaunches must also refuse a reused workspace that no longer matches the reviewed PR. */
export async function assertReviewerPrCheckout(packetId: string | undefined, cwd: string): Promise<void> {
  if (!packetId) return;
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  let packet: OrchestratorPacket | undefined = readOrchestratorControlPlaneState().packets.find(p => p.id === packetId);
  if (!packet) {
    const { listMissionRegistryEntries } = await import('@/lib/orchestrator/mission-registry');
    packet = listMissionRegistryEntries({ includeArchived: true }).flatMap(entry => entry.mission.packets).find(p => p.id === packetId);
  }
  if (!packet?.reviewSource && !packet?.repairSource) return;
  const source = normalizeReviewerPrSource(packet.reviewSource ?? packet.repairSource);
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, timeout: 5_000 });
  let matches = Boolean(source && stdout.trim() === source.headSha);
  if (!matches && source && packet.repairSource) {
    const { listLanes } = await import('@/lib/lane/registry');
    const previouslyStarted = packet.lane?.sessionKey || listLanes().some(lane => lane.packetId === packetId && lane.sessionKey);
    if (previouslyStarted) {
      try { await execFileAsync('git', ['merge-base', '--is-ancestor', source.headSha, stdout.trim()], { cwd, timeout: 5_000 }); matches = true; }
      catch { /* An unrelated checkout is never a continuation of this repair. */ }
    }
  }
  if (!source || packet.launchContext?.workMode !== (packet.repairSource ? 'edit' : 'read-only') || !matches) {
    throw new ReviewerPrSourceError('Reviewer checkout does not match its pinned PR head. No reviewer was launched.');
  }
}
