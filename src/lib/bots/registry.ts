/**
 * Always-on bots from any "house" (Grok, Codex, Claude, o8 native, …) that the
 * native rail lists under the PRs icon. A house is only a string: each house
 * contributes a provider, and operators may add static entries in
 * `<dataDir>/bots.json` (`{ "bots": BotEntry[] }`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { grokProvider } from './grok';

export type BotStatus = 'online' | 'offline' | 'unknown';

export interface BotMainThread {
  /** `mailbox`: an o8-owned JSONL thread the bot mirrors into; `o8-thread`: an o8 thread id; `url`: external only. */
  kind: 'mailbox' | 'o8-thread' | 'url';
  id?: string;
  url?: string;
}

export interface BotEntry {
  id: string;
  house: string;
  name: string;
  icon: { key?: string; url?: string };
  mainThread: BotMainThread | null;
  status: BotStatus;
}

export interface BotProvider {
  house: string;
  list(): BotEntry[];
}

const ID = /^[a-zA-Z0-9:_-]{1,160}$/;

export function sanitizeBot(value: unknown): BotEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  const id = str(raw.id, 160);
  const house = str(raw.house, 40);
  if (!id || !ID.test(id) || !house) return null;
  const icon = (raw.icon && typeof raw.icon === 'object' ? raw.icon : {}) as Record<string, unknown>;
  const thread = raw.mainThread && typeof raw.mainThread === 'object' ? raw.mainThread as Record<string, unknown> : null;
  const kind = thread?.kind;
  const status = raw.status === 'online' || raw.status === 'offline' ? raw.status : 'unknown';
  return {
    id,
    house: house.toLowerCase(),
    name: str(raw.name, 80) ?? id,
    icon: { key: str(icon.key, 40), url: str(icon.url, 500) },
    mainThread: thread && (kind === 'mailbox' || kind === 'o8-thread' || kind === 'url')
      ? { kind, id: str(thread.id, 160), url: str(thread.url, 500) }
      : null,
    status,
  };
}

export function staticBots(dataDir = getDataDir()): BotEntry[] {
  const path = join(dataDir, 'bots.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bots?: unknown };
    return Array.isArray(parsed.bots) ? parsed.bots.flatMap((b) => sanitizeBot(b) ?? []) : [];
  } catch {
    return [];
  }
}

export const PROVIDERS: BotProvider[] = [grokProvider];

/** Provider bots first (house order, then name), static entries after; first id wins. */
export function listBots(providers: BotProvider[] = PROVIDERS, dataDir = getDataDir()): BotEntry[] {
  const seen = new Set<string>();
  const out: BotEntry[] = [];
  const fromProviders = providers.flatMap((p) => {
    try {
      return p.list().flatMap((b) => sanitizeBot(b) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  });
  for (const bot of [...fromProviders, ...staticBots(dataDir)]) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    out.push(bot);
  }
  return out;
}

export function findBot(id: string, providers?: BotProvider[], dataDir?: string): BotEntry | null {
  return listBots(providers, dataDir).find((b) => b.id === id) ?? null;
}
