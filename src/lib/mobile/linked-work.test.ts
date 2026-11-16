import { beforeEach, describe, expect, it, vi } from 'vitest';
const { all, prepare } = vi.hoisted(() => {
  const all = vi.fn(); return { all, prepare: vi.fn((_sql: string) => ({ all })) };
});
vi.mock('@/lib/db', () => ({ getSqlite: () => ({ prepare }) }));
import Database from 'better-sqlite3';
import { lookupLinkedWork } from './linked-work';
const link = { threadId: 'a', repositoryId: 1, pullRequestId: 1, state: 'OPEN', mergedAt: null, branch: 'feature', repositoryName: 'org/repo' };
beforeEach(() => { vi.clearAllMocks(); all.mockReturnValue([]); });
describe('linked work', () => {
  it('batches all threads in one bound query, deduplicates links and projects counts', () => {
    all.mockReturnValue([link, { ...link }, { ...link, pullRequestId: 2, state: 'CLOSED', mergedAt: 'date' },
      { ...link, pullRequestId: 3, state: 'CLOSED', branch: 'other' }]);
    const result = lookupLinkedWork([{ id: 'a', repoBranch: 'feature', githubOwner: 'org', githubRepo: 'repo' }, { id: 'b' }]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain('WHERE c.thread_id IN (?,?)');
    expect(all).toHaveBeenCalledExactlyOnceWith('a', 'b');
    expect(result.get('a')).toEqual({ pullRequests: { total: 3, open: 1, merged: 1, closed: 1 }, branches: 2 });
    expect(result.get('b')).toBeNull();
    expect(JSON.stringify([...result.values()])).not.toMatch(/org|feature|repository|threadId|date/);
  });
  it('omits state counts when the mirror is missing or unknown', () => {
    all.mockReturnValue([{ ...link, state: null, branch: null }]);
    expect(lookupLinkedWork([{ id: 'a' }]).get('a')).toEqual({ pullRequests: { total: 1 }, branches: 0 });
  });
  it('counts a stored thread branch without PR links', () => {
    expect(lookupLinkedWork([{ id: 'a', repoBranch: 'feature' }]).get('a')).toEqual({ pullRequests: { total: 0, open: 0, merged: 0, closed: 0 }, branches: 1 });
  });
  it('does not query empty lists and preserves null on storage failure', () => {
    expect(lookupLinkedWork([]).size).toBe(0); expect(prepare).not.toHaveBeenCalled();
    all.mockImplementationOnce(() => { throw new Error('unavailable'); });
    expect(lookupLinkedWork([{ id: 'a' }]).get('a')).toBeNull();
  });
  it('executes the batch join against local tables with immutable identity matching', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE conversation_pr_context (thread_id TEXT, repository_id INTEGER, pull_request_id INTEGER, number INTEGER, repository_name TEXT);
        CREATE TABLE github_pull_requests (repository_id INTEGER, pull_request_id INTEGER, number INTEGER, state TEXT, merged_at TEXT, head_ref_name TEXT);
        INSERT INTO conversation_pr_context VALUES ('a',1,10,7,'org/repo'), ('a',1,10,7,'org/repo'), ('b',2,20,8,'org/other');
        INSERT INTO github_pull_requests VALUES (1,10,7,'OPEN',NULL,'feature'), (99,20,8,'CLOSED','date','wrong-repo');`);
      all.mockImplementationOnce((...ids: string[]) => db.prepare(prepare.mock.calls[0][0]).all(...ids));
      const result = lookupLinkedWork([{ id: 'a' }, { id: 'b' }]);
      expect(result.get('a')).toEqual({ pullRequests: { total: 1, open: 1, merged: 0, closed: 0 }, branches: 1 });
      expect(result.get('b')).toEqual({ pullRequests: { total: 1 }, branches: 0 });
    } finally { db.close(); }
  });

});
