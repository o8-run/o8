import { getSqlite } from '@/lib/db';

export const REVIEW_SCHEDULING_KEY = 'review_scheduling/v1';
export interface ReviewSchedulingService { sequence: number; projects: Record<string, number> }

export function readReviewSchedulingService(): ReviewSchedulingService {
  const row = getSqlite().prepare('SELECT value FROM app_state WHERE key = ?').get(REVIEW_SCHEDULING_KEY) as { value: string } | undefined;
  if (!row) return { sequence: 0, projects: Object.create(null) };
  const service = JSON.parse(row.value) as ReviewSchedulingService;
  if (!service || !Number.isSafeInteger(service.sequence) || service.sequence < 0 || !service.projects
    || typeof service.projects !== 'object' || Array.isArray(service.projects)
    || Object.values(service.projects).some(n => !Number.isSafeInteger(n) || n < 0 || n > service.sequence)) {
    throw new Error('Review scheduling state is unreadable; operator inspection is required.');
  }
  return { sequence: service.sequence, projects: Object.assign(Object.create(null), service.projects) };
}
