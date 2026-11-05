export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '@/app/api/orchestrator/_utils';
import { createTaskArtifact, listTaskArtifactViews, TaskArtifactError } from '@/lib/task-artifacts/service';

/**
 * Interactive task artifacts (#1699).
 *
 * POST /api/task-artifacts — attach an artifact to a thread or packet.
 *   Operator (MCP, CLI, app): { title, html, actions, headPolicy?, threadId + repoPath | packetId }
 *   Packet worker token:      { title, html, actions, headPolicy? } — pinned to its own packet.
 *   A mission card (#5468) sends `card` instead of html and actions.
 * GET  /api/task-artifacts?threadId=&repoPath=  or  ?packetId=
 *   Operator lists any; a worker may list only its own packet.
 * Gated by the global middleware (loopback or bearer).
 */
export async function POST(request: NextRequest) {
  const ctx = resolveRequestPrincipalContext(request);
  if (ctx.role === 'anonymous' || ctx.role === 'spectator') {
    return operatorError('unauthorized', 'Creating a task artifact requires the operator credential or a packet worker token.', 401);
  }
  const body = asRecord(await parseJsonBody(request));
  if (!body) return operatorError('invalid_request', 'Invalid JSON body.', 400);
  try {
    const record = await createTaskArtifact({
      title: body.title,
      html: body.html,
      actions: body.actions,
      card: body.card,
      headPolicy: body.headPolicy,
      threadId: body.threadId,
      packetId: body.packetId,
      repoPath: body.repoPath,
    }, ctx);
    const { html: _html, ...summary } = record;
    return operatorSuccess({ artifact: summary }, 201);
  } catch (error) {
    if (error instanceof TaskArtifactError) return operatorError(error.code, error.message, error.status, error.details);
    return operatorError('create_failed', error instanceof Error ? error.message : String(error), 500);
  }
}

export async function GET(request: NextRequest) {
  const ctx = resolveRequestPrincipalContext(request);
  const url = new URL(request.url);
  const threadId = url.searchParams.get('threadId')?.trim() || undefined;
  const repoPath = url.searchParams.get('repoPath')?.trim() || undefined;
  const packetId = url.searchParams.get('packetId')?.trim() || undefined;
  if (ctx.role === 'worker') {
    if (!ctx.packetId || packetId !== ctx.packetId) {
      return operatorError('forbidden', 'A worker may list only the artifacts attached to its own packet.', 403);
    }
  } else if (ctx.role !== 'operator' && ctx.role !== 'device') {
    return operatorError('unauthorized', 'Listing task artifacts requires the operator credential.', 401);
  }
  if (!packetId && !(threadId && repoPath)) {
    return operatorError('invalid_request', 'Provide packetId, or threadId together with repoPath.', 400);
  }
  const artifacts = await listTaskArtifactViews({ threadId, repoPath, packetId });
  return operatorSuccess({ artifacts });
}
