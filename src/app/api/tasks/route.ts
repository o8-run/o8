import { RuntimeSelectionError, validateRequestedRuntime } from '@/lib/agents/routing';
import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { createTask, readTaskEffortSelection, TaskMutationError } from '@/lib/tasks/actions';
import { getTaskPool } from '@/lib/tasks/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const principal = resolveRequestPrincipalContext(request);
  const refusal = workerPacketRefusal(principal, principal.role === 'worker' ? principal.packetId : null);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 403 });
  const params = request.nextUrl.searchParams;
  const projectId = params.get('projectId')?.trim() || null;
  const repoPath = params.get('repoPath')?.trim() || null;
  const includeDone = params.get('includeDone') === 'true';
  const includeBrief = params.get('includeBrief') === 'true';

  try {
    const pool = await getTaskPool({
      projectId, repoPath, includeDone, includeBrief,
      packetId: principal.role === 'worker' ? principal.packetId : undefined,
    });
    return NextResponse.json(pool, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to read task pool.' },
      { status: 500 },
    );
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function optionalIssueSource(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const number = typeof record.number === 'number' && Number.isFinite(record.number)
    ? Math.trunc(record.number)
    : null;
  const body = optionalString(record.body);
  const url = optionalString(record.url);
  if (!number && !body && !url) return null;
  return { number, body, url };
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  try {
    const result = await createTask({
      actor: 'orchestrator',
      title: optionalString(body.title) ?? '',
      summary: optionalString(body.summary) ?? optionalString(body.message),
      projectId: optionalString(body.projectId),
      repoPath: optionalString(body.repoPath),
      model: optionalString(body.model),
      requestedEffort: readTaskEffortSelection(body),
      workerIntent: optionalString(body.workerIntent),
      requestedProvider: optionalString(body.requestedProvider),
      requestedRuntime: validateRequestedRuntime(body.requestedRuntime),
      allowedFiles: optionalStringArray(body.allowedFiles),
      sourceIssue: optionalIssueSource(body.sourceIssue),
    });
    return NextResponse.json(result, {
      status: 201,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task creation failed.';
    const status = error instanceof TaskMutationError || error instanceof RuntimeSelectionError ? error.status : 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
