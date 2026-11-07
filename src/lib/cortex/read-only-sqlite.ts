import Database from 'better-sqlite3';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import type * as NodeSqlite from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export interface ReadOnlySqlite {
  prepare(sql: string): { get(): unknown; all(): unknown[] };
  close(): void;
}

/** Byte 18 of the header is 2 when the file is in WAL mode. */
function isWalFile(path: string): boolean {
  const header = Buffer.alloc(20);
  const fd = openSync(path, 'r');
  try {
    return readSync(fd, header, 0, header.length, 0) === header.length && header[18] === 2;
  } finally {
    closeSync(fd);
  }
}

let nodeSqlite: typeof NodeSqlite | undefined;

/** Load node:sqlite on first use without its one-time ExperimentalWarning on stderr. */
function loadNodeSqlite(): typeof NodeSqlite {
  if (nodeSqlite) return nodeSqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    nodeSqlite = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;
    return nodeSqlite;
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Open a SQLite file for a GET without creating anything beside it. A
 * read-only connection to a WAL file creates -wal/-shm, and fails in a
 * read-only dir. With no -wal there is no open WAL connection anywhere, so
 * an immutable node:sqlite read is safe; otherwise stay on better-sqlite3 so
 * one SQLite library owns this process's locks on the file.
 */
export function openSqliteForRead(path: string): ReadOnlySqlite {
  if (!existsSync(`${path}-wal`) && isWalFile(path)) {
    const url = pathToFileURL(path);
    url.searchParams.set('immutable', '1');
    return new (loadNodeSqlite().DatabaseSync)(url, { readOnly: true });
  }
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.pragma('busy_timeout = 1000');
  return database;
}
