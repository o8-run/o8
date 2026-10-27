import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { readOperatorCorrections, retainedCorrectionPredicate } from './operator-corrections';
import { advanceMemoryRevision } from './memory-revision';

/** Inventory pages select IDs in SQL before the contextual reader's scan cap. */
export function listCorrectionMemory(input: { repoPaths: string[]; projectId?: string | null; query: string; offset: number; limit: number }) {
  const db = getSqlite();
  const rows = db.prepare(`
    WITH corrections AS (
      SELECT 'approval:' || a.id AS id, a.title AS title,
        json_extract(a.resolution_json, '$.note') AS reason,
        l.repo_path AS repo_path, a.project_id, 0 AS standing,
        strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(a.resolved_at, a.updated_at) / 1000.0, 'unixepoch') AS at
      FROM approvals a LEFT JOIN lanes l ON l.id = COALESCE(a.lane_id,
        json_extract(a.continuation_json, '$.laneId'),
        (SELECT id FROM lanes WHERE a.packet_id IS NOT NULL AND packet_id = a.packet_id ORDER BY created_at DESC LIMIT 1))
      WHERE a.status = 'rejected' AND json_valid(a.resolution_json)
        AND TRIM(COALESCE(json_extract(a.resolution_json, '$.note'), '')) != ''
      UNION ALL
      SELECT 'steer:' || e.id, l.label, json_extract(e.payload_json, '$.message'), l.repo_path, l.project_id,
        CASE WHEN LOWER(TRIM(json_extract(e.payload_json, '$.source'))) = 'operator' THEN 0 ELSE 1 END, e.timestamp
      FROM lane_events e JOIN lanes l ON l.id = e.lane_id
      WHERE e.verb = 'steered_packet' AND json_valid(e.payload_json)
        AND json_type(e.payload_json, '$.message') = 'text'
        AND TRIM(json_extract(e.payload_json, '$.message')) != ''
    )
    SELECT id FROM corrections c WHERE ${retainedCorrectionPredicate('c.id')}
      AND (@repos = '[]' OR repo_path IN (SELECT value FROM json_each(@repos)))
      AND (@allProjects OR project_id IS @projectId)
      AND (@query = '' OR instr(lower(title || ' ' || reason), @query) > 0)
    ORDER BY standing, at DESC, id
    LIMIT @limit OFFSET @offset
  `).all({ repos: JSON.stringify(input.repoPaths.map(value => path.resolve(value))), query: input.query.toLowerCase(),
    allProjects: Number(input.projectId === undefined), projectId: input.projectId ?? null,
    offset: input.offset, limit: input.limit + 1 }) as Array<{ id: string }>;
  const ids = rows.slice(0, input.limit).map(row => row.id);
  const corrections = ids.length ? readOperatorCorrections({ ids, projectId: input.projectId, limit: ids.length, throwOnError: true }) : [];
  const byId = new Map(corrections.map(correction => [correction.id, correction]));
  return { corrections: ids.map(id => byId.get(id)).filter(value => value !== undefined), hasMore: rows.length > input.limit };
}

/** Forget recall standing, not the immutable approval/terminal audit. */
export function forgetCorrectionMemory(id: string, projectId: string | null): boolean {
  const db = getSqlite();
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS forgotten_operator_corrections (
      id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL
    )`);
    const found = readOperatorCorrections({ ids: [id], projectId, limit: 1, throwOnError: true })[0];
    if (!found) return false;
    db.prepare('INSERT INTO forgotten_operator_corrections (id, forgotten_at) VALUES (?, ?)').run(id, new Date().toISOString());
    advanceMemoryRevision(db);
    return true;
  })();
}
