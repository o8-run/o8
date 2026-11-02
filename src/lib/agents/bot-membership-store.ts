import 'server-only';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { ensureV76BotMembershipSchema } from '@/lib/db/v76-bot-membership-migration';
import { AGENT_PRESENCE_TTL_MS, findAgentPresence } from './store';
import type { BotMember, BotMemberBinding } from './types';

interface MemberRow {
  id: string; house: string; display_name: string; icon_key: string | null; home_thread_id: string | null;
  created_at: string; updated_at: string;
}
interface BindingRow {
  id: string; member_id: string; agent_id: string; agent_name: string; repo_path: string;
  runtime: string; session_key: string; created_at: string; presence_last_seen: string | null;
}
const ROSTER_ID = /^[a-zA-Z0-9:_-]{1,160}$/;

export class BotMembershipError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BotMembershipError'; }
}
export function membershipId(value: unknown): string {
  if (typeof value !== 'string' || !ROSTER_ID.test(value)) throw new BotMembershipError('invalid_id', 'A roster id must contain 1–160 letters, digits, colons, underscores or hyphens.');
  return value;
}
export function opaqueSourceId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new BotMembershipError('invalid_source', 'An existing source id is required.');
  return value;
}
function label(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new BotMembershipError('invalid_label', `${field} must contain 1–${limit} characters.`);
  return value.trim();
}

/** Read membership without refreshing discovery, changing presence or acknowledging inboxes. */
export function listBotMembers(sqlite: Database.Database = getSqlite(), now = Date.now()): BotMember[] {
  ensureV76BotMembershipSchema(sqlite);
  const members = sqlite.prepare('SELECT * FROM bot_members ORDER BY sequence').all() as MemberRow[];
  const sources = sqlite.prepare('SELECT source_id, member_id FROM bot_member_sources ORDER BY source_id').all() as Array<{ source_id: string; member_id: string }>;
  const hasPresence = Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_presence'").get());
  const bindings = sqlite.prepare(hasPresence ? `
    SELECT binding.*, presence.last_seen AS presence_last_seen FROM bot_member_bindings binding
    LEFT JOIN agent_presence presence ON presence.agent_id = binding.agent_id
      AND presence.repo_path = binding.repo_path AND presence.name = binding.agent_name COLLATE NOCASE
      AND presence.runtime = binding.runtime AND presence.session_key = binding.session_key
    ORDER BY binding.created_at, binding.id
  ` : 'SELECT *, NULL AS presence_last_seen FROM bot_member_bindings ORDER BY created_at, id').all() as BindingRow[];
  const byMember = new Map<string, BotMemberBinding[]>();
  for (const b of bindings) {
    const seen = Date.parse(b.presence_last_seen ?? '');
    const item: BotMemberBinding = { id: b.id, memberId: b.member_id, agentId: b.agent_id, agentName: b.agent_name,
      repo: b.repo_path, runtime: b.runtime, sessionKey: b.session_key, createdAt: b.created_at,
      live: Number.isFinite(seen) && now - seen <= AGENT_PRESENCE_TTL_MS };
    const list = byMember.get(b.member_id) ?? []; list.push(item); byMember.set(b.member_id, list);
  }
  return members.map(m => ({ id: m.id, house: m.house, name: m.display_name, iconKey: m.icon_key,
    homeThreadId: m.home_thread_id, createdAt: m.created_at, updatedAt: m.updated_at,
    sourceIds: sources.filter(s => s.member_id === m.id).map(s => s.source_id), bindings: byMember.get(m.id) ?? [] }));
}

export function getBotMember(id: string, sqlite: Database.Database = getSqlite()): BotMember | null {
  return listBotMembers(sqlite).find(m => m.id === id) ?? null;
}
function requireMember(id: string, sqlite: Database.Database): BotMember {
  const member = getBotMember(membershipId(id), sqlite);
  if (!member) throw new BotMembershipError('member_not_found', 'The local bot member does not exist.');
  return member;
}

