import { NextResponse } from 'next/server';

import { verifyCloudWorkerKey } from '@/lib/cloud/worker-auth';
import { ForgottenCloudContextError, workerLaunchPayload } from '@/lib/cloud/worker-payload';
import { getJob, getJobMetrics, listJobControls, readJobEvents } from '@/lib/cloud/job-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'Unauthorized' : 'Forbidden', reason: auth.reason },
      { status: auth.status, headers: NO_STORE_HEADERS },
    );
  }
  const url = new URL(request.url);
  const jobId = url.searchParams.get('jobId')?.trim();
  const sinceId = Number.parseInt(url.searchParams.get('sinceId') ?? '0', 10);
  if (!jobId || !Number.isFinite(sinceId) || sinceId < 0) {
    return NextResponse.json(
      { error: 'A valid jobId and non-negative sinceId are required' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const job = getJob(auth.teamId, jobId);
  if (!job) {
    return NextResponse.json(
      { error: 'Cloud job not found' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  let launch: ReturnType<typeof workerLaunchPayload>;
  try { launch = workerLaunchPayload(job.launch); } catch (error) {
    if (error instanceof ForgottenCloudContextError) return NextResponse.json({ error: error.message, reason: 'memory_changed' }, { status: 409, headers: NO_STORE_HEADERS });
    return NextResponse.json({ error: 'Could not read cloud worker context.' }, { status: 500, headers: NO_STORE_HEADERS });
  }
  return NextResponse.json({
    job: { ...job, launch },
    metrics: getJobMetrics(auth.teamId, jobId),
    controls: listJobControls(auth.teamId, jobId),
    events: readJobEvents(auth.teamId, jobId, sinceId),
  }, { headers: NO_STORE_HEADERS });
}
