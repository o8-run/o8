export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findRosterBot } from '@/lib/bots/roster';
import { mailboxPath, readMailbox } from '@/lib/bots/mailbox';

/** A bot's main thread, read-only: mailbox messages plus the external link. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const bot = findRosterBot(decodeURIComponent(id));
    if (!bot) return NextResponse.json({ error: 'Unknown bot' }, { status: 404 });
    const thread = bot.mainThread;
    const messages = thread?.kind === 'mailbox' && thread.id ? await readMailbox(mailboxPath(bot.house, thread.id)) : [];
    return NextResponse.json({ bot, messages, externalUrl: thread?.url ?? null });
  } catch {
    return NextResponse.json({ error: 'Bot conversation is temporarily unavailable.' }, { status: 503 });
  }
}
