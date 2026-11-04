import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { collectResourceUsage, killResourceRow } from '@/lib/lane/resource-attribution';
import { sampleMachineResources } from '@/lib/lane/machine-resources';

export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/resource-usage
 *
 * Live per-session CPU/RAM attribution for the Resources panel, plus a
 * `machine` block (host CPU, load, memory, swap, disks, network; null when the
 * host can't be read) from the shared two-second sampler. Gated by the
 * global middleware under `/api/panel/*` (loopback + ws-token) — no auth code
 * needed here. Never throws; returns a structured error payload on failure.
 */
export async function GET() {
  const machine = sampleMachineResources().catch(() => null);
  try {
    const result = await collectResourceUsage();
    return NextResponse.json({ ...result, machine: await machine });
  } catch (error) {
    return NextResponse.json({
      machine: await machine,
      sessions: [],
      processes: [],
      total: { cpuPercent: 0, memBytes: 0, ramTotalBytes: 0 },
      error: error instanceof Error ? error.message : 'Failed to collect resource usage.',
    });
  }
}

/**
 * POST /api/panel/resource-usage
 *
 * Terminate one resource row: `{ pid, key }`. All safety guards live in
 * killResourceRow (pid must be in the current snapshot; o8 core processes are
 * hard-refused; sessions prefer a graceful interrupt). Never throws.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { pid?: unknown; key?: unknown } | null;
    const pid = Number(body?.pid);
    if (!Number.isInteger(pid) || pid <= 1) {
      return NextResponse.json({ ok: false, error: 'A valid process id is required.' });
    }
    const key = typeof body?.key === 'string' ? body.key : null;
    const result = await killResourceRow({ pid, key });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to terminate process.',
    });
  }
}
