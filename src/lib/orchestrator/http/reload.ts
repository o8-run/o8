/**
 * POST /api/orchestrator/reload
 *
 * Triggers a graceful orchestrator reload after a conversational MCP install
 * (see `cortex.register_mcp` in src/lib/mcp/cortex-mcp-server.ts). The
 * orchestrator spawns a fresh Claude Code subprocess on every user turn with
 * the latest MCP config derived from the external-servers table, so "reload"
 * here means:
 *
 *   1. Preserve the session's Claude session id so the NEXT turn resumes the
 *      existing transcript via `--resume`.
 *   2. Abort any in-flight turn so the user isn't stuck waiting on stale
 *      tooling mid-stream.
 *   3. Broadcast a `notice` event to every orchestrator WS subscriber for
 *      this repo so the UI can render a short-lived reload banner.
 *
 * The middleware at src/middleware.ts already gates `/api/orchestrator/*` on
 * loopback + panel token, so this endpoint doesn't need its own auth.
 */
import { NextRequest } from 'next/server';
import { reloadOrchestratorSession } from '@/lib/lane/orchestrator-session';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { listRepos } from '@/lib/repos/registry';
import { resolveOrchestratorRepoPath } from '@/lib/orchestrator/repo-path';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '@/app/api/orchestrator/_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function resolveRepoPath(value: unknown): Promise<string | null> {
  const explicitRepoPath = typeof value === 'string' ? value.trim() : '';
  if (explicitRepoPath) {
    return resolveOrchestratorRepoPath(explicitRepoPath);
  }

  const repos = await listRepos().catch(() => []);
  return repos.length === 1 ? repos[0]?.localPath?.trim() ?? null : null;
}

interface ReloadBroadcastResult {
  ok: boolean;
  aborted?: boolean;
  delivered?: number;
  noticeId?: string;
  error?: string;
}

async function broadcastReloadNotice(body: {
  repoPath: string;
  message?: string;
  registered?: string[];
  noticeId?: string;
}): Promise<ReloadBroadcastResult> {
  const { wsPort } = resolvePortInfo();
  try {
    const response = await fetch(`http://127.0.0.1:${wsPort}/internal/orchestrator-reload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      return { ok: false, error: `ws-server responded ${response.status}` };
    }
    const parsed = await response.json().catch(() => null) as ReloadBroadcastResult | null;
    return parsed ?? { ok: true };
  } catch (error) {
    // Best-effort — the next orchestrator turn will pick up the new MCP
    // config regardless, so this isn't a hard failure.
    console.error('[orchestrator-reload] Notice broadcast failed:', error);
    return {
      ok: false,
      error: 'Unable to broadcast reload notice.',
    };
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  const repoPath = await resolveRepoPath(record?.repoPath);
  if (!repoPath) {
    return operatorError(
      'invalid_request',
      'repoPath is required unless there is exactly one registered repository.',
      400,
    );
  }

  const registered = Array.isArray(record?.registered)
    ? (record.registered as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  const message = typeof record?.message === 'string' && record.message.trim()
    ? record.message.trim()
    : undefined;
  const noticeId = typeof record?.noticeId === 'string' && record.noticeId.trim()
    ? record.noticeId.trim()
    : `mcp-reload-${Date.now()}`;

  try {
    const reload = reloadOrchestratorSession(repoPath);
    const broadcast = await broadcastReloadNotice({
      repoPath: reload.repoPath,
      message,
      registered,
      noticeId,
    });

    return operatorSuccess({
      repoPath: reload.repoPath,
      sessionName: reload.sessionName,
      sessionId: reload.claudeSessionId,
      noticeId,
      broadcast,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to reload orchestrator session.';
    return operatorError('reload_failed', detail, 500, error);
  }
}
