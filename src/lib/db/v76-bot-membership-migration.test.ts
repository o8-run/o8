import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ensureV76BotMembershipSchema } from './v76-bot-membership-migration';
import { ensureAgentBusSchema } from '@/lib/agents/store';

it('creates membership on an empty direct store and repeats without changing legacy data', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE agent_presence(agent_id TEXT PRIMARY KEY, repo_path TEXT, name TEXT);
      CREATE TABLE agent_messages(id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT);
      CREATE TABLE agent_inbox_state(repo_path TEXT, agent_name TEXT, acknowledged_sequence INTEGER);
      INSERT INTO agent_presence VALUES ('source:id:full','/repo','Original');
      INSERT INTO agent_messages VALUES ('message:id:full','Original','Peer');
      INSERT INTO agent_inbox_state VALUES ('/repo','Original',42);`);
    const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'agent_%' ORDER BY name").all();
    ensureV76BotMembershipSchema(db);
    db.prepare(`INSERT INTO bot_members(id,house,display_name,created_at,updated_at) VALUES ('bot-a','claude','A','before','before')`).run();
    ensureV76BotMembershipSchema(db);
    expect(db.prepare('SELECT id,display_name FROM bot_members').all()).toEqual([{ id: 'bot-a', display_name: 'A' }]);
    expect(db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'agent_%' ORDER BY name").all()).toEqual(before);
    expect(db.prepare('SELECT * FROM agent_presence').all()).toEqual([{ agent_id: 'source:id:full', repo_path: '/repo', name: 'Original' }]);
    expect(db.prepare('SELECT * FROM agent_messages').all()).toEqual([{ id: 'message:id:full', from_agent: 'Original', to_agent: 'Peer' }]);
    expect(db.prepare('SELECT * FROM agent_inbox_state').all()).toEqual([{ repo_path: '/repo', agent_name: 'Original', acknowledged_sequence: 42 }]);
  } finally { db.close(); }
});

it('also installs membership through the existing agent store lazy initializer', () => {
  const db = new Database(':memory:');
  try {
    ensureAgentBusSchema(db);
    ensureAgentBusSchema(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bot_%' ORDER BY name").all())
      .toEqual([{ name: 'bot_member_bindings' }, { name: 'bot_member_sources' }, { name: 'bot_members' }]);
  } finally { db.close(); }
});
