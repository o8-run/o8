import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyLocalBotMembershipCommand as command } from './bot-membership-commands';
import { getBotMember, listBotMembers } from './bot-membership-store';
import { AGENT_PRESENCE_TTL_MS, getAgentInboxCursor, listRecentAgentMessages, persistAgentMessage, upsertAgentPresence } from './store';

let root: string;
let db: Database.Database;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'o8-member-store-')); db = new Database(join(root, 'members.db')); db.pragma('foreign_keys = ON'); });
afterEach(() => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); });

function source(agentId = 'source-one', sessionKey = 'claude:session-one', repo = join(root, 'repo'), name = 'SourceOne') {
  return upsertAgentPresence({ agentId, name, repo, runtime: 'claude-code', sessionKey,
    worktreePath: null, laneId: null, packetId: null, lastSeen: new Date().toISOString() }, db);
}
function create(id = 'bot-a', name = 'A') { command({ action: 'create', id, house: 'claude', name }, db); }

it('never enrolls presence implicitly and binds two existing sessions to one durable member', () => {
  source(); source('source-two', 'claude:session-two', join(root, 'repo'), 'SourceTwo');
  expect(listBotMembers(db)).toEqual([]);
  create(); command({ action: 'bind', memberId: 'bot-a', agentId: 'source-one' }, db);
  command({ action: 'bind', memberId: 'bot-a', agentId: 'source-two' }, db);
  const member = getBotMember('bot-a', db)!;
  expect(member.bindings.map(b => b.sessionKey).sort()).toEqual(['claude:session-one', 'claude:session-two']);
  expect(member.bindings.every(b => b.live)).toBe(true);
  command({ action: 'bind', memberId: 'bot-a', agentId: 'source-one' }, db);
  command({ action: 'create', id: 'bot-a', house: 'claude', name: 'A' }, db);
  expect(getBotMember('bot-a', db)).toEqual(member);
  db.close(); db = new Database(join(root, 'members.db'));
  expect(getBotMember('bot-a', db)).toEqual(member);
});

it('expires or disconnects presence without deleting membership or binding provenance', () => {
  source(); create(); command({ action: 'bind', memberId: 'bot-a', agentId: 'source-one' }, db);
  const before = getBotMember('bot-a', db)!;
  expect(listBotMembers(db, Date.now() + AGENT_PRESENCE_TTL_MS + 1)[0].bindings[0].live).toBe(false);
  db.exec('DELETE FROM agent_presence');
  expect(getBotMember('bot-a', db)).toEqual({ ...before, bindings: before.bindings.map(b => ({ ...b, live: false })) });
  db.close(); db = new Database(join(root, 'members.db'));
  expect(getBotMember('bot-a', db)?.bindings[0].sessionKey).toBe('claude:session-one');
  expect(listBotMembers(db)).toHaveLength(1);
});

it('renames only presentation while full source IDs, message authors and inbox cursors remain intact', () => {
  const agentId = `agent:${'a'.repeat(220)}`;
  const sessionKey = `claude:${'session:'.repeat(90)}`;
  const author = source(agentId, sessionKey); create();
  command({ action: 'bind', memberId: 'bot-a', agentId }, db);
  command({ action: 'source', memberId: 'bot-a', sourceId: 'claude:original' }, db);
  const before = getBotMember('bot-a', db)!;
  const message = persistAgentMessage({ from: 'SourceOne', to: 'Peer', repo: join(root, 'repo'), text: 'Existing bus message',
    refs: { laneId: null, packetId: null, identities: { from: { runtime: 'claude-code', sessionKey }, to: null } }, requestId: 'existing-request-id' }, db).message;
  db.prepare('INSERT INTO agent_inbox_state(repo_path,agent_name,acknowledged_sequence) VALUES (?,?,?)').run(join(root, 'repo'), 'SourceOne', 42);
  command({ action: 'rename', memberId: 'bot-a', name: 'Renamed display' }, db);
  const after = getBotMember('bot-a', db)!;
  expect(after.id).toBe(before.id); expect(after.name).toBe('Renamed display');
  expect(after.bindings).toEqual(before.bindings); expect(after.sourceIds).toEqual(before.sourceIds);
  expect(after.bindings[0].agentId).toBe(agentId); expect(after.bindings[0].sessionKey).toBe(sessionKey);
  expect(listRecentAgentMessages(join(root, 'repo'), 10, db)[0]).toEqual(message);
  expect(getAgentInboxCursor(author, db)).toBe(42);
  expect(db.prepare('SELECT agent_id,name,session_key FROM agent_presence').get()).toEqual({ agent_id: agentId, name: 'SourceOne', session_key: sessionKey });
});

it('does not follow a stale presence ID into a replacement session', () => {
  const original = source(); create(); command({ action: 'bind', memberId: 'bot-a', agentId: original.agentId }, db);
  const binding = getBotMember('bot-a', db)!.bindings[0];
  db.prepare('UPDATE agent_presence SET last_seen=?').run(new Date(Date.now() - AGENT_PRESENCE_TTL_MS - 1).toISOString());
  source(original.agentId, 'claude:replacement');
  expect(getBotMember('bot-a', db)!.bindings[0]).toEqual({ ...binding, live: false });
});

it('keeps repository delivery contexts explicit without changing legacy name uniqueness', () => {
  source('a', 'same-session', join(root, 'one'), 'SameName');
  source('b', 'same-session', join(root, 'two'), 'SameName');
  create(); command({ action: 'bind', memberId: 'bot-a', agentId: 'a' }, db);
  command({ action: 'bind', memberId: 'bot-a', agentId: 'b' }, db);
  expect(getBotMember('bot-a', db)!.bindings.map(b => b.repo).sort()).toEqual([join(root, 'one'), join(root, 'two')]);
  expect(() => source('c', 'different', join(root, 'one'), 'SameName')).toThrow(/UNIQUE/);
});

it('rejects missing sessions, conflicting session owners and ambiguous source aliases', () => {
  create(); create('bot-b', 'B');
  expect(() => command({ action: 'bind', memberId: 'bot-a', agentId: 'absent' }, db)).toThrow(/existing local agent/);
  source(); command({ action: 'bind', memberId: 'bot-a', agentId: 'source-one' }, db);
  expect(() => command({ action: 'bind', memberId: 'bot-b', agentId: 'source-one' }, db)).toThrow(/already bound/);
  command({ action: 'source', memberId: 'bot-a', sourceId: 'claude:original' }, db);
  expect(() => command({ action: 'source', memberId: 'bot-b', sourceId: 'claude:original' }, db)).toThrow(/already linked/);
  expect(() => command({ action: 'source', memberId: 'bot-a', sourceId: 'bot-b' }, db)).toThrow(/another member/);
  expect(() => command({ action: 'create', id: 'claude:original', house: 'claude', name: 'Wrong' }, db)).toThrow(/another member/);
  const binding = getBotMember('bot-a', db)!.bindings[0];
  command({ action: 'unbind', memberId: 'bot-a', bindingId: binding.id }, db);
  expect(getBotMember('bot-a', db)?.bindings).toEqual([]);
});
