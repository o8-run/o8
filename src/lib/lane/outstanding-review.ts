import { getSqlite } from '@/lib/db';

/**
 * A lane in review can be merged on the remote at any time. Watchers of remote
 * merges keep running at rest while one exists, and pause when none does.
 */
export function hasOutstandingReview(): boolean {
  return Boolean(getSqlite().prepare("SELECT 1 FROM lanes WHERE status = 'reviewing' LIMIT 1").get());
}

/** The first lane that keeps the server awake, as `lane <status>`; settled and reviewing lanes do not. */
export function laneBlockingIdle(): string | null {
  const row = getSqlite().prepare(
    "SELECT status FROM lanes WHERE status IN ('launching', 'running', 'merging') LIMIT 1",
  ).get() as { status: string } | undefined;
  return row ? `lane ${row.status}` : null;
}

export function hasLaneBlockingIdle(): boolean {
  return laneBlockingIdle() !== null;
}
