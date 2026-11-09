/**
 * POST /api/team/tell — relay a message to a running o8 team agent by handle.
 *
 * The voice path: the operator says "tell Nova to hold the ship" → Symon calls
 * this → it finds the LIVE peer named Nova across the operator's repos and drops
 * a durable message in that repo's o8 team mailbox. Nova's guard hook surfaces it
 * on its next tool call. Operator bearer only (panelGateMiddleware); resolves the handle to its repo so the
 * caller doesn't need to know which repo the agent is in.
 */

export const dynamic = 'force-dynamic';

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { NextRequest, NextResponse } from 'next/server';
import { listRepos } from '@/lib/repos/registry';

const LIVE_TTL_MS = 6 * 60 * 1000;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { to?: string; text?: string; from?: string } | null;
  const to = (body?.to ?? '').replace(/^@/, '').trim();
  const text = (body?.text ?? '').trim();
  const fromHandle = (body?.from ?? '').trim() || 'Symon';
  if (!to || !text) {
    return NextResponse.json({ ok: false, error: 'Both `to` (agent handle) and `text` are required.' }, { status: 400 });
  }

  let repos: Array<{ name: string; localPath: string }> = [];
  try {
    repos = await listRepos();
  } catch {
    /* no registry — fall through to not-found */
  }

  for (const repo of repos) {
    if (!repo?.localPath) continue;
    const presenceDir = path.join(repo.localPath, '.git', 'agents', 'presence');
    if (!existsSync(presenceDir)) continue;
    let files: string[];
    try {
      files = readdirSync(presenceDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const p = JSON.parse(readFileSync(path.join(presenceDir, file), 'utf8')) as { handle?: string; lastSeen?: string };
        const seen = p.lastSeen ? Date.parse(p.lastSeen) : NaN;
        if (!Number.isFinite(seen) || Date.now() - seen > LIVE_TTL_MS) continue;
        if ((p.handle ?? '').toLowerCase() !== to.toLowerCase()) continue;
        // Found the live peer — deliver to that repo's mailbox (durable JSONL).
        const mailboxDir = path.join(repo.localPath, '.git', 'agents', 'mailbox');
        mkdirSync(mailboxDir, { recursive: true });
        const mailboxFile = path.join(mailboxDir, `${encodeURIComponent(p.handle ?? to)}.jsonl`);
        const msg = { from: 'symon', fromHandle, text, at: new Date().toISOString() };
        writeFileSync(mailboxFile, `${JSON.stringify(msg)}\n`, { flag: 'a' });
        return NextResponse.json({ ok: true, schema: 'o8/team.tell/v1', to: p.handle, repo: repo.name });
      } catch {
        /* skip malformed presence */
      }
    }
  }

  return NextResponse.json(
    { ok: false, error: `No agent named "${to}" is working right now. Use o8_status to see who's here.` },
    { status: 404 },
  );
}
