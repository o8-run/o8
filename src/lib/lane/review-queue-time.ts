/** SQLite datetime('now') is UTC despite lacking a zone suffix. Lane timestamps
 * may instead be ISO strings with an explicit offset. Never use server timezone. */
export function reviewQueueTime(value: string): number {
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}