export function createBotMember(input: { id?: string; house: string; name: string; iconKey?: string | null; homeThreadId?: string | null }, sqlite: Database.Database = getSqlite()): BotMember {
  ensureV76BotMembershipSchema(sqlite);
  const id = membershipId(input.id ?? `bot-${randomUUID()}`);
  const house = label(input.house, 'House', 40).toLowerCase();
  const name = label(input.name, 'Name', 80);
  const icon = input.iconKey == null ? null : label(input.iconKey, 'Icon', 40);
  const home = input.homeThreadId == null ? null : opaqueSourceId(input.homeThreadId);
  sqlite.transaction(() => {
    const existing = getBotMember(id, sqlite);
    if (existing) {
      if (existing.house !== house || existing.name !== name || existing.iconKey !== icon || existing.homeThreadId !== home) throw new BotMembershipError('member_exists', 'That member already exists. Rename or configure it explicitly.');
      return;
    }
    if (sqlite.prepare('SELECT 1 FROM bot_member_sources WHERE source_id = ?').get(id)) throw new BotMembershipError('source_conflict', 'That roster id already identifies another member.');
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO bot_members(id,house,display_name,icon_key,home_thread_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, house, name, icon, home, now, now);
  }).immediate();
  return requireMember(id, sqlite);
}

export function renameBotMember(id: string, name: string, sqlite: Database.Database = getSqlite()): BotMember {
  requireMember(id, sqlite);
  sqlite.prepare('UPDATE bot_members SET display_name = ?, updated_at = ? WHERE id = ?')
    .run(label(name, 'Name', 80), new Date().toISOString(), id);
  return requireMember(id, sqlite);
}

export function setBotMemberHome(id: string, threadId: string | null, sqlite: Database.Database = getSqlite()): BotMember {
  requireMember(id, sqlite);
  sqlite.prepare('UPDATE bot_members SET home_thread_id = ?, updated_at = ? WHERE id = ?')
    .run(threadId === null ? null : opaqueSourceId(threadId), new Date().toISOString(), id);
  return requireMember(id, sqlite);
}

/** Explicitly bind an already-recorded session. Its names and source IDs stay intact. */
export function bindBotMemberSession(id: string, agentId: string, sqlite: Database.Database = getSqlite()): BotMember {
  requireMember(id, sqlite);
  const source = findAgentPresence({ agentId: opaqueSourceId(agentId) }, sqlite);
  if (!source?.sessionKey?.trim()) throw new BotMembershipError('session_not_found', 'Bind an existing local agent presence with a session key.');
  sqlite.transaction(() => {
    const prior = sqlite.prepare('SELECT * FROM bot_member_bindings WHERE repo_path = ? AND runtime = ? AND session_key = ?')
      .get(source.repo, source.runtime, source.sessionKey) as BindingRow | undefined;
    if (prior) {
      if (prior.member_id !== id) throw new BotMembershipError('session_bound', 'That repository/session is already bound to another member.');
      if (prior.agent_id !== source.agentId || prior.agent_name !== source.name) throw new BotMembershipError('binding_changed', 'The stored source changed. Unbind it before explicitly binding the replacement.');
      return;
    }
    sqlite.prepare(`INSERT INTO bot_member_bindings(id,member_id,agent_id,agent_name,repo_path,runtime,session_key,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(`binding-${randomUUID()}`, id, source.agentId, source.name, source.repo,
      source.runtime, source.sessionKey, new Date().toISOString());
  }).immediate();
  return requireMember(id, sqlite);
}

export function unbindBotMemberSession(id: string, bindingId: string, sqlite: Database.Database = getSqlite()): BotMember {
  requireMember(id, sqlite);
  sqlite.prepare('DELETE FROM bot_member_bindings WHERE member_id = ? AND id = ?').run(id, opaqueSourceId(bindingId));
  return requireMember(id, sqlite);
}

/** A presentation alias for an existing provider/configuration ID, never a bus address. */
export function linkBotMemberSource(id: string, sourceId: string, sqlite: Database.Database = getSqlite()): BotMember {
  requireMember(id, sqlite); membershipId(sourceId);
  sqlite.transaction(() => {
    if (sourceId === id) return;
    if (getBotMember(sourceId, sqlite)) throw new BotMembershipError('source_conflict', 'That roster id already identifies another member.');
    const prior = sqlite.prepare('SELECT member_id FROM bot_member_sources WHERE source_id = ?').get(sourceId) as { member_id: string } | undefined;
    if (prior && prior.member_id !== id) throw new BotMembershipError('source_conflict', 'That source is already linked to another member.');
    sqlite.prepare('INSERT OR IGNORE INTO bot_member_sources(source_id,member_id) VALUES (?,?)').run(sourceId, id);
  }).immediate();
  return requireMember(id, sqlite);
}
