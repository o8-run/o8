import { NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import {
  attachPullRequestContext,
  PullRequestContextError,
  unlinkPullRequestContext,
} from '@/lib/orchestrator/pull-request-context';
import { contextThread, contextIdentity, readPullRequestContext } from '@/lib/orchestrator/pull-request-context-query';
import { operatorError, operatorSuccess } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requireOperator(request: NextRequest): Response | null {
  return resolveRequestPrincipal(request) === 'operator' ? null
    : operatorError('forbidden', 'Conversation PR context is operator-only.', 403);
}

function invalid(): Response {
  return operatorError('invalid_request', 'Provide a conversation or complete GitHub PR identity, with valid pagination.', 400);
}

function failure(error: unknown): Response {
  return error instanceof PullRequestContextError
    ? operatorError(error.code, error.message, error.status)
    : operatorError('context_unavailable', 'Unable to access conversation PR context.', 500);
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const denied = requireOperator(request);
    if (denied) return denied;
    return operatorSuccess(await readPullRequestContext(request.nextUrl.searchParams));
  } catch (error) { return failure(error); }
}

async function mutate(request: NextRequest, remove: boolean): Promise<Response> {
  try {
    const denied = requireOperator(request);
    if (denied) return denied;
    const text = await request.text();
    if (text.length > 8_192) return invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return invalid(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
    const body = parsed as Record<string, unknown>;
    const targetThread = contextThread(body.threadId);
    const targetPr = contextIdentity(body);
    const kind = body.kind ?? 'context';
    if (!targetThread || !targetPr || !['context', 'review', 'import'].includes(String(kind)) || (body.source !== undefined && body.source !== 'operator')) return invalid();
    const role = kind as 'context' | 'review' | 'import';
    if (remove) return operatorSuccess({ removed: unlinkPullRequestContext(targetThread, targetPr, role) });
    const result = attachPullRequestContext(targetThread, targetPr, role);
    return operatorSuccess(result, result.created ? 201 : 200);
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest): Promise<Response> { return mutate(request, false); }
export async function DELETE(request: NextRequest): Promise<Response> { return mutate(request, true); }
