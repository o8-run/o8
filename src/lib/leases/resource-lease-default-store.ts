import 'server-only';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { ResourceLeaseStore } from './resource-lease-service';

let defaultStore: ResourceLeaseStore | null = null;
let defaultSqlite: Database.Database | null = null;

export function getResourceLeaseStore(): ResourceLeaseStore {
  const sqlite = getSqlite();
  if (!defaultStore || defaultSqlite !== sqlite) {
    defaultSqlite = sqlite;
    defaultStore = new ResourceLeaseStore(sqlite);
  }
  return defaultStore;
}

export async function reconcileResourceLeasesAtStartup() {
  return getResourceLeaseStore().reconcileAll();
}
