import { basename } from 'node:path';
import { getDb, getSqlite } from '@/lib/db';
import type { RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import { approximateSearchResult, boundedTypoSelect, matchedTextSnippet, toFts5Query, toTypoFts5Query } from '@/lib/search/fts';
import type { SearchResult } from '@/lib/search/types';

const MAX_TRANSCRIPT_INDEX_BYTES = 2 * 1024 * 1024;

export function syncTranscriptSearchDocument(input: {
  packetId: string;
  laneId?: string | null;
  sessionKey?: string | null;
  title: string;
  repoPath?: string | null;
  runtime?: string | null;
  entries: RuntimeTranscriptEntry[];
  completedAt: string;
}): void {
  if (!getDb()) return;
  const transcriptText = input.entries
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join('\n')
    .slice(0, MAX_TRANSCRIPT_INDEX_BYTES);
  if (!transcriptText.trim()) return;
  getSqlite().prepare(`
    INSERT INTO transcript_search_documents (
      packet_id, lane_id, session_key, title, repo_path, runtime,
      transcript_text, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(packet_id) DO UPDATE SET
      lane_id = excluded.lane_id,
      session_key = excluded.session_key,
      title = excluded.title,
      repo_path = excluded.repo_path,
      runtime = excluded.runtime,
      transcript_text = excluded.transcript_text,
      completed_at = excluded.completed_at
  `).run(
    input.packetId,
    input.laneId ?? null,
    input.sessionKey ?? null,
    input.title,
    input.repoPath ?? null,
    input.runtime ?? null,
    transcriptText,
    input.completedAt,
  );
}

interface TranscriptRow {
  packet_id: string | null;
  lane_id: string | null;
  session_key: string | null;
  title: string | null;
  repo_path: string | null;
  detail: string;
  completed_at: string | null;
  rank?: number;
  source: 'transcript' | 'outcome' | 'lane';
  approximate?: boolean;
}

function transcriptResults(query: string, recoveryQuery?: string): TranscriptRow[] {
  const ftsQuery = recoveryQuery ?? toFts5Query(query);
  if (!ftsQuery) return [];
  const select = `
    SELECT doc.packet_id, doc.lane_id, doc.session_key, doc.title, doc.repo_path,
      doc.transcript_text AS detail, doc.completed_at,
      bm25(transcript_fts, 0.0, 5.0, 1.0) AS rank,
      'transcript' AS source
    FROM transcript_fts
    JOIN transcript_search_documents doc ON doc.packet_id = transcript_fts.packet_id
    WHERE transcript_fts MATCH ?
  `;
  return getSqlite().prepare(`
    ${recoveryQuery ? boundedTypoSelect(select) : select}
    ORDER BY rank, datetime(completed_at) DESC
    LIMIT 8
  `).all(ftsQuery) as TranscriptRow[];
}

function outcomeResults(query: string, recoveryQuery?: string): TranscriptRow[] {
  const ftsQuery = recoveryQuery ?? toFts5Query(query);
  if (!ftsQuery) return [];
  try {
    const select = `
      SELECT so.packet_id, so.lane_id, so.session_key,
        COALESCE(l.label, 'Packet ' || COALESCE(so.packet_id, so.id)) AS title,
        so.repo_path, so.summary || CASE WHEN so.plan_text IS NOT NULL THEN '\n' || so.plan_text ELSE '' END AS detail,
        so.completed_at, bm25(outcomes_fts, 0.0, 4.0, 1.0) AS rank,
        'outcome' AS source
      FROM outcomes_fts
      JOIN session_outcomes so ON so.id = outcomes_fts.outcome_id
      LEFT JOIN lanes l ON l.id = so.lane_id
      WHERE outcomes_fts MATCH ?
    `;
    return getSqlite().prepare(`
      ${recoveryQuery ? boundedTypoSelect(select) : select}
      ORDER BY rank, datetime(${recoveryQuery ? 'completed_at' : 'so.completed_at'}) DESC
      LIMIT 8
    `).all(ftsQuery) as TranscriptRow[];
  } catch {
    return getSqlite().prepare(`
      SELECT so.packet_id, so.lane_id, so.session_key,
        COALESCE(l.label, 'Packet ' || COALESCE(so.packet_id, so.id)) AS title,
        so.repo_path, so.summary AS detail, so.completed_at,
        0 AS rank, 'outcome' AS source
      FROM session_outcomes so
      LEFT JOIN lanes l ON l.id = so.lane_id
      WHERE lower(so.summary || ' ' || COALESCE(so.plan_text, '')) LIKE ?
      ORDER BY datetime(so.completed_at) DESC
      LIMIT 8
    `).all(`%${query.toLowerCase()}%`) as TranscriptRow[];
  }
}

function laneEventResults(query: string): TranscriptRow[] {
  return getSqlite().prepare(`
    SELECT l.packet_id, l.id AS lane_id, l.session_key, l.label AS title,
      l.repo_path, COALESCE(l.last_event_label, e.verb || ' ' || e.payload_json) AS detail,
      COALESCE(e.timestamp, l.updated_at) AS completed_at,
      0 AS rank, 'lane' AS source
    FROM lanes l
    LEFT JOIN lane_events e ON e.id = (
      SELECT latest.id FROM lane_events latest
      WHERE latest.lane_id = l.id
        AND lower(latest.verb || ' ' || latest.payload_json) LIKE ?
      ORDER BY datetime(latest.timestamp) DESC
      LIMIT 1
    )
    WHERE lower(l.label || ' ' || COALESCE(l.last_event_label, '') || ' '
      || COALESCE(l.packet_id, '') || ' ' || COALESCE(e.verb, '') || ' '
      || COALESCE(e.payload_json, '')) LIKE ?
    ORDER BY datetime(COALESCE(e.timestamp, l.updated_at)) DESC
    LIMIT 8
  `).all(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`) as TranscriptRow[];
}

export async function searchTranscripts(query: string): Promise<SearchResult[]> {
  if (!getDb()) return [];
  const rows = [...transcriptResults(query), ...outcomeResults(query), ...laneEventResults(query)];
  const strictCount = new Set(rows.map(row => row.packet_id || row.lane_id || row.session_key).filter(Boolean)).size;
  for (const table of ['transcript_fts', 'outcomes_fts'] as const) {
    const recoveryQuery = toTypoFts5Query(getSqlite(), table, query, strictCount);
    if (recoveryQuery) {
      const recovered = table === 'transcript_fts'
        ? transcriptResults(query, recoveryQuery)
        : outcomeResults(query, recoveryQuery);
      rows.push(...recovered.map(row => ({ ...row, approximate: true })));
    }
  }
  const seen = new Set<string>();
  return rows
    .sort((left, right) => {
      if (Boolean(left.approximate) !== Boolean(right.approximate)) return left.approximate ? 1 : -1;
      const sourceBonus = (row: TranscriptRow) => row.source === 'transcript' ? 30 : row.source === 'outcome' ? 20 : 10;
      return (sourceBonus(right) - (right.rank ?? 0)) - (sourceBonus(left) - (left.rank ?? 0));
    })
    .flatMap<SearchResult>((row) => {
      const identity = row.packet_id || row.lane_id || row.session_key;
      if (!identity || seen.has(identity)) return [];
      seen.add(identity);
      const repoName = row.repo_path ? basename(row.repo_path) : null;
      const result: SearchResult = {
        kind: 'transcript',
        id: `transcript:${identity}`,
        title: row.title || `Packet ${identity}`,
        detail: [repoName, matchedTextSnippet(row.detail, query)].filter(Boolean).join(' · '),
        target: {
          ...(row.packet_id ? { packetId: row.packet_id } : {}),
          ...(row.lane_id ? { laneId: row.lane_id } : {}),
          ...(row.session_key ? { sessionKey: row.session_key } : {}),
        },
        score: 70 + (row.source === 'transcript' ? 30 : row.source === 'outcome' ? 20 : 10) - (row.rank ?? 0),
      };
      return [row.approximate ? approximateSearchResult(result) : result];
    })
    .slice(0, 8);
}
