import { childEnvironment } from '@/lib/providers/spawn-environment';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { controlLocalSchedule, readLocalSchedules } from '@/lib/automations/local-schedules';

const execFileAsync = promisify(execFile);
const JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;

interface SourceJob {
  id?: unknown;
  name?: unknown;
  agentId?: unknown;
  enabled?: unknown;
  schedule?: { kind?: unknown; expr?: unknown; tz?: unknown; everyMs?: unknown; at?: unknown };
  state?: { nextRunAtMs?: unknown; lastRunAtMs?: unknown; lastRunStatus?: unknown; lastDeliveryStatus?: unknown };
}

function boundedString(value: unknown, length: number): string | null {
  return typeof value === 'string' ? value.slice(0, length) : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function publicJob(job: SourceJob) {
  if (typeof job.id !== 'string' || !JOB_ID.test(job.id)) return null;
  const kind = job.schedule?.kind;
  return {
    id: job.id,
    name: boundedString(job.name, 160) ?? 'Unnamed automation',
    agentId: boundedString(job.agentId, 80) ?? 'default',
    enabled: job.enabled === true,
    schedule: {
      kind: kind === 'cron' || kind === 'every' || kind === 'at' ? kind : 'unknown',
      expr: boundedString(job.schedule?.expr, 160),
      tz: boundedString(job.schedule?.tz, 80),
      everyMs: timestamp(job.schedule?.everyMs),
      at: boundedString(job.schedule?.at, 80),
    },
    nextRunAt: timestamp(job.state?.nextRunAtMs),
    lastRunAt: timestamp(job.state?.lastRunAtMs),
    lastRunStatus: boundedString(job.state?.lastRunStatus, 40),
    lastDeliveryStatus: boundedString(job.state?.lastDeliveryStatus, 40),
  };
}

async function openclawBinary(): Promise<string> {
  return (await resolveCli({
    runtimeId: 'openclaw-cron',
    binaryName: 'openclaw',
    envOverride: 'O8_OPENCLAW_BIN',
  })).path;
}

async function sourceJobs(binary: string) {
  const { stdout } = await execFileAsync(binary, ['cron', 'list', '--all', '--json'], {
    timeout: 15_000,
    maxBuffer: 2_000_000,
    env: childEnvironment({ env: { FORCE_COLOR: '0', NO_COLOR: '1' } }),
  });
  const parsed = JSON.parse(stdout) as { jobs?: unknown };
  if (!Array.isArray(parsed.jobs)) throw new Error('invalid job list');
  return parsed.jobs.slice(0, 500).flatMap((entry: SourceJob) => {
    const job = publicJob(entry);
    return job ? [job] : [];
  });
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const local = await readLocalSchedules();
  try {
    const jobs = [...await sourceJobs(await openclawBinary()), ...local];
    return NextResponse.json({ ok: true, available: true, jobs }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    // Local rows still show when the optional agent scheduler is missing or down.
    if (local.length) return NextResponse.json({ ok: true, available: true, jobs: local }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
    if (error instanceof CliNotFoundError) {
      return NextResponse.json({ ok: true, installed: false, available: false, jobs: [] });
    }
    return NextResponse.json({ ok: false, available: false, jobs: [], error: 'Connected agent scheduler unavailable.' }, { status: 503 });
  }
}

async function controlled(id: string, action: 'run' | 'pause' | 'resume') {
  try {
    const job = await controlLocalSchedule(id, action);
    if (!job) return NextResponse.json({ ok: false, error: 'job not found' }, { status: 404 });
    return NextResponse.json({ ok: true, job });
  } catch {
    return NextResponse.json({ ok: false, error: 'launchd refused that change.' }, { status: 502 });
  }
}

/** Runs a launchd job now. Other sources run on their own schedule. */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { id?: unknown } | null;
  if (!body || typeof body.id !== 'string' || !JOB_ID.test(body.id) || !body.id.startsWith('launchd-')) {
    return NextResponse.json({ ok: false, error: 'invalid job' }, { status: 400 });
  }
  return controlled(body.id, 'run');
}

export async function PATCH(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { id?: unknown; enabled?: unknown } | null;
  if (!body || typeof body.id !== 'string' || !JOB_ID.test(body.id) || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'invalid job update' }, { status: 400 });
  }
  if (body.id.startsWith('launchd-')) return controlled(body.id, body.enabled ? 'resume' : 'pause');
  try {
    const binary = await openclawBinary();
    const before = await sourceJobs(binary);
    if (!before.some((job) => job.id === body.id)) {
      return NextResponse.json({ ok: false, error: 'job not found' }, { status: 404 });
    }
    await execFileAsync(binary, ['cron', body.enabled ? 'enable' : 'disable', body.id], {
      timeout: 15_000,
      maxBuffer: 128_000,
      env: childEnvironment({ env: { FORCE_COLOR: '0', NO_COLOR: '1' } }),
    });
    const job = (await sourceJobs(binary)).find((entry) => entry.id === body.id);
    if (!job || job.enabled !== body.enabled) {
      return NextResponse.json({ ok: false, error: 'job state could not be verified' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, job });
  } catch {
    return NextResponse.json({ ok: false, error: 'Connected agent scheduler unavailable.' }, { status: 503 });
  }
}
