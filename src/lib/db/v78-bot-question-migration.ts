import type Database from 'better-sqlite3';
import { ensureV77BotNetworkThreadSchema } from './v77-bot-network-thread-migration';

/** Question purpose and correlation are durable; the existing bus owns question/answer text. */
export function ensureV78BotQuestionSchema(sqlite: Database.Database): void {
  ensureV77BotNetworkThreadSchema(sqlite);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS bot_network_questions (
    id TEXT PRIMARY KEY,
    bus_request_id TEXT NOT NULL UNIQUE,
    binding_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE REFERENCES bot_network_threads(thread_id),
    question_message_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`);
}
