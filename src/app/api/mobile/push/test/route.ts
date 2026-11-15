/**
 * POST /api/mobile/push/test
 *
 * Sends a "this is a test" push to every registered subscription. Used by
 * the mobile Settings sheet "Send test" button so the user can verify the
 * end-to-end flow before relying on it.
 *
 * Issue: https://github.com/o8-run/o8/issues/639
 */

import { NextResponse } from 'next/server';
import { notifyAll } from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const results = await notifyAll({
      title: 'o8 — test push',
      body: 'If you see this, push notifications are working.',
      tag: 'o8-push-test',
      data: { kind: 'test' },
    });

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;

    return NextResponse.json({
      ok: true,
      delivered: okCount,
      failed: failCount,
      total: results.length,
      results,
    });
  } catch (error) {
    console.error('[mobile/push/test] failed', error);
    return NextResponse.json({ error: 'Failed to send test push.' }, { status: 500 });
  }
}
