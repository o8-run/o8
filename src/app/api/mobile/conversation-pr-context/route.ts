import { NextRequest } from 'next/server';
import { readProjectedThread } from '@/lib/mobile/orchestrator-thread-history';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { readPullRequestContext } from '@/lib/orchestrator/pull-request-context-query';
import { PullRequestContextError } from '@/lib/orchestrator/pull-request-context';
import { operatorError, operatorSuccess } from '../../orchestrator/_utils';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A paired phone can read associations. All edits retain the operator boundary. */
export async function GET(request: NextRequest): Promise<Response> {
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'device') return operatorError('forbidden', 'A paired device or operator is required.', 403);
  try {
    const result = await readPullRequestContext(request.nextUrl.searchParams);
    const id = request.nextUrl.searchParams.get('threadId');
    return operatorSuccess({ ...result, ...(id ? { thread: readProjectedThread(id) } : {}) });
  }
  catch (error) {
    return error instanceof PullRequestContextError ? operatorError(error.code, error.message, error.status)
      : operatorError('context_unavailable', 'Unable to read conversation PR links.', 500);
  }
}
