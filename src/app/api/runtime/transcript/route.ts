import { NextRequest, NextResponse } from 'next/server';
import { performance } from 'node:perf_hooks';
import { readSessionSteerTranscriptEvents } from '@/lib/orchestrator/packet-transcript';
import { readRuntimeTranscript } from '@/lib/runtime/transcript';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const sessionKey = request.nextUrl.searchParams.get('sessionKey');
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }

  const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10);
  const sinceId = request.nextUrl.searchParams.get('sinceId') ?? undefined;

  try {
    const entries = await readRuntimeTranscript(sessionKey, { sinceId, limit });
    const transcript = entries.map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.text,
      tokens: entry.tokens,
      model: entry.model,
      type: entry.type ?? 'message',
      timestamp: entry.timestamp.getTime(),
      timestampLabel: entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      toolName: entry.toolName,
      filePath: entry.filePath,
      compaction: entry.compaction ? {
        timestamp: entry.compaction.timestamp.getTime(),
        tokensBefore: entry.compaction.tokensBefore,
        tokensAfter: entry.compaction.tokensAfter,
        trigger: entry.compaction.trigger,
        source: entry.compaction.source,
        summary: entry.compaction.summary,
      } : undefined,
    }));
    for (const event of readSessionSteerTranscriptEvents(sessionKey)) {
      const timestamp = new Date(event.ts);
      const timestampMs = Number.isFinite(timestamp.getTime()) ? timestamp.getTime() : Date.now();
      const timestampLabel = new Date(timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      transcript.push({
        id: `steer-${event.seq}`,
        role: 'user',
        tokens: undefined,
        model: undefined,
        text: `${event.failed ? 'Steer failed to start' : event.source} · ${timestampLabel}\n\n${event.text}${event.note && event.note !== event.text ? `\n\n${event.note}` : ''}`,
        type: 'message',
        timestamp: timestampMs,
        timestampLabel,
        toolName: undefined,
        filePath: undefined,
        compaction: undefined,
      });
    }
    transcript.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
    return NextResponse.json({ transcript }, {
      headers: { 'Cache-Control': 'no-store, max-age=0', 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read transcript';
    const status = message.startsWith('Cannot determine runtime') || message.includes('does not support transcript reading')
      ? 400
      : 500;
    console.error('[runtime-transcript] read failed:', error);
    return NextResponse.json(
      { error: status < 500 ? message : 'Unable to read transcript' },
      { status, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
    );
  }
}
