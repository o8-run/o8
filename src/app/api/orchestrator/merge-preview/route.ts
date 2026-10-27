import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { previewPacketMerge } from '@/lib/lane/preview-merge';
import { branchUnresolvedPayload, LaneBranchUnresolvedError } from '@/lib/lane/review-target';
import {
  ImmutableReviewUnavailableError,
  immutableReviewUnavailablePayload,
} from '@/lib/lane/review-source';
import { operatorError } from '@/app/api/orchestrator/_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/orchestrator/merge-preview?packetId=<id>
 *
 * Dry-runs the merge gate for one packet (no worktree mutation) and
 * returns `{ packetId, wouldMerge, checks[], blockers[], branch }` — the same
 * MergePreviewResult the `o8_merge_preview` MCP tool surfaces. The N-up compare
 * matrix renders this per column so the operator sees each candidate's GATE
 * VERDICT before picking — the governance signal a plain diff view can't show.
 * Gated by the global middleware (loopback + token under /api/orchestrator/).
 */
export async function GET(request: NextRequest) {
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && principal.role !== 'device' && principal.role !== 'worker') {
    return operatorError(
      'unauthorized',
      'Merge preview requires the operator credential, an enrolled device, or a packet-bound worker credential.',
      401,
    );
  }

  const packetId = request.nextUrl.searchParams.get('packetId')?.trim();
  const ownershipRefusal = workerPacketRefusal(principal, packetId);
  if (ownershipRefusal) {
    return viewerJson({ ok: false, error: ownershipRefusal }, { status: 403 });
  }
  if (!packetId) {
    return viewerJson({ error: 'packetId is required.' }, { status: 400 });
  }

  try {
    const preview = await previewPacketMerge(packetId);
    return viewerJson(preview);
  } catch (error) {
    console.error('[api] orchestrator/merge-preview failed:', error);
    if (error instanceof LaneBranchUnresolvedError) {
      return viewerJson({ ...branchUnresolvedPayload(error), packetId, wouldMerge: false,
        blockers: ['worktree-branch'], checks: [{ name: 'worktree-branch', verdict: 'fail', detail: error.reason,
          actions: [`Restore the packet checkout to its recorded branch ${error.lane.branch} at the reviewed HEAD, then rerun merge-preview.`] }],
      }, { status: 409 });
    }
    if (error instanceof ImmutableReviewUnavailableError) {
      return viewerJson(immutableReviewUnavailablePayload(error), { status: 409 });
    }
    const message = 'merge preview failed';
    return viewerJson({ error: message }, { status: 500 });
  }
}
