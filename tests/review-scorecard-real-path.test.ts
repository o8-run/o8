import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it } from 'vitest';
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
    .run('manual-correction', '/fixture/repo', 'fixture-thread', JSON.stringify({ targets: [{ surfaceId: 'corrected' }, { surfaceId: 'failed' }] }), now - 3000);
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
