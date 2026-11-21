import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { GET } from '@/app/api/lanes/route';
import { getSqlite } from '@/lib/db';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { Lane } from '@/lib/lane/types';

it('lists persisted lane fields and filters archived lanes without SQLite row copies', async () => {
  const db = getSqlite();
  const insert = db.prepare(`
    INSERT INTO lanes (id, label, repo_path, branch, base_branch, runtime, pr_number,
      status, ownership, created_at, updated_at)
    VALUES (?, ?, '/fixture/repo', 'fixture-branch', 'main', 'cloud', ?, ?, 'managed', ?, ?)
  `);
  insert.run('lane-live-fixture', 'Live fixture', 7, 'idle', '2026-01-01', '2026-01-01');
  insert.run('lane-archived-fixture', 'Archived fixture', null, 'archived', '2026-01-02', '2026-01-02');
  const statement = db.prepare('SELECT 1');
  const rawRows = vi.spyOn(Object.getPrototypeOf(statement) as typeof statement, 'raw');
  const token = getOrCreateWsToken();

  async function readLanes(query = '') {
    const response = await GET(new NextRequest('http://localhost/api/lanes' + query, {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(200);
    return (await response.json() as { lanes: Lane[] }).lanes;
  }

  try {
    const active = await readLanes();
    expect(active.map(lane => lane.id)).toEqual(['lane-live-fixture']);
    expect(active[0]).toMatchObject({
      label: 'Live fixture', repoPath: '/fixture/repo', baseBranch: 'main',
      prNumber: 7, worktreePath: null, status: 'idle',
    });
    const all = await readLanes('?active=false');
    expect(all.map(lane => lane.id)).toEqual(['lane-live-fixture', 'lane-archived-fixture']);
    expect(all[1]).toMatchObject({ status: 'archived', prNumber: null });
    const positionalLaneReads = rawRows.mock.instances.filter(row =>
      /from\s+"lanes"(?=\s|$)/i.test((row as typeof statement).source),
    );
    expect(positionalLaneReads).toHaveLength(0);
  } finally {
    rawRows.mockRestore();
  }
});
