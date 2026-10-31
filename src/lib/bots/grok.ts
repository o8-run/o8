/**
 * Grok house provider. Discovers Grok Bot agents whose data directory is on
 * this machine (`$O8_GROK_AGENT_DATA` or `~/agent-data/agents/<id>/profile.json`),
 * reading only the profile name. The Grok Bot chat itself is not stored on the
 * box and has no sanctioned local API, so the main thread is an o8 mailbox the
 * bot mirrors into, plus the app's documented deep link for the real chat.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotEntry, BotProvider } from './registry';
import { mailboxPath, mailboxUpdatedAt } from './mailbox';

const AGENT_ID = /^[a-f0-9-]{8,64}$/;
const ONLINE_MS = 15 * 60_000;

export function grokAgentRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.O8_GROK_AGENT_DATA?.trim() || join(homedir(), 'agent-data', 'agents');
}

export function grokDeepLink(agentId: string): string {
  return `grokbot://app/v1/agent?id=${encodeURIComponent(agentId)}`;
}

export function listGrokBots(root = grokAgentRoot(), dataDir?: string, now = Date.now()): BotEntry[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((agentId): BotEntry[] => {
    if (!AGENT_ID.test(agentId)) return [];
    const profile = join(root, agentId, 'profile.json');
    if (!existsSync(profile)) return [];
    let name = 'Grok bot';
    try {
      const parsed = JSON.parse(readFileSync(profile, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) name = parsed.name.trim().slice(0, 80);
    } catch {
      return [];
    }
    const updated = mailboxUpdatedAt(mailboxPath('grok', agentId, dataDir));
    return [{
      id: `grok:${agentId}`,
      house: 'grok',
      name,
      icon: { key: 'grok' },
      mainThread: { kind: 'mailbox', id: agentId, url: grokDeepLink(agentId) },
      status: updated === null ? 'unknown' : now - updated < ONLINE_MS ? 'online' : 'offline',
    }];
  });
}

export const grokProvider: BotProvider = { house: 'grok', list: () => listGrokBots() };
