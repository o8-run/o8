import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { getSqlite } from '@/lib/db';
import { GET } from '@/app/api/panel/analytics/route';

const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();
const day = 86400000;
beforeEach(() => {
  const db = getSqlite();
  db.exec('DELETE FROM lane_events; DELETE FROM approvals; DELETE FROM lanes; DELETE FROM missions; DELETE FROM worker_correction_deliveries; DELETE FROM worker_corrections;');
});
function lane(id: string, age = day) {
  getSqlite().prepare(`INSERT INTO lanes (id,label,repo_path,branch,base_branch,runtime,packet_id,status,ownership,created_at,updated_at)
    VALUES (?,?,'/fixture/repo',?,'main','codex',?,'reviewing','managed',?,?)`).run(id, `Change ${id}`, id, id, iso(-age), iso(-age));
}
function event(id: string, verb: string, offset: number, actor = 'system', payload = {}) {
  getSqlite().prepare('INSERT INTO lane_events (id,lane_id,verb,actor,payload_json,timestamp) VALUES (?,?,?,?,?,?)')
    .run(`${id}-${verb}-${offset}`, id, verb, actor, JSON.stringify(payload), iso(offset));
}
function review(id: string, approved: boolean, offset: number, findings: unknown[] = []) {
  const audit = [{ type: 'orchestrator_review', actor: 'orchestrator', timestamp: now + offset, approved, reviewedHeadSha: 'a'.repeat(40), findings }];
  getSqlite().prepare(`INSERT INTO approvals
    (id,source,runtime,agent,session_key,title,description,summary,tool_name,args_json,packet_id,lane_id,risk,status,created_at,updated_at,audit_json,fingerprint)
    VALUES (?,'runtime','codex','reviewer',?,'Review','','','orchestrator_review',?,?,?,'low','approved',?,?,?,?)`)
    .run(`${id}-${offset}`, id, JSON.stringify({ packetId: id, approved, reviewTurnOutcome: 'completed' }), id, id,
      now + offset, now + offset, JSON.stringify(audit), `${id}-${offset}`);
}
async function score(range = '7', source = 'all') {
  const response = await GET(new NextRequest(`http://localhost/api/panel/analytics?view=review&range=${range}&source=${source}&repoPath=/fixture/repo`));
  expect(response.status).toBe(200);
  return response.json();
}
it('projects receipts, medians, findings and drill-down membership through the production route', async () => {
  lane('clean'); review('clean', true, -day + 60000);
  event('clean', 'merge_dispatch_succeeded', -day + 180000, 'system', { reviewedHeadSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) });
  lane('repair');
  const finding = { file: 'a.ts', severity: 'bug', resolution: 'deferred', description: 'Wrong bound' };
  review('repair', false, -day + 60000, [finding]);
  review('repair', true, -day + 120000, [{ ...finding, resolution: 'fixed' }]);
  const body = await score();
  const metric = (id: string) => body.metrics.find((row: { id: string }) => row.id === id);
  expect(metric('without-person')).toMatchObject({ value: 1, display: '1 / 1 (100%)', changes: [expect.objectContaining({ id: 'clean' })] });
  expect(metric('severity-bug').value).toBe(1);
  expect(metric('finding-fixed').value).toBe(1);
  expect(metric('finding-open').value).toBe(0);
  expect(metric('rounds').value).toBe(1.5);
  expect(metric('second-look').changes.map((row: { id: string }) => row.id)).toEqual(['repair']);
  expect(metric('arrival-verdict').value).toBe(90000);
  expect(metric('verdict-merge').value).toBe(120000);
});
it('uses arrival cohorts for 7 days, 30 days and all, and excludes future records', async () => {
  lane('week'); review('week', true, -1000);
  lane('month', 20 * day); review('month', true, -1000);
  lane('old', 40 * day); review('old', true, -1000);
  lane('future', -day); review('future', true, day);
  lane('week-future', -day);
  getSqlite().prepare("UPDATE lanes SET packet_id='week' WHERE id='week-future'").run();
  for (const [range, count] of [['7', 1], ['30', 2], ['all', 3]] as const) {
    const changes = (await score(range)).metrics.find((row: { id: string }) => row.id === 'rounds').changes;
    expect(changes).toHaveLength(count);
    expect(changes.map((row: { id: string }) => row.id)).not.toContain('week-future');
  }
});
it('keeps unknown provenance and unavailable learning distinct from zero', async () => {
  lane('unknown'); review('unknown', true, -1000);
  const body = await score();
  expect(body.sources.find((row: { id: string }) => row.id === 'unknown').count).toBe(1);
  expect(body.metrics.find((row: { id: string }) => row.id === 'learned')).toMatchObject({ value: null, changes: [] });
  expect((await score('7', 'external')).metrics.find((row: { id: string }) => row.id === 'rounds').value).toBeNull();
});
it('does not call a human merge or an unreviewed merge autonomous', async () => {
  lane('human'); review('human', true, -2000);
  event('human', 'merge_dispatch_succeeded', -1000, 'user', { reviewedHeadSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) });
  lane('unreviewed'); event('unreviewed', 'merge_dispatch_succeeded', -1000, 'system', { mergeSha: 'b'.repeat(40) });
  const body = await score();
  expect(body.metrics.find((row: { id: string }) => row.id === 'without-person').value).toBe(0);
});
it('rejects invalid range and source without scanning usage histories', async () => {
  for (const query of ['range=8', 'range=7&source=guess']) {
    const response = await GET(new NextRequest(`http://localhost/api/panel/analytics?view=review&${query}`));
    expect(response.status).toBe(400);
  }
});
it('groups recorded escalations and only counts delivered correction handoffs', async () => {
  lane('rejected'); review('rejected', false, -3000); review('rejected', false, -2000);
  lane('start'); event('start', 'status_change', -1000, 'system', { eventLabel: 'launch_error' });
  lane('gate'); review('gate', true, -2000);
  getSqlite().prepare("UPDATE approvals SET tool_name='lane_merge',gate_result_json=? WHERE lane_id='gate'").run('{"passed":false}');
  const gateAudit = getSqlite().prepare("SELECT audit_json FROM approvals WHERE lane_id='gate'").get() as { audit_json: string };
  getSqlite().prepare("UPDATE approvals SET audit_json=? WHERE lane_id='gate'").run(JSON.stringify([...JSON.parse(gateAudit.audit_json), { type: 'approved', actor: 'desktop', timestamp: now - 1000 }]));
  lane('held');
  getSqlite().prepare('INSERT INTO missions (id,repo_path,mission_state_json,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('fixture', '/fixture/repo', JSON.stringify({ packets: [{ id: 'held', mergeHold: true }] }), now, now);
  lane('correction');
  const prefix = 'review-author-' + createHash('sha256').update('correction').digest('hex').slice(0, 24) + '-';
  for (const status of ['delivered', 'unavailable', 'pending', 'unknown']) {
    getSqlite().prepare('INSERT INTO worker_corrections (id,repo_path,thread_id,payload_json,created_at) VALUES (?,?,?,?,?)')
      .run(prefix + status, '/fixture/repo', 'fixture-thread', '{}', now - 1000);
    getSqlite().prepare('INSERT INTO worker_correction_deliveries (correction_id,surface_id,run_id,status,note,updated_at) VALUES (?,?,?,?,?,?)')
      .run(prefix + status, 'fixture-author', 'fixture-run', status, '', now - 1000);
  }
  const body = await score();
  for (const id of ['approval', 'rejected-twice', 'gate', 'start', 'held']) {
    expect(body.metrics.find((row: { id: string }) => row.id === `reason-${id}`).value).toBe(1);
  }
  expect(body.metrics.find((row: { id: string }) => row.id === 'needed-person').value).toBe(5);
  expect(body.metrics.find((row: { id: string }) => row.id === 'corrections')).toMatchObject({ value: 1, changes: [expect.objectContaining({ id: 'correction' })] });
});
it('splits all figures by explicit intake provenance without using the reviewer runtime', async () => {
  const packets = [
    { id: 'chat', dispatcher: { surface: 'orchestrator' } },
    { id: 'external', launchContext: { source: 'mcp' } },
    { id: 'pr', reviewSource: { kind: 'pull-request' } },
  ];
  for (const packet of packets) { lane(packet.id); review(packet.id, true, -1000); }
  getSqlite().prepare('INSERT INTO missions (id,repo_path,mission_state_json,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('fixture', '/fixture/repo', JSON.stringify({ packets }), now, now);
  for (const packet of packets) {
    const body = await score('7', packet.id);
    expect(body.metrics.find((row: { id: string }) => row.id === 'rounds').changes.map((row: { id: string }) => row.id)).toEqual([packet.id]);
  }
});
it('counts retry lanes as one change and retains the original arrival cohort', async () => {
  lane('original', 20 * day); review('original', false, -10000);
  lane('retry');
  getSqlite().prepare("UPDATE lanes SET packet_id='original' WHERE id='retry'").run();
  review('retry', true, -1000);
  expect((await score('7')).sources.every((row: { count: number }) => row.count === 0)).toBe(true);
  const body = await score('30');
  expect(body.metrics.find((row: { id: string }) => row.id === 'rounds')).toMatchObject({ value: 2, changes: [expect.objectContaining({ id: 'retry' })] });
});
it('does not turn a completed non-merge dispatch into a merge receipt', async () => {
  lane('no-merge'); review('no-merge', true, -2000);
  event('no-merge', 'merge_dispatch_succeeded', -1000, 'system', { reviewedHeadSha: 'a'.repeat(40), mergeSha: null, status: 'completed' });
  const body = await score();
  expect(body.metrics.find((row: { id: string }) => row.id === 'without-person').value).toBeNull();
});
it('keeps packet and standalone lane identities in separate namespaces', async () => {
  lane('packet-lane'); lane('same-text');
  getSqlite().prepare("UPDATE lanes SET packet_id='same-text' WHERE id='packet-lane'").run();
  getSqlite().prepare("UPDATE lanes SET packet_id=NULL WHERE id='same-text'").run();
  const body = await score();
  expect(body.sources.find((row: { id: string }) => row.id === 'unknown').count).toBe(2);
});
it('attributes manual correction deliveries to their exact author and counts operator steers as human steps', async () => {
  lane('corrected'); lane('failed'); lane('steered');
  getSqlite().prepare("UPDATE lanes SET session_key=id").run();
  for (const id of ['corrected', 'failed', 'steered']) {
    review(id, true, -2000);
    event(id, 'merge_dispatch_succeeded', -1000, 'system', { reviewedHeadSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) });
  }
  event('steered', 'steered_packet', -3000, 'orchestrator', { source: 'operator' });
  getSqlite().prepare('INSERT INTO worker_corrections (id,repo_path,thread_id,payload_json,created_at) VALUES (?,?,?,?,?)')
    .run('manual-correction', '/fixture/repo/.worktrees/author', 'fixture-thread', JSON.stringify({ targets: [{ surfaceId: 'corrected' }, { surfaceId: 'failed' }] }), now - 3000);
  for (const [surface, status] of [['corrected', 'delivered'], ['failed', 'unavailable']]) {
    getSqlite().prepare('INSERT INTO worker_correction_deliveries (correction_id,surface_id,run_id,status,note,updated_at) VALUES (?,?,?,?,?,?)')
      .run('manual-correction', surface, 'fixture-run', status, '', now - 2000);
  }
  const body = await score();
  expect(body.metrics.find((row: { id: string }) => row.id === 'without-person').value).toBe(0);
  expect(body.metrics.find((row: { id: string }) => row.id === 'corrections')).toMatchObject({ value: 1, changes: [expect.objectContaining({ id: 'corrected' })] });
  expect(body.metrics.find((row: { id: string }) => row.id === 'needed-person').value).toBe(3);
  expect(body.metrics.find((row: { id: string }) => row.id === 'reason-other').value).toBe(3);
  const approval = getSqlite().prepare('SELECT audit_json FROM approvals WHERE lane_id=?').get('corrected') as { audit_json: string };
  getSqlite().prepare('UPDATE approvals SET audit_json=? WHERE lane_id=?').run(JSON.stringify([
    ...JSON.parse(approval.audit_json), { type: 'approved', actor: 'desktop', timestamp: now - 1500 },
  ]), 'corrected');
  const decided = await score();
  expect(decided.metrics.find((row: { id: string }) => row.id === 'reason-approval').value).toBe(1);
  expect(decided.metrics.find((row: { id: string }) => row.id === 'reason-other').value).toBe(2);
  const reasons = new Set(decided.metrics.filter((row: { id: string }) => row.id.startsWith('reason-'))
    .flatMap((row: { changes: Array<{ id: string }> }) => row.changes.map(change => change.id)));
  expect(['corrected', 'failed', 'steered'].every(id => reasons.has(id))).toBe(true);
});

it('caps every backing change list at 200 while keeping its total', async () => {
  const db = getSqlite();
  db.transaction(() => { for (let i = 0; i < 205; i++) { lane(`bulk-${i}`); review(`bulk-${i}`, true, -1000); } })();
  const body = await score('all');
  const rounds = body.metrics.find((row: { id: string }) => row.id === 'rounds');
  expect(rounds).toMatchObject({ total: 205 });
  expect(rounds.changes).toHaveLength(200);
  for (const metric of body.metrics) expect(metric.changes.length).toBeLessThanOrEqual(200);
});
it('materializes only the SQL arrival cohort and its related records', async () => {
  lane('recent'); review('recent', true, -1000);
  lane('old', 20 * day); review('old', true, -1000);
  lane('retry'); getSqlite().prepare("UPDATE lanes SET packet_id='old' WHERE id='retry'").run();
  event('recent', 'fixture-recent', -1000); event('old', 'fixture-old', -1000);
  getSqlite().prepare('INSERT INTO missions (id,repo_path,mission_state_json,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('range-mission', '/fixture/repo', JSON.stringify({ packets: [{ id: 'recent' }, { id: 'old', description: 'old payload'.repeat(1000) }] }), now, now);
  const db = getSqlite();
  const prepare = db.prepare.bind(db);
  const reads: Array<Array<Record<string, unknown>>> = [];
  const restoreStatements: Array<() => void> = [];
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    const allSpy = vi.spyOn(statement, 'all').mockImplementation((...args: unknown[]) => {
      const rows = all(...args);
      reads.push(rows as Array<Record<string, unknown>>);
      return rows;
    });
    restoreStatements.push(() => allSpy.mockRestore());
    return statement;
  });
  try {
    const body = await score();
    expect(body.sources.find((row: { id: string }) => row.id === 'unknown').count).toBe(1);
    const rows = reads.flat();
    expect(rows.filter(row => 'branch' in row && 'created_at' in row).map(row => row.id)).toEqual(['recent']);
    expect(rows.some(row => 'mission_state_json' in row)).toBe(false);
    expect(rows.filter(row => 'packet_json' in row).map(row => JSON.parse(String(row.packet_json)).id)).toEqual(['recent']);
    expect(rows.filter(row => 'audit_json' in row).map(row => row.lane_id)).toEqual(['recent']);
    expect(rows.filter(row => 'payload_json' in row && 'verb' in row).map(row => row.lane_id)).toEqual(['recent']);
  } finally { spy.mockRestore(); for (const restore of restoreStatements.reverse()) restore(); }
});
it('skips malformed stored JSON rows without losing the scorecard', async () => {
  lane('bad'); review('bad', true, -1000); event('bad', 'steered_packet', -1000);
  const db = getSqlite();
  db.prepare("UPDATE approvals SET audit_json='{broken' WHERE lane_id='bad'").run();
  db.prepare("UPDATE lane_events SET payload_json='{broken' WHERE lane_id='bad'").run();
  db.prepare('INSERT INTO missions (id,repo_path,mission_state_json,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('bad-mission', '/fixture/repo', '{broken', now, now);
  const body = await score();
  expect(body.basis).toContain('3 malformed rows skipped');
  expect(body.metrics.find((row: { id: string }) => row.id === 'rounds').value).toBeNull();
});
it('counts only desktop or mobile approval decisions as human steps', async () => {
  for (const [id, tool] of [['system-only', 'lane_merge'], ['second-pass', 'orchestrator_second_pass'], ['created-only', 'lane_merge']]) {
    lane(id); review(id, true, -3000); review(id, true, -2000);
    getSqlite().prepare('UPDATE approvals SET tool_name=?,audit_json=? WHERE id=?').run(tool,
      JSON.stringify([{ type: 'created', actor: id === 'created-only' ? 'desktop' : 'system', timestamp: now - 2000 }]), `${id}--2000`);
    event(id, 'merge_dispatch_succeeded', -1000, 'system', { reviewedHeadSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) });
  }
  const body = await score();
  expect(body.metrics.find((row: { id: string }) => row.id === 'reason-approval').value).toBe(0);
  expect(body.metrics.find((row: { id: string }) => row.id === 'needed-person').value).toBe(0);
  expect(body.metrics.find((row: { id: string }) => row.id === 'without-person').value).toBe(3);
});

it('loads only the newest 2000 first-arrival cohorts for all time', async () => {
  const db = getSqlite();
  db.transaction(() => {
    for (let i = 0; i < 2001; i++) lane(`bounded-${i}`, day + i * 1000);
    lane('old-retry', 1000);
    db.prepare("UPDATE lanes SET packet_id='bounded-2000' WHERE id='old-retry'").run();
    review('bounded-2000', true, -1000);
    event('bounded-2000', 'excluded', -1000);
    db.prepare('INSERT INTO missions (id,repo_path,mission_state_json,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('bounded-mission', '/fixture/repo', JSON.stringify({ packets: [{ id: 'bounded-2000' }] }), now, now);
    const prefix = 'review-author-' + createHash('sha256').update('bounded-2000').digest('hex').slice(0, 24) + '-';
    db.prepare('INSERT INTO worker_corrections (id,repo_path,thread_id,payload_json,created_at) VALUES (?,?,?,?,?)')
      .run(prefix + 'excluded', '/fixture/repo', 'fixture-thread', '{}', now - 1000);
  })();
  const prepare = db.prepare.bind(db);
  const reads: Array<Record<string, unknown>> = [];
  const restores: Array<() => void> = [];
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    const allSpy = vi.spyOn(statement, 'all').mockImplementation((...args: unknown[]) => {
      const rows = all(...args); reads.push(...rows as Array<Record<string, unknown>>); return rows;
    });
    restores.push(() => allSpy.mockRestore()); return statement;
  });
  try {
    const body = await score('all');
    expect(reads.filter(row => 'branch' in row && 'created_at' in row)).toHaveLength(2000);
    expect(body.sources.find((row: { id: string }) => row.id === 'unknown').count).toBe(2000);
    expect(body.basis).toContain('limited to the newest 2000 changes');
    expect(reads.some(row => row.id === 'bounded-2000' || row.id === 'old-retry')).toBe(false);
    expect(reads.filter(row => 'audit_json' in row || 'verb' in row || 'packet_json' in row || 'payload_json' in row)).toEqual([]);
  } finally { spy.mockRestore(); for (const restore of restores.reverse()) restore(); }
});

