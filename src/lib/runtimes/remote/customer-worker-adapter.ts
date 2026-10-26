import { assertRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import type {
  LaunchOptions,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeTranscriptEntry,
} from '../types';
import { RemoteRuntimeAdapter } from './base-adapter';
import type { LaunchRequest } from './protocol';
import { CustomerWorkerTransport } from './customer-worker-transport';

interface WorkerTranscriptRow {
  id: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizeEvent(eventType: string, payload: unknown) {
  const record = isRecord(payload) ? payload : {};

  switch (eventType) {
    case 'progress':
      return typeof record.text === 'string' ? record.text : '';
    case 'branch_pushed': {
      const branch = typeof record.branch === 'string' ? record.branch : '';
      const sha = typeof record.sha === 'string' ? record.sha : '';
      return sha ? `Branch pushed: ${branch} (${sha.slice(0, 7)})` : `Branch pushed: ${branch}`;
    }
    case 'completed':
      return `Completed: ${typeof record.result === 'string' ? record.result : ''}`;
    case 'errored':
      return `Error: ${typeof record.message === 'string' ? record.message : ''}`;
    case 'launch':
      return 'Launch requested.';
    case 'interrupt':
      return 'Interrupt requested.';
    default:
      return `Event: ${eventType}`;
  }
}

async function gitStdout(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return String(stdout).trim();
}

export class CustomerWorkerAdapter extends RemoteRuntimeAdapter {
  constructor() {
    super({ transport: new CustomerWorkerTransport(), runtimeId: 'remote-customer' });
  }

  readonly displayName = 'Remote Worker (Customer)';

  // #565 — reviewDiffs is declared false until getChangedFiles stops being a
  // stub. The UI reads capabilities to decide whether to surface the diff tab;
  // advertising reviewDiffs=true with a stub returning [] opens an empty panel
  // the operator thinks is the actual review surface. Flip to true the moment
  // getChangedFiles has a real gh/git-diff implementation.
  readonly capabilities: RuntimeCapabilities = {
    discover: false,
    readTranscript: true,
    launch: true,
    resume: false,
    interrupt: true,
    reviewDiffs: false,
    costTelemetry: false,
    streaming: false,
  };

  protected async buildLaunchRequest(opts: LaunchOptions, runId: string): Promise<LaunchRequest> {
    assertRuntimeEffortPin(this.id, opts.model, opts.effort);
    const repoUrl = await gitStdout(opts.cwd, ['config', '--get', 'remote.origin.url']);
    if (!repoUrl) {
      throw new Error('remote.origin.url is not configured');
    }

    const baseRef = opts.worktreeFlag?.trim() || await gitStdout(opts.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!baseRef) {
      throw new Error('Unable to resolve base ref');
    }

    return {
      runId,
      laneId: opts.laneId,
      repoUrl,
      baseRef,
      remoteBranch: `agent/remote-${runId.slice(0, 8)}`,
      packetPrompt: opts.prompt,
      modelHint: opts.model,
      effort: opts.effort,
    };
  }

  async readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]> {
    const { getSqlite } = await import('@/lib/db');
    const runId = this.runIdFromSessionKey(sessionKey);
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), 5000)
      : 500;
    const sqlite = getSqlite();
    const whereSince = sinceId ? 'AND id > CAST(? AS INTEGER)' : '';
    const rows = sqlite
      .prepare(`
        SELECT id, event_type, payload_json, created_at
        FROM worker_events
        WHERE worker_run_id = ?
          ${whereSince}
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(...(sinceId ? [runId, sinceId, safeLimit] : [runId, safeLimit])) as WorkerTranscriptRow[];

    return rows.map((row) => {
      let payload: unknown = {};
      try {
        payload = JSON.parse(row.payload_json) as unknown;
      } catch (error) {
        console.error(
          `[remote-customer] failed to parse transcript payload for ${row.event_type}:`,
          error instanceof Error ? error.message : String(error),
        );
      }

      return {
        id: String(row.id),
        role: 'tool',
        text: summarizeEvent(row.event_type, payload),
        timestamp: new Date(row.created_at),
        type: 'message',
      };
    });
  }

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    void message;
    return {
      ok: false,
      note: 'resume not supported for remote-customer runtime',
      sessionKey,
    };
  }

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    try {
      await this.getBranch(sessionKey);
    } catch (error) {
      if (error instanceof Error && error.message === 'branch not pushed yet') {
        return [];
      }
      throw error;
    }

    console.warn('[remote-customer] getChangedFiles stub — implement gh-diff integration in follow-up');
    return [];
  }
}
