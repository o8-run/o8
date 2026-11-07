export const dynamic = 'force-dynamic';

/**
 * Terminal View's session-file mark and import (#5309). `mark` when the view
 * opens; `import` when it closes copies the CLI's new turns into the chat.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { matchesMutationWorkspace, mutationWorkspace } from '@/lib/repos/mutation-workspace';
import { importTerminalTurns, markTerminalTurns } from '@/lib/runtime/terminal-turns';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { tabId?: unknown; action?: unknown } | null;
  const tabId = typeof body?.tabId === 'string' ? body.tabId : '';
  if (!/^thoughts-[A-Za-z0-9_-]{1,120}$/.test(tabId) || (body?.action !== 'mark' && body?.action !== 'import')) {
    return NextResponse.json({ error: 'tabId and action (mark or import) required' }, { status: 400 });
  }
  const prior = readPersistedLlmChat(tabId);
  if (!prior || !matchesMutationWorkspace(mutationWorkspace(request), prior.history.repoPath)) {
    return NextResponse.json({ error: 'History was not found' }, { status: 404 });
  }
  if (body.action === 'mark') {
    return NextResponse.json(await markTerminalTurns(tabId));
  }
  return NextResponse.json(await importTerminalTurns(tabId));
}
