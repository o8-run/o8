import { createHmac, timingSafeEqual } from 'node:crypto';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { parseLocalPreviewTarget } from './preview-proxy-security';

const RESOURCE_TTL_MS = 60 * 60 * 1000;
export const PREVIEW_RESOURCE_KEY = 'previewResource';

function signature(origin: string, expires: string): string {
  return createHmac('sha256', getOrCreateWsToken()).update(JSON.stringify(['preview-resource', origin, expires])).digest('hex');
}

/** Grants anonymous resource reads for one already-opened preview origin only. */
export function createPreviewResourceAccess(target: URL): string {
  const expires = String(Date.now() + RESOURCE_TTL_MS);
  return `${expires}.${signature(target.origin, expires)}`;
}

export function hasPreviewResourceAccess(url: URL): boolean {
  const target = parseLocalPreviewTarget(url.searchParams.get('url'));
  const match = /^(\d+)\.([a-f0-9]{64})$/.exec(url.searchParams.get(PREVIEW_RESOURCE_KEY) ?? '');
  if (!target || !match) return false;
  const expires = Number(match[1]);
  if (expires <= Date.now() || expires > Date.now() + RESOURCE_TTL_MS) return false;
  return timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(signature(target.origin, match[1]), 'hex'));
}
