import { resolvePortInfo } from '@/lib/panel/api-port';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
// Preview documents can execute their own scripts but have no app origin.
// Enforce this on the response even when an embedding frame grants same-origin.
export { PREVIEW_DOCUMENT_CSP } from './preview-document-policy';
const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-o8-client-addr',
  'x-o8-worker-packet-id',
]);

export function isSensitivePreviewRequestHeader(header: string): boolean {
  return SENSITIVE_REQUEST_HEADERS.has(header.toLowerCase());
}

export function parseLocalPreviewTarget(targetUrl: string | null): URL | null {
  if (!targetUrl) return null;
  try {
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname)) return null;
    const { apiPort, wsPort } = resolvePortInfo();
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return port === apiPort || port === wsPort ? null : parsed;
  } catch {
    return null;
  }
}
