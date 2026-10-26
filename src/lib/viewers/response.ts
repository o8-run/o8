import { NextResponse } from 'next/server';
import { redactOutputText, type OutputRedactionContext } from '@/lib/acp/output-redaction';
import { viewerRedactionPolicy } from './policy';
import type { ViewerRedaction, ViewerRouteResponse } from './route-types';

/** Serialize all display strings, including nested patches, cache hits and errors. */
export function viewerJson<T extends object>(value: T, init?: ResponseInit, suppliedPolicy?: OutputRedactionContext): NextResponse<ViewerRouteResponse<T>> {
  const redaction: ViewerRedaction = { version: 1, offsetEncoding: 'utf-8', spans: [] };
  const policy = suppliedPolicy ?? viewerRedactionPolicy();
  const visit = (item: unknown, path: string, previewFragment = false): unknown => {
    if (typeof item === 'string') {
      const partial = (previewFragment || /\/(?:diff|patch)$/.test(path)) && item.length > 0 && !policy.verifiedDiffs?.has(item);
      const result = partial ? { text: '[redacted]', spans: [{ start: 0, end: 10, kind: 'credential' as const }] } : redactOutputText(item, policy);
      redaction.spans.push(...result.spans.map(span => ({ ...span, path })));
      return result.text;
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, `${path}/${index}`));
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, visit(child, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, (key === 'preview' && typeof record.path === 'string' && typeof record.status === 'string' && record.previewKind !== 'file') || (['oldText', 'newText', 'content'].includes(key) && typeof record.tool === 'string' && typeof record.file === 'string'))]));
    }
    return item;
  };
  const safe = visit(value, '') as T;
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json({ ...safe, redaction }, { ...init, headers });
}
