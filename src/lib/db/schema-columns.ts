import type Database from 'better-sqlite3';

export function tableColumnExists(sqlite: Database.Database, tableName: string, columnName: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

/**
 * Run an ADD COLUMN statement, tolerating "duplicate column name".
 *
 * Three processes open this DB and run the column-add path at boot (Next
 * server, ws-server, compactor). The `tableColumnExists` check-then-ALTER is
 * a cross-process TOCTOU: both can observe "missing", and the loser's ALTER
 * throws out of getDb(), leaving that process with no DB. A duplicate-column
 * error means the column exists — exactly the desired end state.
 */
export function addColumnTolerant(sqlite: Database.Database, sql: string): void {
  try {
    sqlite.exec(sql);
  } catch (err) {
    if (err instanceof Error && /duplicate column name/i.test(err.message)) return;
    throw err;
  }
}
