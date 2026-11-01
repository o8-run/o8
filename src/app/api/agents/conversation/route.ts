import { NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { AgentBusError, changeAgentConversation, readAgentConversations } from '@/lib/agents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown): Response {
  if (error instanceof AgentBusError) {
    return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
  }
  console.error('[agent-conversation] Request failed:', error);
  return Response.json({
    ok: false,
    error: { code: 'agent_conversation_failed', message: 'Agent conversations are temporarily unavailable.' },
  }, { status: 503 });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const value = request.nextUrl.searchParams.get('limit');
    const limit = value === null ? 50 : Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AgentBusError('limit must be an integer from 1 through 100.', 'invalid_agent_conversation_limit', 400);
    }
    const status = request.nextUrl.searchParams.get('status');
    if (status !== null && status !== 'open' && status !== 'closed') {
      throw new AgentBusError('status must be open or closed.', 'invalid_agent_conversation_status', 400);
    }
    const scope = request.nextUrl.searchParams.get('scope');
    if (scope !== null && scope !== 'all') throw new AgentBusError('scope must be all when supplied.', 'invalid_agent_conversation_scope', 400);
    const id = request.nextUrl.searchParams.get('id');
    return Response.json({
      schema: id !== null ? 'o8/agents.conversation.history/v1' : 'o8/agents.conversations/v1',
      ...readAgentConversations({ repo: request.nextUrl.searchParams.get('repo'), limit, status: status ?? undefined,
        scope, id, cursor: request.nextUrl.searchParams.get('cursor') }, resolveRequestPrincipalContext(request)),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const result = changeAgentConversation(await request.json().catch(() => null), resolveRequestPrincipalContext(request));
    return Response.json({ schema: 'o8/agents.conversation/v1', ok: true, ...('conversation' in result ? result : { conversation: result }) }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
