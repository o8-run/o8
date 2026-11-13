import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { ApprovalAuditEvent, OrchestratorReviewFinding } from '@/lib/approvals/types';

type Source = 'chat' | 'external' | 'pr' | 'unknown';
interface LaneRow {
  id: string; packet_id: string | null; label: string; branch: string;
  repo_path: string; created_at: string;
  session_key: string | null;
}
interface StoredEvent { id: string; lane_id: string; verb: string; actor: string; payload_json: string; timestamp: string }
interface EventRow extends StoredEvent { payload: Record<string, unknown> }
interface StoredApproval {
  id: string; lane_id: string | null; packet_id: string | null; tool_name: string | null;
  args_json: string | null; audit_json: string; gate_result_json: string | null; created_at: number;
}
interface ApprovalRow extends StoredApproval { audit: ApprovalAuditEvent[]; args: Record<string, unknown>; gate: { passed?: boolean } }
interface Review extends ApprovalAuditEvent { approvalId: string }
interface Change {
  id: string; title: string; branch: string; source: Source;
  held: boolean;
  correctionAsked: boolean;
  reviews: Review[]; events: EventRow[]; approvals: ApprovalRow[];
}
interface Entry { id: string; title: string; detail: string }
interface Metric {
  id: string; section: string; label: string; value: number | null;
  display: string; note: string; changes: Entry[]; total: number;
}
const SOURCES: Array<{ id: Source; label: string }> = [
  { id: 'chat', label: 'o8 chat' }, { id: 'external', label: 'Another tool' },
  { id: 'pr', label: 'Pull request' }, { id: 'unknown', label: 'Unrecorded source' },
];
function parse<T>(text: string | null, fallback: T, skipped?: () => void): T {
  if (!text) return fallback;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(fallback)
      || (Array.isArray(value) && value.some(item => !item || typeof item !== 'object' || Array.isArray(item)))) throw new Error('Invalid stored shape');
    return value as T;
  } catch { skipped?.(); return fallback; }
}
function indexBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (id === null) continue;
    const bucket = index.get(id) ?? [];
    bucket.push(row);
    index.set(id, bucket);
  }
  return index;
}
function origin(packet?: OrchestratorPacket): Source {
  // A runtime or model identifies the reviewer, never the original author.
  if (packet?.reviewSource) return 'pr';
  if (packet?.launchContext && ['cli', 'mcp', 'agent'].includes(packet.launchContext.source)) return 'external';
  if (packet?.dispatcher?.surface === 'orchestrator') return 'chat';
  return 'unknown';
}
function entries(changes: Change[]): Entry[] {
  return changes.slice(0, 200).map(change => ({ id: change.id, title: change.title,
    detail: `${change.branch} · ${change.reviews.length} review rounds · ${SOURCES.find(source => source.id === change.source)!.label}` }));
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
}
const approvalAsked = (approval: ApprovalRow) => approval.audit.some(event => ['desktop', 'mobile'].includes(event.actor)
  && ['approved', 'rejected'].includes(event.type));
const human = (change: Change) => change.correctionAsked || change.events.some(event => event.actor === 'user' && !['create', 'attach_session'].includes(event.verb))
  || change.events.some(event => event.verb === 'steered_packet' && event.payload.source === 'operator')
  || change.approvals.some(approvalAsked);
