import { viewerRedactionPolicy } from '@/lib/viewers/policy';

const MAX_STRINGS = 1024;
const MAX_STRING_BYTES = 16 * 1024;
export const VIEWER_GRANT_LIMIT = 1024 * 1024;

/** Authenticated admission body only. No persistence, logging, or shared snapshot. */
export function viewerRedactionGrant(defaultsContext: object): string | null {
  const policy = viewerRedactionPolicy();
  const redaction = {
    normalizedValues: [...(policy.normalizedValues ?? [])],
    activeCredentialHashes: [...(policy.activeCredentialHashes ?? [])],
  };
  const strings = Object.values(redaction).flat();
  if (strings.length > MAX_STRINGS || strings.some(value => Buffer.byteLength(value) > MAX_STRING_BYTES)) return null;
  const body = JSON.stringify({ version: 1, defaultsContext, redaction });
  return Buffer.byteLength(body) <= VIEWER_GRANT_LIMIT ? body : null;
}
