import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { dispatchTask, readTaskEffortSelection, TaskMutationError, type TaskDispatchInput } from './actions';

/** Internal data-only operation. The caller has already admitted the HTTP/MCP principal. */
export async function POST(request: Request): Promise<Response> {
  if (!isNativeCortexReader() || process.env.O8_NEXT_O8D !== '1') {
    return Response.json({ error: 'Task dispatch requires the native owner.' }, { status: 503 });
  }
  if (!headersIndicateLoopback(name => request.headers.get(name)) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return Response.json({ error: 'Task dispatch owner requires the local operator.' }, { status: 403 });
  }
  try {
    const body = await request.json();
    if (!body || typeof body.taskId !== 'string' || !body.taskId.trim() || !body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
      return Response.json({ error: 'Task dispatch data is required.' }, { status: 400 });
    }
    const raw = body.input as Record<string, unknown>;
    const strings = ['projectId', 'repoPath', 'message', 'model', 'workerIntent', 'requestedProvider', 'requestedRuntime'] as const;
    const allowed = new Set<string>([...strings, 'waitForLaunch', 'actor', 'requestedEffort']);
    if (strings.some(key => raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string')
      || (raw.waitForLaunch !== undefined && typeof raw.waitForLaunch !== 'boolean')
      || (raw.actor !== undefined && !['user', 'system', 'orchestrator'].includes(String(raw.actor)))
      || Object.keys(raw).some(key => !allowed.has(key))) {
      return Response.json({ error: 'Invalid task dispatch data.' }, { status: 400 });
    }
    const input: TaskDispatchInput = {
      ...Object.fromEntries(strings.map(key => [key, raw[key]])),
      actor: raw.actor as TaskDispatchInput['actor'],
      waitForLaunch: raw.waitForLaunch as boolean | undefined,
      requestedEffort: readTaskEffortSelection(raw),
    };
    return Response.json(await dispatchTask(body.taskId, input), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Task dispatch failed.' }, {
      status: error instanceof TaskMutationError ? error.status : 500, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