function merge(change: Change): EventRow | undefined {
  return change.events.find(event => event.verb === 'merge_dispatch_succeeded'
    && !!event.payload.mergeSha)
    ?? change.events.find(event => event.verb === 'merge' && !!event.payload.laneHeadSha);
}
function metrics(changes: Change[], corrections: Map<string, number>): Metric[] {
  const rows: Metric[] = [];
  const add = (id: string, section: string, label: string, selected: Change[], note: string, value: number | null = selected.length, display?: string) => {
    rows.push({ id, section, label, value, display: display ?? (value === null ? '—' : String(value)), note, total: selected.length, changes: entries(selected) });
  };
  const merged = changes.filter(change => merge(change));
  const autonomous = merged.filter(change => {
    const receipt = merge(change)!;
    const head = receipt.payload.reviewedHeadSha;
    const verdict = change.reviews.filter(review => review.timestamp <= Date.parse(receipt.timestamp)).at(-1);
    return receipt.actor !== 'user' && !human(change) && !corrections.get(change.id) && typeof head === 'string'
      && verdict?.approved === true && verdict.reviewedHeadSha === head
      && (verdict.findings ?? []).every(finding => finding.resolution !== 'deferred');
  });
  add('without-person', 'Throughput', 'Went through without a person', autonomous,
    'Reviewed HEAD matched a durable automated merge receipt, with no recorded human step. Share is of changes with merge receipts; legacy merges without receipts are excluded.',
    merged.length ? autonomous.length : null,
    merged.length ? `${autonomous.length} / ${merged.length} (${Math.round(100 * autonomous.length / merged.length)}%)` : '—');
  const reasons: Array<[string, string, (change: Change) => boolean]> = [
    ['approval', 'Approval asked', change => change.approvals.some(approvalAsked)],
    ['rejected-twice', 'Review rejected twice', change => change.reviews.filter(review => review.approved === false).length >= 2],
    ['gate', 'Gate failed', change => change.approvals.some(approval => approval.gate.passed === false)],
    ['start', 'Start failed', change => change.events.some(event => event.verb === 'status_change'
      && ['launch_failed', 'launch_error', 'launch_preparation_failed', 'relaunch_failed'].includes(String(event.payload.eventLabel ?? '')))],
    ['held', 'Held', change => change.held],
  ];
  add('needed-person', 'Needed a person', 'Needed a person', changes.filter(change => human(change) || corrections.get(change.id) || reasons.some(([, , matches]) => matches(change))),
    'Distinct changes with a recorded human step or escalation. Reasons can overlap; gate/start/hold counts require explicit receipts.');
  for (const [id, label, matches] of reasons) add(`reason-${id}`, 'Needed a person', label, changes.filter(matches),
    id === 'held' ? 'Queue or merge holds recorded in the current mission snapshot. Cleared historical holds cannot be reconstructed.' : 'Only explicit stored receipts are counted.');
  add('reason-other', 'Needed a person', 'Other recorded human steps', changes.filter(change => human(change) && !reasons.some(([, , matches]) => matches(change))),
    'Operator steers, correction requests and other recorded user actions that do not fall under the named reasons.');

  // A finding has no durable ID. Match exact file/line/description across rounds;
  // a finding disappearing from a later review does not prove it was fixed.
  const findings = changes.flatMap(change => {
    const found = new Map<string, { finding: OrchestratorReviewFinding; rejectedAt: number | null; reviewedAt: number }>();
    for (const review of change.reviews) for (const finding of review.findings ?? []) {
      const key = JSON.stringify([finding.file, finding.line ?? null, finding.description]);
      found.set(key, { finding, reviewedAt: review.timestamp,
        rejectedAt: found.get(key)?.rejectedAt ?? (review.approved === false ? review.timestamp : null) });
    }
    return [...found.values()].map(item => ({ ...item, change }));
  });
  const findingMetric = (id: string, label: string, selected: typeof findings, note: string) => {
    add(id, 'Found by review', label, [...new Set(selected.map(item => item.change))], note, selected.length);
  };
  findingMetric('findings', 'Findings raised', findings, 'Exact file, line and description are deduplicated across review rounds.');
  for (const severity of ['bug', 'rule_violation', 'note']) findingMetric(`severity-${severity}`, severity === 'rule_violation' ? 'Rule violations' : severity === 'bug' ? 'Bugs' : 'Notes',
    findings.filter(item => item.finding.severity === severity), 'Uses stored review severity; no severity is inferred from prose.');
  findingMetric('finding-fixed', 'Fixed after Request changes', findings.filter(item => item.rejectedAt !== null
    && item.reviewedAt > item.rejectedAt && item.finding.resolution === 'fixed'),
    'A later review explicitly marked the same finding fixed. The fixing author is not recorded.');
  add('finding-author-fixed', 'Found by review', 'Fixed by the author', [],
    'Stored finding resolutions do not identify the fixing author. A linked author correction and verified resolution are needed.', null);
  findingMetric('finding-waived', 'Waived', findings.filter(item => item.finding.resolution === 'accepted'), 'Stored accepted findings.');
  findingMetric('finding-open', 'Open', findings.filter(item => item.finding.resolution === 'deferred'), 'No explicit fixed or accepted resolution for this exact finding.');
  const corrected = changes.filter(change => (corrections.get(change.id) ?? 0) > 0);
  add('corrections', 'Fix loops', 'Corrections sent', corrected, 'Delivered correction handoffs tied to these changes; failed, pending and uncertain delivery do not count.',
    corrected.reduce((sum, change) => sum + corrections.get(change.id)!, 0));
  const reviewed = changes.filter(change => change.reviews.length);
  const rounds = reviewed.length ? reviewed.reduce((sum, change) => sum + change.reviews.length, 0) / reviewed.length : null;
  add('rounds', 'Fix loops', 'Rounds per change', reviewed, 'Mean of completed review verdicts per reviewed change in the arrival cohort.', rounds,
    rounds === null ? '—' : rounds.toFixed(1));
  add('second-look', 'Fix loops', 'Passed on the second look', reviewed.filter(change => change.reviews[0]?.approved === false && change.reviews[1]?.approved === true), 'First verdict requested changes; second verdict approved.');
  for (const [id, label, samples] of [
    ['arrival-verdict', 'Arrival to verdict', changes.flatMap(change => {
      const verdict = change.reviews.at(-1);
      const arrival = change.events.find(event => event.verb === 'scorecard_arrival');
      return verdict && arrival ? [{ change, ms: verdict.timestamp - Date.parse(arrival.timestamp) }] : [];
    })],
    ['verdict-merge', 'Verdict to merge', merged.flatMap(change => {
      const receipt = merge(change)!;
      const verdict = change.reviews.filter(review => review.timestamp <= Date.parse(receipt.timestamp)).at(-1);
      return verdict ? [{ change, ms: Date.parse(receipt.timestamp) - verdict.timestamp }] : [];
    })],
  ] as const) {
    const valid = samples.filter(sample => sample.ms >= 0);
    const value = median(valid.map(sample => sample.ms));
    add(id, 'Time · median', label, valid.map(sample => sample.change),
      'Arrival is durable lane creation; verdict is the latest completed review in this cohort. Timings require both timestamps.', value,
      value === null ? '—' : value < 60000 ? `${Math.round(value / 1000)}s` : value < 3600000 ? `${(value / 60000).toFixed(1)} min` : `${(value / 3600000).toFixed(1)} hr`);
  }
  add('learned', 'Learned', 'Verified outcomes reused', [], 'No durable link from a verified review outcome to a later task is recorded yet (#5823).', null);
  return rows;
}

