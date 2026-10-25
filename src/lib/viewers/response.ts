import { NextResponse } from 'next/server';
import { redactOutputText } from '@/lib/acp/output-redaction';
import { viewerRedactionPolicy } from './policy';
import type { ViewerRedaction, ViewerRouteResponse } from './route-types';

/** Serialize all display strings, including nested patches, cache hits and errors. */
export function viewerJson<T extends object>(value: T, init?: ResponseInit): NextResponse<ViewerRouteResponse<T>> {
  const redaction: ViewerRedaction = { version: 1, offsetEncoding: 'utf-8', spans: [] };
  const policy = viewerRedactionPolicy();
  const visit = (item: unknown, path: string): unknown => {
    if (typeof item === 'string') {
      const result = redactOutputText(item, policy);
      redaction.spans.push(...result.spans.map(span => ({ ...span, path })));
      return result.text;
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, `${path}/${index}`));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)]));
    return item;
  };
  const safe = visit(value, '') as T;
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json({ ...safe, redaction }, { ...init, headers });
}
