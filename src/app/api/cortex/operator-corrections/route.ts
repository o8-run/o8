import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { forgetCorrectionMemory, listCorrectionMemory } from '@/lib/cortex/correction-memory';
import { invalidateAnswerCache } from '@/lib/cortex/qa/ask';
import { publishCortexChange } from '@/lib/realtime/publisher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const refused = () => NextResponse.json({ ok: false, error: 'Operator authority is required.' }, { status: 403, headers });

export async function GET(request: NextRequest) {
  if (resolveRequestPrincipal(request) !== 'operator') return refused();
  const params = request.nextUrl.searchParams;
  const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 50);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ ok: false, error: 'Use a nonnegative offset and a limit from 1 to 100.' }, { status: 400, headers });
  }
  try {
    return NextResponse.json({ ok: true, ...listCorrectionMemory({ offset, limit,
      repoPaths: params.getAll('repoPath').map(value => value.trim()).filter(Boolean), query: params.get('query') ?? '',
    }) }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not load retained corrections. Try again.' }, { status: 500, headers });
  }
}

export async function DELETE(request: NextRequest) {
  if (resolveRequestPrincipal(request) !== 'operator') return refused();
  const body = await request.json().catch(() => null) as { id?: unknown } | null;
  if (!body || typeof body.id !== 'string' || !/^(approval|steer):[A-Za-z0-9._:-]{1,240}$/.test(body.id)) {
    return NextResponse.json({ ok: false, error: 'A qualified correction ID is required.' }, { status: 400, headers });
  }
  try {
    if (!forgetCorrectionMemory(body.id)) return NextResponse.json({ ok: false, error: 'Correction not found in recall.' }, { status: 404, headers });
    invalidateAnswerCache();
    await publishCortexChange({ scope: 'codebase-memory', reason: 'correction-forgotten' });
    return NextResponse.json({ ok: true, id: body.id }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not forget this correction. Try again.' }, { status: 500, headers });
  }
}
