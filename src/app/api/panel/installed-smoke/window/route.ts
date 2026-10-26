import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The native isolated instance reports only after the workspace has painted. */
export async function POST(request: Request) {
  const directory = process.env.O8_DATA_DIR;
  const runId = process.env.O8_INSTALLED_SMOKE_RUN;
  if (process.env.O8_PRESHIP_GATE !== '1' || process.env.O8_FORCE_BUNDLED_SERVERS !== '1'
    || !directory || !isAbsolute(directory) || directory !== process.env.CORTEX_IDE_DATA_DIR
    || !runId || !/^[a-f0-9-]{36}$/.test(runId)) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  if (body?.runId !== runId || body?.ready !== true || typeof body?.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(body.version)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  try {
    writeFileSync(join(directory, 'installed-smoke-window.json'), JSON.stringify({ runId, ready: true, version: body.version }), { mode: 0o600 });
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
