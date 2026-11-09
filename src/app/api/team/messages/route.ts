/**
 * GET /api/team/messages?limit=N — recent o8 team messages across the operator's
 * repos (newest first), for oversight. Lets Symon answer "what are the agents
 * saying to each other?" and feeds the supervisor inbox's team view. Read-only
 * filesystem; operator bearer only (panelGateMiddleware).
 */

export const dynamic = 'force-dynamic';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { NextRequest, NextResponse } from 'next/server';
import { listRepos } from '@/lib/repos/registry';

interface TeamMessage {
  from: string;
  to: string;
  text: string;
  at: string;
  repo: string;
}

export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number.parseInt(req.nextUrl.searchParams.get('limit') ?? '10', 10) || 10, 1), 50);
  const messages: TeamMessage[] = [];
  let repos: Array<{ name: string; localPath: string }> = [];
  try {
    repos = await listRepos();
  } catch {
    return NextResponse.json({ schema: 'o8/team.messages/v1', messages });
  }

  for (const repo of repos) {
    if (!repo?.localPath) continue;
    const mailboxDir = path.join(repo.localPath, '.git', 'agents', 'mailbox');
    if (!existsSync(mailboxDir)) continue;
    let files: string[];
    try {
      files = readdirSync(mailboxDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const toHandle = decodeURIComponent(file.replace(/\.jsonl$/, ''));
      try {
        for (const line of readFileSync(path.join(mailboxDir, file), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const m = JSON.parse(line) as { fromHandle?: string; from?: string; text?: string; at?: string };
          messages.push({
            from: m.fromHandle ?? m.from ?? '?',
            to: toHandle,
            text: m.text ?? '',
            at: m.at ?? '',
            repo: repo.name,
          });
        }
      } catch {
        /* skip malformed mailbox */
      }
    }
  }

  messages.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return NextResponse.json({ schema: 'o8/team.messages/v1', messages: messages.slice(0, limit) });
}
