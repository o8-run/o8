import { expect, it } from 'vitest';
import { closeDb, getSqlite } from '@/lib/db';
import { beginPrWatchRead, recordOwnPrRemark, recordPrWatchSnapshot } from './pr-watch';
const snapshot = { scope: 'fixture-scope', repo: 'example/watch', number: 1, head: 'a'.repeat(40), state: 'open', checks: [], comments: [], reviews: [] };

it('persists a baseline through reconnect and deduplicates unchanged, equal-timestamp and own comments', () => {
  expect(recordPrWatchSnapshot(snapshot).changes).toEqual([]);
  closeDb(); expect(recordPrWatchSnapshot(snapshot).changes).toEqual([]);
  const comment = { id: 100, author: 'fixture', body: 'First' };
  expect(recordPrWatchSnapshot({ ...snapshot, comments: [comment] }).changes).toEqual(['comments']);
  recordOwnPrRemark(snapshot.scope, snapshot.repo, 1, 'comments', 101);
  expect(recordPrWatchSnapshot({ ...snapshot, comments: [comment, { ...comment, id: 101, body: 'Own reply' }] }).changes).toEqual([]);
  expect(recordPrWatchSnapshot({ ...snapshot, comments: [comment, { ...comment, id: 102 }] }).changes).toEqual(['comments']);
  expect(recordPrWatchSnapshot({ ...snapshot, comments: [{ ...comment, body: 'Edited' }, { ...comment, id: 102 }] }).changes).toEqual(['comments']);
  const fourth = recordPrWatchSnapshot({ ...snapshot, comments: [{ ...comment, body: 'Another edit' }] });
  expect(fourth.changes).toEqual([]); expect(fourth.commentUpdatesPaused).toBe(true);
  expect(recordPrWatchSnapshot({ ...snapshot, head: 'b'.repeat(40) }).commentUpdatesPaused).toBe(false);
  expect(recordPrWatchSnapshot({ ...snapshot, scope: 'new-credential' }).changes).toEqual([]);
});
it('records one source event, keeps unknown data distinct, and resumes on meaningful changes', () => {
  const input = { ...snapshot, number: 2, repoPath: '/fixture/watch' };
  // Source events are kept only while a watch reads the source.
  getSqlite().prepare(`INSERT INTO automations (id, name, owner, repo_path, runtime, prompt, trigger_kind, watch_source_kind)
    VALUES ('watch-repository', 'watch', 'fixture', '/fixture/watch', 'codex', 'fixture', 'watch', 'repository')`).run();
  recordPrWatchSnapshot(input);
  expect(recordPrWatchSnapshot({ ...input, checks: [{ name: 'test', status: 'failed' }] }).changes).toEqual(['checks']);
  expect(recordPrWatchSnapshot({ ...input, checksUnavailable: true, discussionIncomplete: true }).changes).toEqual([]);
  expect(recordPrWatchSnapshot({ ...input, checks: [{ name: 'test', status: 'failed' }] }).changes).toEqual([]);
  const row = getSqlite().prepare("SELECT COUNT(*) AS count FROM automation_source_events WHERE repo_path='/fixture/watch'").get() as { count: number };
  expect(row.count).toBe(1);
});
it('rejects an older completion and rebases newly identified own remarks without a deletion wake', () => {
  const input = { ...snapshot, number: 3 };
  recordPrWatchSnapshot(input);
  const oldRead = beginPrWatchRead(); const newRead = beginPrWatchRead();
  expect(recordPrWatchSnapshot({ ...input, head: 'b'.repeat(40), readOrder: newRead }).changes).toEqual(['head']);
  expect(recordPrWatchSnapshot({ ...input, readOrder: oldRead }).superseded).toBe(true);
  expect(recordPrWatchSnapshot({ ...input, head: 'b'.repeat(40) }).changes).toEqual([]);
  recordPrWatchSnapshot({ ...input, head: 'b'.repeat(40), comments: [{ id: 201, author: 'fixture', body: 'Own reply' }] });
  recordOwnPrRemark(input.scope, input.repo, 3, 'comments', 201);
  expect(recordPrWatchSnapshot({ ...input, head: 'b'.repeat(40), comments: [{ id: 201, author: 'fixture', body: 'Own reply' }] }).changes).toEqual([]);
});
