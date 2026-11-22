import { and, asc, getTableColumns, inArray, sql } from 'drizzle-orm';
import { getDb, lanes } from '@/lib/db';
import type { Lane, LaneOwnership, LaneRuntime, LaneStatus } from './types';

type LaneRow = typeof lanes.$inferSelect;

export function getLaneDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[lane-registry] SQLite database is unavailable');
  }
  return db;
}

export function mapLaneRow(row: LaneRow | undefined): Lane | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    repoPath: row.repoPath,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    runtime: row.runtime as LaneRuntime, model: row.model,
    sessionKey: row.sessionKey,
    packetId: row.packetId, prNumber: row.prNumber,
    status: row.status as LaneStatus, outcome: row.outcome as Lane['outcome'], outcomeNote: row.outcomeNote,
    ownership: row.ownership as LaneOwnership,
    writerToken: row.writerToken,
    lastHeartbeatAt: row.lastHeartbeatAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastEventAt: row.lastEventAt,
    lastEventLabel: row.lastEventLabel,
  };
}

// These fields are plain text and integers. Aliasing to the schema keys lets SQLite
// return named rows without allocating positional arrays and mapping them in Drizzle.
let laneListColumns: ReturnType<typeof sql.join> | undefined;

export function getFilteredLaneList(
  whereClause?: ReturnType<typeof and>,
): Lane[] {
  laneListColumns ??= sql.join(
    Object.entries(getTableColumns(lanes)).map(([key, column]) => sql`${column} as ${sql.identifier(key)}`),
    sql`, `,
  );
  const condition = whereClause ? sql`where ${whereClause}` : sql.empty();
  const rows = getLaneDb().all<LaneRow>(sql`
    select ${laneListColumns}
    from ${lanes}
    ${condition}
    order by ${asc(lanes.createdAt)}
  `);
  return rows.map(row => mapLaneRow(row)!);
}

export function listLanesByStatuses(statuses: ReadonlySet<string>): Lane[] {
  if (statuses.size === 0) return [];
  // Include legacy stored statuses outside the current lane enum.
  return getFilteredLaneList(inArray(sql`${lanes.status}`, [...statuses]));
}
