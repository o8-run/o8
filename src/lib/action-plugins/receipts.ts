import 'server-only';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '@/lib/data-dir-migration';
import { ActionPluginError } from './errors';
import type { GithubActionSource } from './source-storage';
import type { ActionState } from './state-storage';
import { inspectPluginTerminal } from './terminal-runtime';

export function actionPluginRoot(create: boolean) {
  let at = getDataDir();
  if (create && !existsSync(at)) mkdirSync(at, { recursive: true, mode: 0o700 });
  if (!lstatSync(at).isDirectory() || lstatSync(at).isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Invalid data directory.');
  for (const part of ['customizations', 'actions']) {
    at = path.join(at, part);
    if (create && !existsSync(at)) mkdirSync(at, { mode: 0o700 });
    if (!lstatSync(at).isDirectory() || lstatSync(at).isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Invalid action storage directory.');
  }
  return at;
}

export function openActionReceiptDb() {
  const file = path.join(actionPluginRoot(true), 'receipts.sqlite');
  let fd: number;
  try { fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new ActionPluginError('unsafe_path', 'Invalid receipt storage file.');
    throw error;
  }
  closeSync(fd);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ActionPluginError('unsafe_path', 'Invalid receipt storage file.');
  const database = new Database(file);
  database.exec('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, action_id TEXT NOT NULL, actor TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, stdout TEXT, stderr TEXT, error TEXT, source_metadata TEXT)');
  database.exec('CREATE TABLE IF NOT EXISTS terminal_receipts (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, receipt_json TEXT NOT NULL)');
  database.transaction(() => {
    const columns = database.prepare('PRAGMA table_info(receipts)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'source_metadata')) database.exec('ALTER TABLE receipts ADD COLUMN source_metadata TEXT');
    if (!columns.some((column) => column.name === 'state_metadata')) database.exec('ALTER TABLE receipts ADD COLUMN state_metadata TEXT');
  }).immediate();
  return database;
}
export function lifecycle<T>(action: (database: Database.Database) => T): T {
  const database = openActionReceiptDb();
  try { return database.transaction(() => action(database)).immediate(); }
  finally { database.close(); }
}

export type PluginTerminalReceipt = {
  id: string; pluginId: string; terminalId: string; revision: string; sessionName: string;
  label: string; workspaceRoot: string | null; source: GithubActionSource | null; state: ActionState | null;
  actor: 'local-operator'; startedAt: string; finishedAt: string | null;
  status: 'launching' | 'running' | 'exited' | 'ended' | 'stopped' | 'failed';
  exitCode: number | null; error: string | null;
};
export function readTerminalReceipts(database: Database.Database, pluginId?: string): PluginTerminalReceipt[] {
  const rows = (pluginId
    ? database.prepare('SELECT receipt_json FROM terminal_receipts WHERE plugin_id = ? ORDER BY rowid DESC').all(pluginId)
    : database.prepare('SELECT receipt_json FROM terminal_receipts ORDER BY rowid DESC').all()) as Array<{ receipt_json: string }>;
  return rows.map((row) => JSON.parse(row.receipt_json) as PluginTerminalReceipt);
}
export function saveTerminalReceipt(database: Database.Database, receipt: PluginTerminalReceipt) {
  database.prepare('INSERT INTO terminal_receipts (id, plugin_id, receipt_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET receipt_json = excluded.receipt_json')
    .run(receipt.id, receipt.pluginId, JSON.stringify(receipt));
  return receipt;
}
export function refreshTerminalReceipt(database: Database.Database, receipt: PluginTerminalReceipt) {
  if (!['launching', 'running', 'exited'].includes(receipt.status)) return receipt;
  try {
    const current = inspectPluginTerminal(receipt.sessionName);
    // Missing does not mean a pending launch has finished: the host may have
    // stopped before spawn, or another process may be between claim and spawn.
    // Only explicit Stop cancels this claim. Replays never execute it again.
    if (receipt.status === 'launching' && current.status === 'ended') return receipt;
    return saveTerminalReceipt(database, { ...receipt, ...current, error: null, finishedAt: current.status === 'running' ? null : receipt.finishedAt ?? new Date().toISOString() });
  } catch {
    return saveTerminalReceipt(database, { ...receipt, error: 'Terminal status is unavailable. The session remains reserved; retry inspection or stop it before launching again.' });
  }
}
export function pluginTerminalReceipts(pluginId?: string) {
  return lifecycle((database) => readTerminalReceipts(database, pluginId).map((receipt) => refreshTerminalReceipt(database, receipt)));
}
export function pluginTerminalSessionReferences() {
  if (!existsSync(path.join(getDataDir(), 'customizations', 'actions', 'receipts.sqlite'))) return [];
  return pluginTerminalReceipts().filter((receipt) => ['launching', 'running', 'exited'].includes(receipt.status)).map((receipt) => receipt.sessionName);
}
