import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-network-inbox-race-'));
const repo = join(root, 'repo'); mkdirSync(repo);
const dbPath = join(root, 'network.db');
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: dbPath });
const { getSqlite, closeDb } = await import('@/lib/db');
const { upsertAgentPresence } = await import('@/lib/agents/store');
const { applyLocalBotMembershipCommand: membership } = await import('@/lib/agents/bot-membership-commands');
const { checkNetworkMcpInbox } = await import('@/lib/bots/network-mcp-service');
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

it('fences exact binding validation and inbox acknowledgement against a second real SQLite writer', () => {
  upsertAgentPresence({ agentId: 'race-source', name: 'OriginalSession', repo, runtime: 'scripted-mcp',
    sessionKey: 'scripted-local:race', worktreePath: null, laneId: null, packetId: null,
    lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
  membership({ action: 'create', id: 'race-member', house: 'scripted-local', name: 'Race member' });
  const member = membership({ action: 'bind', memberId: 'race-member', agentId: 'race-source' });
  if (Array.isArray(member)) throw new Error('Expected a member');
  const sqlite = getSqlite();
  const other = new Database(dbPath, { timeout: 0 });
  const originalDescriptor = Object.getOwnPropertyDescriptor(sqlite, 'prepare');
  const prepare = sqlite.prepare.bind(sqlite);
  let attempted = false;
  let blocked = false;
  // A deterministic scheduling barrier, with real SELECT, UPDATE and transaction locks.
  Object.defineProperty(sqlite, 'prepare', { configurable: true, value: (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT * FROM agent_presence WHERE agent_id = ?') && !attempted) {
      const get = statement.get.bind(statement);
      Object.defineProperty(statement, 'get', { value: (...args: unknown[]) => {
        const selected = get(...args);
        if (!attempted) {
          attempted = true;
          try { other.prepare("UPDATE agent_presence SET name = 'ReplacementSession' WHERE agent_id = 'race-source'").run(); }
          catch (error) { blocked = (error as { code?: string }).code === 'SQLITE_BUSY'; }
        }
        return selected;
      } });
    }
    return statement;
  } });
  try {
    const page = checkNetworkMcpInbox(member.bindings[0].id, {});
    expect(attempted).toBe(true);
    expect(blocked).toBe(true);
    expect(page.messages).toEqual([]);
    expect(prepare('SELECT name FROM agent_presence WHERE agent_id = ?').get('race-source')).toEqual({ name: 'OriginalSession' });
  } finally {
    if (originalDescriptor) Object.defineProperty(sqlite, 'prepare', originalDescriptor);
    else Reflect.deleteProperty(sqlite, 'prepare');
    other.close();
  }
});
