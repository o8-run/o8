import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyLocalBotMembershipCommand as command } from '@/lib/agents/bot-membership-commands';
import { upsertAgentPresence, AGENT_PRESENCE_TTL_MS } from '@/lib/agents/store';
import { findRosterBot, listRosterBots } from './roster';
import type { BotEntry, BotProvider } from './registry';

let db: Database.Database;
let root: string;
beforeEach(() => { db = new Database(':memory:'); root = mkdtempSync(join(tmpdir(), 'o8-roster-')); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
const entry = (id: string, name: string): BotEntry => ({ id, name, house: 'grok', icon: { key: 'grok' },
  mainThread: { kind: 'mailbox', id: 'same-mailbox' }, status: 'online' });

it('retains configured/provider ordering and deduplicates explicit aliases across adapters', () => {
  const provider: BotProvider = { house: 'grok', list: () => [entry('provider:member', 'Beta'), entry('provider:other', 'Alpha')] };
  writeFileSync(join(root, 'bots.json'), JSON.stringify({ bots: [entry('configured:other', 'Static'), entry('configured:member', 'Other adapter')] }));
  command({ action: 'create', id: 'bot-main', house: 'grok', name: 'Durable name' }, db);
  command({ action: 'create', id: 'bot-extra', house: 'o8', name: 'Extra' }, db);
  command({ action: 'source', memberId: 'bot-main', sourceId: 'provider:member' }, db);
  command({ action: 'source', memberId: 'bot-main', sourceId: 'configured:member' }, db);
  const bots = listRosterBots([provider], root, db);
  expect(bots.map(b => b.id)).toEqual(['provider:other', 'bot-main', 'configured:other', 'bot-extra']);
  expect(bots[1]).toEqual({ ...entry('bot-main', 'Durable name') });
  expect(findRosterBot('configured:member', [provider], root, db)).toEqual(bots[1]);
  command({ action: 'rename', memberId: 'bot-main', name: 'A new name' }, db);
  expect(listRosterBots([provider], root, db).map(b => b.id)).toEqual(bots.map(b => b.id));
  expect(listRosterBots([], root, db).map(b => b.id)).toEqual(['configured:other', 'bot-main', 'bot-extra']);
});

it('keeps a full explicit home reference and derives liveness only from matching local bindings', () => {
  const home = `thoughts-${'x'.repeat(220)}`;
  command({ action: 'create', id: 'bot-main', house: 'claude', name: 'Same name', homeThreadId: home }, db);
  command({ action: 'create', id: 'bot-other', house: 'claude', name: 'Same name' }, db);
  upsertAgentPresence({ agentId: 'source', name: 'Source', repo: root, runtime: 'claude-code', sessionKey: 'session',
    worktreePath: null, laneId: null, packetId: null, lastSeen: new Date().toISOString() }, db);
  command({ action: 'bind', memberId: 'bot-main', agentId: 'source' }, db);
  expect(listRosterBots([], root, db).map(b => b.status)).toEqual(['online', 'unknown']);
  expect(listRosterBots([], root, db)[0].mainThread).toEqual({ kind: 'o8-thread', id: home });
  db.prepare('UPDATE agent_presence SET last_seen=?').run(new Date(Date.now() - AGENT_PRESENCE_TTL_MS - 1).toISOString());
  expect(listRosterBots([], root, db).map(b => b.status)).toEqual(['offline', 'unknown']);
  db.exec('DELETE FROM agent_presence');
  expect(listRosterBots([], root, db)).toHaveLength(2);
});
