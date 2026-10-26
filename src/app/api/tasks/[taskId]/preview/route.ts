import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { isTrustedPanelRequest, requirePanelAuth } from '@/lib/panel/auth';
import { isLoopbackHostname } from '@/lib/auth/loopback-request';
import { DEFAULT_CLOUD_TEAM_ID } from '@/lib/cloud/team';
import { ensureReviewServiceJob, stopReviewServiceJob } from '@/lib/cloud/review-service-session';
import { resolveTaskPreview } from '@/lib/cloud/preview-authority';
import { closePreviewServer, openPreviewServer } from '@/lib/cloud/preview-server';
import { readPreviewMessage } from '@/lib/cloud/preview-message';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

function coordinatorOrigin(request: NextRequest): string | null {
  // The packaged Next server may bind 0.0.0.0 (O8_LAN_ACCESS), so nextUrl is not the client's
  // origin. Socket-peer truth must still win over a spoofed loopback Host.
  if (!isTrustedPanelRequest(request)) return null;
  const host = request.headers.get('host');
  if (!host) return null;
  try {
    const url = new URL(`${request.nextUrl.protocol}//${host}`);
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackHostname(url.hostname)
      && url.host === host && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      ? url.origin : null;
  } catch { return null; }
}

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ error: 'Operator authorization is required.' }, { status: 403, headers });
  }
  // This first transport serves the coordinator's native app, not off-host clients.
  const operatorOrigin = coordinatorOrigin(request);
  if (!operatorOrigin) {
    return NextResponse.json({ error: 'Open this preview in the coordinator desktop app.' }, { status: 409, headers });
  }
  try {
    const { taskId } = await context.params;
    const body = await readPreviewMessage(request, 1_024);
    if ((body.serviceJobId !== undefined && typeof body.serviceJobId !== 'string') || !taskId || typeof body.jobId !== 'string' || !Number.isSafeInteger(body.attempt) || Number(body.attempt) < 1) {
      return NextResponse.json({ error: 'Task, job and attempt are required.' }, { status: 400, headers });
    }
    let binding = await resolveTaskPreview(DEFAULT_CLOUD_TEAM_ID, taskId, body.jobId, Number(body.attempt));
    let serviceJobId: string | undefined;
    if (!binding) {
      if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
        return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
      }
      const service = await ensureReviewServiceJob(DEFAULT_CLOUD_TEAM_ID, taskId, body.jobId, Number(body.attempt),
        typeof body.serviceJobId === 'string' ? body.serviceJobId : undefined);
      if (service) {
        serviceJobId = service.id;
        if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
          stopReviewServiceJob(DEFAULT_CLOUD_TEAM_ID, taskId, service.id);
          return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
        }
        binding = await resolveTaskPreview(DEFAULT_CLOUD_TEAM_ID, taskId, body.jobId, Number(body.attempt), service.id);
        if (!binding) return NextResponse.json({ serviceJobId: service.id, expiresAt: service.launch.remoteServiceSession!.expiresAt,
          status: service.status === 'pending' ? 'queued' : 'starting' }, { status: 202, headers });
      }
    }
    if (!binding) return NextResponse.json({ error: 'No healthy preview belongs to this current attempt. Refresh the task.' }, { status: 409, headers });
    if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
      return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
    }
    const preview = await openPreviewServer(binding, operatorOrigin);
    if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
      preview.close(true);
      return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
    }
    return NextResponse.json({ schema: 'o8/task.remote-preview/v1', jobId: binding.jobId, attempt: binding.attempt, service: binding.service.name,
      id: preview.id, url: preview.url, expiresAt: preview.expiresAt, serviceJobId }, { headers });
  } catch {
    return NextResponse.json({ error: 'Remote preview could not be opened.' }, { status: 503, headers });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ error: 'Operator authorization is required.' }, { status: 403, headers });
  }
  const body = await readPreviewMessage(request, 1_024).catch(() => null);
  const { taskId } = await context.params;
  if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
  }
  if (typeof body?.serviceJobId === 'string' && body.keepService !== true) {
    stopReviewServiceJob(DEFAULT_CLOUD_TEAM_ID, taskId, body.serviceJobId);
  }
  if (typeof body?.id !== 'string' && typeof body?.serviceJobId !== 'string') return NextResponse.json({ error: 'Preview id required.' }, { status: 400, headers });
  if (typeof body?.id === 'string') closePreviewServer(body.id, body.keepService !== true);
  return NextResponse.json({ ok: true }, { headers });
}