/** Read-only snapshot: no discovery, expiry, repair, model calls or runtime observation. */
export function reviewScorecard(range: string, selectedSource: string, repoPath: string | null, now = Date.now()) {
  const since = range === 'all' ? 0 : now - Number(range) * 86400000;
  const db = getSqlite();
  return db.transaction(() => {
    const skippedRows = new Set<string>();
    const skipped = (key: string) => () => { skippedRows.add(key); };
    // Select whole retry groups by their earliest eligible arrival before materializing payloads.
    const lanes = db.prepare(`WITH eligible AS (
      SELECT id,packet_id,label,branch,repo_path,session_key,created_at,
        CASE WHEN packet_id IS NOT NULL AND packet_id != '' THEN 'packet:' || packet_id ELSE 'lane:' || id END AS cohort
      FROM lanes WHERE (? IS NULL OR repo_path=?) AND julianday(created_at) <= julianday(?)
    ), cohorts AS (
      SELECT cohort FROM eligible GROUP BY cohort HAVING MIN(julianday(created_at)) >= julianday(?)
    ) SELECT id,packet_id,label,branch,repo_path,session_key,created_at FROM eligible
      WHERE cohort IN (SELECT cohort FROM cohorts) ORDER BY julianday(created_at) DESC,id`)
      .all(repoPath, repoPath, new Date(now).toISOString(), new Date(since).toISOString()) as LaneRow[];
    const laneIds = JSON.stringify(lanes.map(lane => lane.id));
    const packetIds = JSON.stringify([...new Set(lanes.flatMap(lane => lane.packet_id ? [lane.packet_id] : []))]);
    const repoPaths = JSON.stringify([...new Set(lanes.map(lane => lane.repo_path))]);
    const approvals = (db.prepare(`SELECT id,lane_id,packet_id,tool_name,args_json,audit_json,gate_result_json,created_at FROM approvals
      WHERE created_at <= ? AND (lane_id IN (SELECT value FROM json_each(?)) OR packet_id IN (SELECT value FROM json_each(?)))`)
      .all(now, laneIds, packetIds) as StoredApproval[]).map(row => ({ ...row,
        audit: parse<ApprovalAuditEvent[]>(row.audit_json, [], skipped(`approval:${row.id}`)),
        args: parse<Record<string, unknown>>(row.args_json, {}, skipped(`approval:${row.id}`)),
        gate: parse<{ passed?: boolean }>(row.gate_result_json, {}, skipped(`approval:${row.id}`)),
      }));
    const events = (db.prepare(`SELECT id,lane_id,verb,actor,payload_json,timestamp FROM lane_events
      WHERE lane_id IN (SELECT value FROM json_each(?)) AND julianday(timestamp) <= julianday(?) ORDER BY julianday(timestamp),id`)
      .all(laneIds, new Date(now).toISOString()) as StoredEvent[]).map(row => ({ ...row,
        payload: parse<Record<string, unknown>>(row.payload_json, {}, skipped(`event:${row.id}`)),
      }));
    const approvalsByLane = indexBy(approvals, row => row.lane_id);
    const approvalsByPacket = indexBy(approvals, row => row.packet_id);
    const eventsByLane = indexBy(events, row => row.lane_id);
    const packets = new Map<string, OrchestratorPacket>();
    // Extract only the selected packets in SQLite; do not transfer entire mission snapshots to JS.
    for (const row of db.prepare(`SELECT id FROM missions WHERE repo_path IN (SELECT value FROM json_each(?))
      AND NOT json_valid(mission_state_json)`).all(repoPaths) as Array<{ id: string }>) skippedRows.add(`mission:${row.id}`);
    const packetRows = db.prepare(`SELECT m.id, p.value AS packet_json FROM missions m,
      json_each(CASE WHEN json_valid(m.mission_state_json) THEN m.mission_state_json ELSE '{}' END, '$.packets') p
      WHERE m.repo_path IN (SELECT value FROM json_each(?))
        AND json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END, '$.id') IN (SELECT value FROM json_each(?))
      ORDER BY m.updated_at`).all(repoPaths, packetIds) as Array<{ id: string; packet_json: string }>;
    for (const row of packetRows) {
      const packet = parse<OrchestratorPacket | null>(row.packet_json, null, skipped(`mission:${row.id}`));
      if (packet) packets.set(packet.id, packet);
    }
    const grouped = new Map<string, LaneRow[]>();
    for (const lane of lanes.filter(lane => (!repoPath || lane.repo_path === repoPath) && Date.parse(lane.created_at) <= now)) {
      const key = lane.packet_id ? `packet:${lane.packet_id}` : `lane:${lane.id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), lane]);
    }
    // Retries can create more than one lane for the same packet. They remain one change.
    const canonical = [...grouped.values()].map(group => ({ ...group[0],
      created_at: group.at(-1)!.created_at, laneIds: new Set(group.map(lane => lane.id)),
      sessionKeys: new Set(group.flatMap(lane => lane.session_key ? [lane.session_key] : [])) }));
    const corrections = new Map<string, number>();
    const handoffs = (db.prepare('SELECT id,payload_json,created_at FROM worker_corrections WHERE created_at BETWEEN ? AND ?')
      .all(lanes.reduce((earliest, lane) => Math.min(earliest, Date.parse(lane.created_at)), now), now) as Array<{ id: string; payload_json: string; created_at: number }>).map(row => ({ ...row,
        targets: parse<{ targets?: Array<{ surfaceId: string }> }>(row.payload_json, {}, skipped(`correction:${row.id}`)).targets ?? [] }));
    const delivered = db.prepare(`SELECT correction_id,surface_id FROM worker_correction_deliveries
      WHERE status='delivered' AND updated_at <= ? AND correction_id IN (SELECT value FROM json_each(?))`).all(now, JSON.stringify(handoffs.map(row => row.id))) as Array<{ correction_id: string; surface_id: string }>;
    const deliveriesByCorrection = indexBy(delivered, row => row.correction_id);
    const changes: Change[] = canonical.filter(lane => (!repoPath || lane.repo_path === repoPath)
      && Date.parse(lane.created_at) >= since && Date.parse(lane.created_at) <= now).map(lane => {
      const related = [...new Set([...lane.laneIds].flatMap(id => approvalsByLane.get(id) ?? [])
        .concat(lane.packet_id ? approvalsByPacket.get(lane.packet_id) ?? [] : []))].filter(approval => approval.created_at <= now);
      const reviews = related.filter(approval => approval.tool_name === 'orchestrator_review'
        && approval.args.reviewTurnOutcome === 'completed')
        .flatMap(approval => approval.audit.filter(event => event.type === 'orchestrator_review'
          && !event.parseWarning && typeof event.approved === 'boolean' && event.timestamp <= now)
          .map(event => ({ ...event, approvalId: approval.id }))).sort((a, b) => a.timestamp - b.timestamp);
      const packet = packets.get(lane.packet_id ?? '');
      const prefix = lane.packet_id ? `review-author-${createHash('sha256').update(lane.packet_id).digest('hex').slice(0, 24)}-` : null;
      const sent = handoffs.filter(row => row.created_at >= Date.parse(lane.created_at)
        && (!!prefix && row.id.startsWith(prefix) || row.targets.some(target => lane.sessionKeys.has(target.surfaceId))));
      corrections.set(lane.id, sent.filter(row => (deliveriesByCorrection.get(row.id) ?? []).some(delivery =>
        !!prefix && row.id.startsWith(prefix) || lane.sessionKeys.has(delivery.surface_id))).length);
      return { id: lane.id, title: lane.label, branch: lane.branch, source: origin(packet),
        held: packet?.mergeHold === true || packet?.queueState === 'held',
        correctionAsked: sent.length > 0,
        approvals: related, reviews, events: [{ id: 'arrival', lane_id: lane.id, verb: 'scorecard_arrival', actor: 'system', payload_json: '{}', payload: {}, timestamp: lane.created_at },
          ...[...lane.laneIds].flatMap(id => eventsByLane.get(id) ?? []).filter(event => Date.parse(event.timestamp) <= now)
            .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))] };
    });
    return { range, source: selectedSource, basis: `${repoPath ? 'This project' : 'All projects'} · Tracked changes arriving in this range (one per packet, otherwise lane), using durable records through now. Unknown source is kept separate. Pull request records do not establish whether the author is a person.${skippedRows.size ? ` ${skippedRows.size} malformed rows skipped.` : ''}`,
      sources: SOURCES.map(source => ({ ...source, count: changes.filter(change => change.source === source.id).length })),
      metrics: metrics(changes.filter(change => selectedSource === 'all' || change.source === selectedSource), corrections) };
  })();
}
