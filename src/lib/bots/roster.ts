import 'server-only';
import type Database from 'better-sqlite3';
import { getDataDir } from '@/lib/data-dir-migration';
import { listBotMembers } from '@/lib/agents/bot-membership-store';
import type { BotMember } from '@/lib/agents/types';
import { listBots, PROVIDERS, type BotEntry, type BotProvider } from './registry';

function projectMember(member: BotMember, source?: BotEntry): BotEntry {
  return {
    id: member.id,
    // A provider's mailbox reference keeps its own house and path context.
    house: source?.house ?? member.house,
    name: member.name,
    icon: member.iconKey ? { key: member.iconKey } : source?.icon ?? { key: member.house },
    mainThread: member.homeThreadId ? { kind: 'o8-thread', id: member.homeThreadId } : source?.mainThread ?? null,
    status: member.bindings.length ? member.bindings.some(b => b.live) ? 'online' : 'offline' : source?.status ?? 'unknown',
  };
}

function roster(providers: BotProvider[], dataDir: string, sqlite?: Database.Database) {
  const members = listBotMembers(sqlite);
  const bySource = new Map<string, BotMember>();
  for (const member of members) {
    bySource.set(member.id, member);
    for (const source of member.sourceIds) bySource.set(source, member);
  }
  const out: BotEntry[] = [];
  const seen = new Set<string>();
  for (const source of listBots(providers, dataDir)) {
    const member = bySource.get(source.id);
    const bot = member ? projectMember(member, source) : source;
    if (!seen.has(bot.id)) { seen.add(bot.id); out.push(bot); }
  }
  for (const member of members) {
    if (!seen.has(member.id)) { seen.add(member.id); out.push(projectMember(member)); }
  }
  return { entries: out, bySource };
}

/** Existing configured/provider order is retained; unrepresented members append in creation order. */
export function listRosterBots(providers: BotProvider[] = PROVIDERS, dataDir = getDataDir(), sqlite?: Database.Database): BotEntry[] {
  return roster(providers, dataDir, sqlite).entries;
}

/** Keep old provider/configuration IDs usable by already-persisted Bot tabs. */
export function findRosterBot(id: string, providers: BotProvider[] = PROVIDERS, dataDir = getDataDir(), sqlite?: Database.Database): BotEntry | null {
  const snapshot = roster(providers, dataDir, sqlite);
  const canonical = snapshot.bySource.get(id)?.id ?? id;
  return snapshot.entries.find(b => b.id === canonical) ?? null;
}

/** Eligibility belongs to Settings; provider/source aliases retain a prior explicit choice. */
export function listConfiguredRosterBots(enabledIds: string[], providers: BotProvider[] = PROVIDERS, dataDir = getDataDir(), sqlite?: Database.Database): BotEntry[] {
  const snapshot = roster(providers, dataDir, sqlite);
  const enabled = new Set(enabledIds.map(id => snapshot.bySource.get(id)?.id ?? id));
  return snapshot.entries.filter(bot => enabled.has(bot.id));
}

/** Settings lists candidates independently of rail eligibility, using the same canonical projection. */
export function listRosterBotSettingsCandidates(providers: BotProvider[] = PROVIDERS, dataDir = getDataDir(), sqlite?: Database.Database) {
  const snapshot = roster(providers, dataDir, sqlite);
  return snapshot.entries.map(({ id, name, house }) => ({ id, name, house,
    selectionIds: [...new Set([id, ...(snapshot.bySource.get(id)?.sourceIds ?? [])])] }));
}
