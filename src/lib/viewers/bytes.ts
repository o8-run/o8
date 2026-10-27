import { redactOutputText } from '@/lib/acp/output-redaction';
import { viewerRedactionPolicy } from './policy';
import { viewerJson } from './response';
import type { ViewerRedaction } from './route-types';

/** Inspect complete UTF-8 text before delivery; opaque encoded media is refused. */
export function viewerBytes(bytes: Buffer, mimeType: string, init?: ResponseInit, transform?: (text: string) => string): Response {
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('text/') && !['image/svg+xml', 'application/json', 'application/xml'].includes(mime)) {
    return viewerJson({ error: 'Preview unavailable for this file type', code: 'binary_preview_refused' }, { status: 415 });
  }
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes)) return viewerJson({ error: 'Preview requires valid UTF-8 text', code: 'binary_preview_refused' }, { status: 415 });
  const policy = viewerRedactionPolicy();
  const inspected = redactOutputText(raw, policy);
  const safe = transform ? redactOutputText(transform(inspected.text), policy) : inspected;
  const redaction: ViewerRedaction = { version: 1, offsetEncoding: 'utf-8', spans: safe.spans.map(span => ({ ...span, path: '' })) };
  const metadata = JSON.stringify(redaction);
  if (Buffer.byteLength(metadata) > 4096 || mime === 'application/json' && safe.spans.length) {
    return viewerJson({ error: 'Use the marked text preview for this file', code: 'marked_preview_required' }, { status: 415 });
  }
  const headers = new Headers(init?.headers);
  for (const name of ['Content-Range', 'Accept-Ranges', 'Content-Encoding', 'Content-Disposition']) headers.delete(name);
  headers.set('Content-Type', mimeType);
  headers.set('Content-Length', String(Buffer.byteLength(safe.text)));
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-O8-Viewer-Redaction', metadata);
  headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  // Ignore Range requests: slicing the original bytes would bypass source context.
  return new Response(safe.text, { ...init, status: 200, headers });
}
