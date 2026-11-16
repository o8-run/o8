import type Database from 'better-sqlite3';
import { addColumnTolerant, tableColumnExists } from './schema-columns';

/** Retain revoked credentials and add pairing timestamps to existing installs. */
export function ensureMobileDeviceSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mobile_devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      device_label TEXT,
      identity_public_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_devices_token_hash ON mobile_devices(token_hash);
  `);
  if (!tableColumnExists(sqlite, 'mobile_devices', 'last_paired_at')) {
    addColumnTolerant(sqlite, 'ALTER TABLE mobile_devices ADD COLUMN last_paired_at TEXT');
  }
}
