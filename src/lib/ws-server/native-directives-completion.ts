import type { IncomingMessage } from 'node:http';
import { NextRequest } from 'next/server';
import { recordTiming } from '@/lib/cortex/diagnostics';
const LIMIT = 8 * 1024 * 1024;

/** One private route-specific receipt. No scan, scope cache or metrics writer here. */
export async function completeNativeDirectives(req: IncomingMessage, authenticated: boolean, request: NextRequest): Promise<Response> {
  if (!authenticated || req.method !== 'POST' || req.headers['x-o8d-session-read'] !== 'complete-directives/1') return new Response(null, { status: 409 });
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > LIMIT) return new Response(null, { status: 409 });
    chunks.push(Buffer.from(chunk));
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { value = null; }
  const strings = (v: unknown) => Array.isArray(v) && v.every(item => typeof item === 'string');
  const valid = value?.version === 1 && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 120_000
    && value.body && Object.keys(value.body).length === 1 && Array.isArray(value.body.directives)
    && value.body.directives.length <= 1024 && value.body.directives.every((row: Record<string, unknown>) => row && typeof row === 'object'
      && ['id', 'title', 'scope', 'body'].every(key => typeof row[key] === 'string')
      && (row.repoName === null || typeof row.repoName === 'string') && (row.file === null || typeof row.file === 'string')
      && (row.priority === null || typeof row.priority === 'number' && Number.isFinite(row.priority))
      && strings(row.projects) && strings(row.recentMerges) && Object.keys(row).length === 9);
  if (!valid) {
    // An unusable native result is discarded before recording. The original
    // GET supplies both the response and its one canonical timing write.
    const response = await (await import('@/app/api/cortex/directives/route')).GET(request);
    response.headers.set('x-o8d-local-stage', 'directives/1');
    return response;
  }
  // Keep canonical initialization, pruning, and swallowed write failures intact.
  recordTiming({ label: 'recall.directives', durationMs: value.durationMs, timestamp: Date.now() });
  return Response.json(value.body, { headers: { 'cache-control': 'no-store, max-age=0' } });
}