it.each([{ findings: 5 }, { findings: [null] }])('drops malformed nested findings $findings through GET', async ({ findings }) => {
  lane('shape'); review('shape', true, -1000);
  const db = getSqlite();
  const row = db.prepare("SELECT audit_json FROM approvals WHERE lane_id='shape'").get() as { audit_json: string };
  const audit = JSON.parse(row.audit_json); audit[0].findings = findings;
  db.prepare("UPDATE approvals SET audit_json=? WHERE lane_id='shape'").run(JSON.stringify(audit));
  const body = await score();
  expect(body.basis).toContain('1 malformed rows skipped');
  expect(body.metrics.find((row: { id: string }) => row.id === 'findings').value).toBe(0);
  expect(body.metrics.find((row: { id: string }) => row.id === 'rounds').value).toBe(1);
});
it.each([{ targets: {} }, { targets: [null] }])('drops malformed nested correction targets $targets through GET', async ({ targets }) => {
  lane('shape'); lane('other-shape');
  const prefix = 'review-author-' + createHash('sha256').update('shape').digest('hex').slice(0, 24) + '-';
  getSqlite().prepare('INSERT INTO worker_corrections (id,repo_path,thread_id,payload_json,created_at) VALUES (?,?,?,?,?)')
    .run(prefix + 'shape', '/fixture/repo', 'fixture-thread', JSON.stringify({ targets }), now - 1000);
  const body = await score();
  expect(body.basis).toContain('1 malformed rows skipped');
  expect(body.metrics.find((row: { id: string }) => row.id === 'corrections').value).toBe(0);
});
