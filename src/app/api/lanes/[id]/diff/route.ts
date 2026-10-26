import { viewerGitJson } from '@/lib/viewers/git-response';
import { viewerJson } from '@/lib/viewers/response';
import { type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { findLatestLaneByPacket, getLane } from '@/lib/lane/registry';
import {
  branchUnresolvedPayload,
  LaneBranchUnresolvedError,
} from '@/lib/lane/review-target';
import {
  ImmutableReviewUnavailableError,
  immutableReviewUnavailablePayload,
  readLaneReviewDiff,
} from '@/lib/lane/review-source';

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_ALLOWED_BYTES = 512 * 1024;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only diff of a packet's worktree against where it diverged from base —
 * exactly what the lane changed (committed + uncommitted). Byte-bounded so the
 * orchestrator can review without raw shell and without flooding its context.
 * `id` accepts a lane id OR a packet id.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const lane = getLane(id) ?? findLatestLaneByPacket(id);
  if (!lane) {
    return viewerJson({ ok: false, note: 'No lane found for that id/packet.' }, { status: 404 });
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), lane.packetId);
  if (ownershipRefusal) {
    return viewerJson({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  const url = new URL(req.url);
  const requestedMax = parseInt(url.searchParams.get('maxBytes') ?? '', 10);
  const maxBytes = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, MAX_ALLOWED_BYTES)
    : DEFAULT_MAX_BYTES;
  try {
    const review = await readLaneReviewDiff(lane);
    const sizeBytes = Buffer.byteLength(review.full, 'utf8');
    const truncated = sizeBytes > maxBytes;
    const diff = truncated
      ? `${Buffer.from(review.full, 'utf8').subarray(0, maxBytes).toString('utf8')}\n\n…[diff truncated at ${maxBytes} bytes of ${sizeBytes} — raise maxBytes or read the file directly]`
      : review.full;

    return viewerGitJson({
      ok: true,
      laneId: lane.id,
      packetId: lane.packetId ?? null,
      headSha: review.headSha,
      base: review.base,
      diffBase: review.diffBase,
      branch: review.source.branch,
      worktreePath: review.source.kind === 'materialized' ? review.source.cwd : null,
      reviewSource: review.source.kind,
      repositoryUuid: review.source.repositoryUuid,
      mergeAvailable: review.source.mergeAvailable,
      ...(review.source.kind === 'immutable_snapshot'
        ? { diffFingerprint: review.source.diffFingerprint, treeSha: review.source.treeSha }
        : {}),
      stat: review.stat.trim(),
      diff,
      sizeBytes,
      truncated,
      maxBytes,
    }, review.source.cwd, {}, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    if (error instanceof LaneBranchUnresolvedError) {
      return viewerJson(branchUnresolvedPayload(error), { status: 409 });
    }
    if (error instanceof ImmutableReviewUnavailableError) {
      return viewerJson(immutableReviewUnavailablePayload(error), { status: 409 });
    }
    console.error('[api] lanes/[id]/diff failed:', error);
    const message = 'Unable to compute diff.';
    return viewerJson({ ok: false, note: message }, { status: 500 });
  }
}
