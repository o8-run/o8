import type { RedactedSpan } from '@/lib/acp/output-redaction';

/**
 * Native viewer wire contract, version 1. Every serialized viewer payload includes
 * this envelope, even when there are no credentials or the route returns an
 * error. Authentication/transport refusals may be unmarked and must never be
 * treated as viewer content. Text fields retain their existing locations in the response.
 *
 * path is an RFC 6901 JSON pointer to a string in THIS response (array indexes
 * are decimal). start/end are half-open UTF-8 BYTE offsets into that decoded
 * string after masking, never offsets into JSON escapes or the original file.
 * Spans are ordered by traversal and, within each field, sorted and disjoint.
 * Each span currently covers the literal [redacted], with kind credential.
 * No secret, original secret length, or reversible source mapping is transmitted.
 *
 * Native consumers must require version 1 and utf-8, validate bounds, render
 * each marked range as an opaque masked chip, and exclude it from selection,
 * clipboard, drag and export. Reject absent/unknown envelopes or invalid spans.
 * An empty spans array means the server inspected the payload and found none.
 * Raw UTF-8 asset responses carry this envelope in X-O8-Viewer-Redaction;
 * their span paths are the empty pointer, referring to the entire decoded body.
 * Original byte ranges are never served before complete-source inspection.
 * Opaque binary formats are refused until their decoded content can be inspected.
 * Documents containing opaque data URIs or entity-defined payloads are withheld.
 * Partial diff sections require complete source verification; unavailable or
 * mismatched source sections are opaque masks. Hunk-heading excerpts are omitted.
 * The literal [redacted] is reserved: changed buffers containing it are read-only,
 * independently of credential rotation, revocation or server restarts.
 * This is a display/read contract; it does not authorize saving masked text.
 */
export interface ViewerRedaction {
  version: 1;
  offsetEncoding: 'utf-8';
  spans: Array<RedactedSpan & { path: string }>;
}

export type ViewerRouteResponse<T> = T & { redaction: ViewerRedaction };
