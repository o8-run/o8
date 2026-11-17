import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { cancelAutomationFires } from './fire-store';

export function listAutomationRows() {
  const db = getDb();
  if (!db) throw new Error('db unavailable');
  return db.select().from(automations).orderBy(desc(automations.createdAt)).all();
}

export function updateAutomationRow(id: string, patch: Partial<typeof automations.$inferInsert>) {
  const db = getDb();
  if (!db) throw new Error('db unavailable');
  if (!db.select().from(automations).where(eq(automations.id, id)).get()) return null;
  db.update(automations).set(patch).where(eq(automations.id, id)).run();
  if (patch.enabled === false) cancelAutomationFires(id);
  return db.select().from(automations).where(eq(automations.id, id)).get() ?? null;
}
