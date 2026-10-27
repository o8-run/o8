import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { operatorError } from '@/app/api/orchestrator/_utils';
import { getTaskArtifactView } from '@/lib/task-artifacts/service';
import { TASK_ARTIFACT_ID_PATTERN } from '@/lib/task-artifacts/types';

/**
 * GET /api/task-artifacts/[id] — one artifact with its HTML, writability, and
 * last receipt. The desktop host renders from this. Operator or device; a
 * worker may read only an artifact attached to its own packet.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!TASK_ARTIFACT_ID_PATTERN.test(id)) return operatorError('invalid_request', 'Invalid task artifact id.', 400);
  const ctx = resolveRequestPrincipalContext(request);
  if (ctx.role !== 'operator' && ctx.role !== 'device' && ctx.role !== 'worker') {
    return operatorError('unauthorized', 'Reading a task artifact requires the operator credential.', 401);
  }
  const view = await getTaskArtifactView(id, { includeHtml: true });
  if (!view) return operatorError('not_found', `Task artifact ${id} not found.`, 404);
  if (ctx.role === 'worker' && (!ctx.packetId || view.artifact.target.packetId !== ctx.packetId)) {
    return operatorError('forbidden', 'A worker may read only artifacts attached to its own packet.', 403);
  }
  return viewerJson({ ok: true, result: view });
}
