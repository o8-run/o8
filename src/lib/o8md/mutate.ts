/*
 * o8.md mutation companions — the splice operations the vendored RFM parser
 * (./rfm) does not expose as public functions. Roughdraft's editor app does
 * these in the browser; for the headless o8 path (API) we add them
 * here, in the same splice-only style as appendRoughdraftReply.
 *
 * This file is o8-authored (NOT vendored). It builds on the vendored parser's
 * PUBLIC surface only (extractRoughdraftReviewIndex), and emits the documented
 * RFM wire format (CriticMarkup marker + quoted-attribute block). The
 * rfm.smoke.ts round-trip is the guardrail: anything emitted here is parsed
 * back by the real parser, so a serialization drift fails the smoke rather
 * than silently corrupting o8.md.
 *
 * The metadata-attribute grammar + close-delimiter set are part of the RFM
 * spec (not copyrightable expression); the vendored grammar lives in rfm.ts.
 */

import { extractRoughdraftReviewIndex } from './rfm';

/** Marker close delimiters — reproduced from the RFM spec. A comment body that
 *  contains one of these would terminate the marker early and corrupt the doc. */
const CRITICMARKUP_CLOSE_DELIMITER = /<<}|\+\+}|--}|~~}|==}/;

export interface AppendCommentOptions {
  /** The comment text (rendered between {>> and <<}). Required. */
  body: string;
  /** Optional anchor: first occurrence of this literal text is wrapped in a
   *  {==highlight==} and the comment attached to it. Omit for a standalone note. */
  anchor?: string;
  /** Author label. Defaults to "AI" — the inversion's agent-annotation author. */
  author?: string;
}

/** Throws if a value can't sit safely inside a quoted attribute block. We
 *  reject rather than escape so we never depend on the parser's un-escaping. */
function assertSafeAttributeValue(value: string, field: string): void {
  if (/["\\{}]/.test(value)) {
    throw new Error(`${field} must not contain quotes, backslashes, or braces`);
  }
}

/** Reject marker content that would close a CriticMarkup marker early. */
function guardMarkerText(value: string): void {
  const match = value.match(CRITICMARKUP_CLOSE_DELIMITER);
  if (match) {
    throw new Error(
      `Text contains CriticMarkup close delimiter "${match[0]}". Rewrite without raw CriticMarkup delimiters.`,
    );
  }
}

/** Next document-local id for a prefix. Comments + replies share `c`;
 *  suggestions use `s`. Mirrors the parser's id scheme. */
function nextId(markdown: string, prefix: 'c' | 's'): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const item of extractRoughdraftReviewIndex(markdown).items) {
    const match = pattern.exec(item.id);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}${max + 1}`;
}

function serializeMetadata(attrs: Record<string, string>): string {
  const body = Object.entries(attrs)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `{${body}}`;
}

/**
 * Append a new comment to o8.md. Standalone (appended at end of doc) or anchored
 * to the first literal occurrence of `anchor`. Splice-only: every byte outside
 * the inserted marker is preserved. Returns the updated markdown.
 *
 * Throws on: a body containing a raw close delimiter, an unsafe author value,
 * or an anchor that isn't found.
 */
export function appendComment(markdown: string, options: AppendCommentOptions): string {
  guardMarkerText(options.body);
  const author = options.author ?? 'AI';
  assertSafeAttributeValue(author, 'author');

  const metadata = serializeMetadata({
    id: nextId(markdown, 'c'),
    by: author,
    at: new Date().toISOString(),
  });
  const comment = `{>>${options.body}<<}${metadata}`;

  if (options.anchor !== undefined && options.anchor !== '') {
    const at = markdown.indexOf(options.anchor);
    if (at === -1) {
      throw new Error(`Anchor text not found in o8.md: ${JSON.stringify(options.anchor)}`);
    }
    const wrapped = `{==${options.anchor}==}${comment}`;
    return `${markdown.slice(0, at)}${wrapped}${markdown.slice(at + options.anchor.length)}`;
  }

  // Standalone note appended at the end, on its own line.
  const separator = markdown.length === 0 || markdown.endsWith('\n') ? '' : '\n';
  return `${markdown}${separator}${comment}\n`;
}

export interface ApplySuggestionOptions {
  targetId: string;
  /** Accept applies the proposed edit; false dismisses it and restores the
   * original prose. Defaults to true. */
  accept?: boolean;
}

/**
 * Splice a CriticMarkup SUGGESTION (proposed edit) into o8.md — a non-destructive
 * proposal the operator accepts or rejects; the original text is preserved inside
 * the marker. Splice-only. Suggestion ids use the `s` prefix.
 *
 *   add → {++text++}{meta}                   (at anchor, else appended)
 *   del → {--anchor--}{meta}                  (proposes cutting the anchor)
 *   sub → {~~anchor~>replacement~~}{meta}     (proposes replacing the anchor)
 *
 * Throws on: marker text with a raw close delimiter, an unsafe author, a missing
 * required field for the kind, an anchor that isn't found, or a `~>` inside a
 * substitution operand (which would confuse the old/new split).
 */
export function applySuggestion(markdown: string, options: ApplySuggestionOptions): string {
  const item = extractRoughdraftReviewIndex(markdown).items.find((candidate) => candidate.id === options.targetId);
  if (!item) throw new Error(`Review item not found: ${options.targetId}`);
  if (item.kind !== 'suggestion' || !item.suggestionKind) {
    throw new Error(`Review item is not a suggestion: ${options.targetId}`);
  }

  const accept = options.accept !== false;
  let replacement: string;
  if (item.suggestionKind === 'addition') {
    replacement = accept ? item.text : '';
  } else if (item.suggestionKind === 'deletion') {
    replacement = accept ? '' : (item.originalText ?? item.text);
  } else {
    replacement = accept
      ? (item.replacementText ?? item.text)
      : (item.originalText ?? '');
  }

  return `${markdown.slice(0, item.offset)}${replacement}${markdown.slice(item.endOffset)}`;
}
