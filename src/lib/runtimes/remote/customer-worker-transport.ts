import { assertRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import type { GetBranchResponse, LaunchRequest, LaunchResponse, PollEvent, Transport } from './protocol';

interface TokenRow {
  id: string;
}

interface WorkerEventRow {
  event_type: string;
  payload_json: string;
}

interface WorkerRunRow {
  remote_branch: string | null;
  last_event_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePayload(payloadJson: string, eventType: string) {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch (error) {
    console.error(
      `[remote-customer] failed to parse worker event payload for ${eventType}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export class CustomerWorkerTransport implements Transport {
  async sendLaunch(req: LaunchRequest): Promise<LaunchResponse> {
    await assertRuntimeEffortPin('remote-customer', req.modelHint, req.effort);
    const now = new Date().toISOString();

    if (!req.laneId) {
      console.warn('[remote-customer] missing laneId — cannot launch');
      return { accepted: false, workerId: '', startedAt: now };
    }

    const { getSqlite } = await import('@/lib/db');
    const sqlite = getSqlite();
    // #566 — Prefer 'global' tokens (the default for solo operator) before
    // falling back to 'repo' scope tokens. CASE expression orders by scope
    // specificity so the most relevant token wins regardless of insert order.
    // Proper per-repo scoping needs a `scope_value` column — tracked as a
    // follow-up; this query tightens the multi-token case without a migration.
    const token = sqlite
      .prepare(`
        SELECT id
        FROM worker_tokens
        WHERE revoked_at IS NULL
          AND scope IN ('global', 'repo')
        ORDER BY
          CASE scope
            WHEN 'global' THEN 0
            WHEN 'repo' THEN 1
            ELSE 2
          END,
          created_at DESC
        LIMIT 1
      `)
      .get() as TokenRow | undefined;

    if (!token?.id) {
      console.warn('[remote-customer] no worker_tokens available — cannot launch');
      return { accepted: false, workerId: '', startedAt: now };
    }

    const tx = sqlite.transaction(() => {
      sqlite
        .prepare(`
          INSERT INTO worker_runs (
            id,
            lane_id,
            worker_token_id,
            transport,
            status,
            remote_branch,
            started_at,
            last_event_at
          )
          VALUES (?, ?, ?, 'customer', 'pending', ?, ?, ?)
        `)
        .run(req.runId, req.laneId, token.id, req.remoteBranch, now, now);

      sqlite
        .prepare(`
          INSERT INTO worker_events (worker_run_id, event_type, payload_json, created_at)
          VALUES (?, 'launch', ?, ?)
        `)
        .run(req.runId, JSON.stringify(req), now);
    });

    tx();

    return {
      accepted: true,
      workerId: req.runId,
      startedAt: now,
    };
  }

  async pollStatus(runId: string): Promise<PollEvent[]> {
    const { getSqlite } = await import('@/lib/db');
    const rows = getSqlite()
      .prepare(`
        SELECT event_type, payload_json
        FROM worker_events
        WHERE worker_run_id = ?
        ORDER BY id ASC
      `)
      .all(runId) as WorkerEventRow[];

    const events: PollEvent[] = [];
    for (const row of rows) {
      const payload = parsePayload(row.payload_json, row.event_type);
      if (payload === null) continue;
      const record = isRecord(payload) ? payload : {};

      switch (row.event_type) {
        case 'progress':
          events.push({
            type: 'progress',
            text: typeof record.text === 'string' ? record.text : '',
          });
          break;
        case 'branch_pushed':
          events.push({
            type: 'branch_pushed',
            branch: typeof record.branch === 'string' ? record.branch : '',
            sha: typeof record.sha === 'string' ? record.sha : '',
          });
          break;
        case 'completed':
          events.push({
            type: 'completed',
            result: typeof record.result === 'string' ? record.result : '',
          });
          break;
        case 'errored':
          events.push({
            type: 'errored',
            message: typeof record.message === 'string' ? record.message : '',
          });
          break;
        default:
          break;
      }
    }

    return events;
  }

  async getBranch(runId: string): Promise<GetBranchResponse> {
    const { getSqlite } = await import('@/lib/db');
    const row = getSqlite()
      .prepare(`
        SELECT remote_branch, last_event_at
        FROM worker_runs
        WHERE id = ?
        LIMIT 1
      `)
      .get(runId) as WorkerRunRow | undefined;

    if (!row) {
      throw new Error(`worker_run not found: ${runId}`);
    }
    if (!row.remote_branch) {
      throw new Error('branch not pushed yet');
    }

    return {
      remoteBranch: row.remote_branch,
      pushedAt: row.last_event_at,
    };
  }

  async interrupt(runId: string): Promise<void> {
    const { getSqlite } = await import('@/lib/db');
    const sqlite = getSqlite();
    const now = new Date().toISOString();
    const tx = sqlite.transaction(() => {
      sqlite
        .prepare(`
          INSERT INTO worker_events (worker_run_id, event_type, payload_json, created_at)
          VALUES (?, 'interrupt', '{}', ?)
        `)
        .run(runId, now);

      sqlite
        .prepare(`
          UPDATE worker_runs
          SET status = 'cancelled',
              last_event_at = ?,
              completed_at = ?
          WHERE id = ?
            AND status NOT IN ('completed', 'errored', 'cancelled')
        `)
        .run(now, now, runId);
    });

    tx();
  }
}
