export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findRosterBot } from '@/lib/bots/roster';
import { appendMailbox, mailboxPath, readMailbox } from '@/lib/bots/mailbox';

/** A bot's main thread: mailbox messages plus the external link. */
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

/** The operator's reply: appended to the bot's mailbox as a `user` line. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const bot = findRosterBot(decodeURIComponent(id));
  if (!bot) return NextResponse.json({ error: 'Unknown bot' }, { status: 404 });
  const thread = bot.mainThread;
  const path = thread?.kind === 'mailbox' && thread.id ? mailboxPath(bot.house, thread.id) : null;
  if (!path) return NextResponse.json({ error: 'This bot has no mailbox' }, { status: 409 });
  const body = await request.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 });
  return NextResponse.json({ ok: true, message: appendMailbox(path, text) });
}
