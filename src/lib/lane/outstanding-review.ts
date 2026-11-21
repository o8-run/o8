import { getSqlite } from '@/lib/db';

/**
 * A lane in review can be merged on the remote at any time. Watchers of remote
 * merges keep running at rest while one exists, and pause when none does.
 */
export function hasOutstandingReview(): boolean {
  return Boolean(getSqlite().prepare("SELECT 1 FROM lanes WHERE status = 'reviewing' LIMIT 1").get());
}
