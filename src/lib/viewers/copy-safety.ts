import { redactOutputText } from '@/lib/acp/output-redaction';
import { viewerRedactionPolicy } from './policy';

/** A display mask is never an editable replacement for a source credential. */
export function isMaskedViewerReplay(source: string, submitted: string): boolean {
  return submitted.includes('[redacted]') && redactOutputText(source, viewerRedactionPolicy()).spans.length > 0;
}
