/*
 * Headless o8.md review — the background "one-shot lane" for the spec surface.
 *
 * Instead of pre-filling the visible orchestrator composer, the sparkle button
 * calls this: a single LLM turn (Sonnet-5 at xhigh effort through the warm
 * subscription REPL pool, decoupled from the orchestrator/Brain toggles; Codex
 * only as a fallback when no `claude` binary resolves or the warm call throws)
 * that READS the operator's o8.md and RETURNS a JSON list of annotations. We
 * apply them via the same splice functions the API/CLI/MCP use (appendComment /
 * insertSuggestion). The orchestrator session is never touched, so the review
 * never appears in the chat — it just lands on the rail.
 *
 * The LLM returns structured JSON (not tool calls): far more reliable for a
 * one-shot than a headless tool-calling loop, and it keeps the whole thing a
 * pure (content) -> (content) transform the route can write + byte-check.
 */

import 'server-only';

import { execSync } from '@/lib/providers/child-process';
import { askClaudeWarm, prewarmClaudeRepl } from '@/lib/claude-code/warm-repl-pool';
import { defaultClaudeBin } from '@/lib/claude-code/one-shot-repl';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { MODEL_IDS } from '@/lib/models';
import { appendRoughdraftReply, extractRoughdraftReviewIndex, type RfmReviewItem } from './rfm';
import { appendComment, insertSuggestion, type SuggestionKind } from './mutate';

/** One annotation the LLM proposes. Mirrors the comment/suggest write surface. */
interface ReviewAnnotation {
  kind?: string;
  anchor?: string;
  body?: string;
  suggestionKind?: string;
  text?: string;
  replacement?: string;
}

export interface SpecReviewResult {
  applied: number;
  skipped: number;
  total: number;
  backend: 'claude' | 'codex';
}

export interface SingleNoteReplyResult {
  backend: 'claude' | 'codex';
  parentId: string;
  reply: string;
}

/** Generous cap on the doc slice we hand the model — the o8.md byte cap is
 *  256KB but a notes file is normally tiny; this just bounds a runaway. */
const MAX_CONTENT_CHARS = 24_000;

/**
 * The o8.md review always runs on Sonnet-5 at xhigh effort through the warm
 * subscription REPL pool — decoupled from the orchestrator/Brain toggles (the
 * routing lives in {@link runLLM}). Deliberately NOT the shared SONNET_CLI_MODEL
 * in sonnet-adapter.ts, which has other callers pinned to a different model.
 */
const REVIEW_MODEL = MODEL_IDS.claudeReviewDefault;
const REVIEW_EFFORT = 'xhigh';
/** System framing prepended to the user prompt for the warm one-shot frame
 *  (mirrors callSonnetCli's `<system>…</system>` shape, sonnet-adapter.ts). */
const REVIEW_SYSTEM = 'You review o8.md working notes and leave terse margin annotations. You never rewrite the prose. You output ONLY a JSON array of annotation objects and nothing else.';
const SINGLE_NOTE_SYSTEM = 'You are continuing exactly one o8.md margin-note conversation. Reply only to that note and its anchor. Output only the concise reply text, with no JSON, annotation markers, markdown fence, or preamble.';

function recentCommits(repoPath: string): string {
  try {
    return execSync('git log --oneline -40', { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
  } catch {
    return '';
  }
}

function buildPrompt(content: string, commits: string): string {
  const doc = content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content;
  return `You are o8, working alongside the person who wrote these o8.md notes. They just pressed the check button, so read the notes the way you would read messages addressed to you. Your replies appear directly under the paragraph they answer, in a small handwritten note, like one side of a chat. Do NOT rewrite their prose.

Go through the notes paragraph by paragraph and decide what each one needs:
- A question: answer it. If you cannot tell from what you have, say what you would need to check.
- Work they say is done or still to do: use the commits below. Say it shipped and name the short hash, or say it has not landed. Never guess a status.
- A decision or plan: flag it only if a commit contradicts it or it conflicts with another paragraph.
- A vague idea: ask the one question that would make it buildable, or state how you would do it.

Reply only where it changes what they do or know. Stay silent on the rest, and skip proofreading and praise. Text inside {>> <<} marks is an earlier note thread: skip a paragraph that already has one unless something changed. If nothing needs a reply, return an empty array.

Recent commits (use these to judge what's already shipped vs. still open):
${commits || '(unavailable)'}

The o8.md notes:
"""
${doc}
"""

Return ONLY a JSON array (no prose, no markdown code fence) of annotation objects. Each is one of:
- {"kind":"comment","anchor":"<exact phrase copied verbatim from the notes>","body":"<your 1-2 sentence note>"}
- {"kind":"suggestion","suggestionKind":"sub","anchor":"<exact phrase>","replacement":"<new text>"}
- {"kind":"suggestion","suggestionKind":"add","anchor":"<exact phrase to add after>","text":"<text to add>"}
- {"kind":"suggestion","suggestionKind":"del","anchor":"<exact phrase to remove>"}

Hard rules: every "anchor" MUST be an exact, character-for-character substring of the notes above, copied from outside any {>> <<} mark (it is used for a literal text match). At most one annotation per paragraph. Use a suggestion only to correct something factually stale. Keep each "body" to 1-2 short sentences in plain words, no preamble. Never reuse the same anchor twice. Output the JSON array and nothing else.`;
}

/** Pull the JSON array out of a model response (tolerates a code fence / chatter). */
function parseAnnotations(raw: string): ReviewAnnotation[] {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as ReviewAnnotation[]) : [];
  } catch {
    return [];
  }
}

/**
 * Run the review turn. Routes to Sonnet-5 at xhigh effort through the warm
 * subscription pool — DECOUPLED from the orchestrator/Brain toggles so the
 * review always gets that path — and only falls back to Codex when no `claude`
 * binary resolves or the warm call throws. Reports the backend it actually used.
 */
async function runLLM(
  prompt: string,
  system: string = REVIEW_SYSTEM,
): Promise<{ text: string; backend: 'claude' | 'codex' }> {
  const binary = defaultClaudeBin();
  // TODO(prewarm): fire prewarmClaudeRepl(binary, REVIEW_MODEL, REVIEW_EFFORT) on pane focus so the first click is warm.
  if (binary) {
    try {
      // Prepend the system block the way callSonnetCli does — the one-shot
      // frame only carries a `user` message (sonnet-adapter.ts:188-191).
      const framed = `<system>\n${system}\n</system>\n\n${prompt}`;
      const text = await askClaudeWarm(framed, {
        binary,
        model: REVIEW_MODEL,
        effort: REVIEW_EFFORT,
        timeoutMs: 120_000,
      });
      return { text, backend: 'claude' };
    } catch {
      // Warm-Claude path unavailable (bad binary / spawn error) — fall to Codex.
    }
  }
  const text = await callCodex(`<system>\n${system}\n</system>\n\n${prompt}`, { timeoutMs: 120_000 });
  return { text, backend: 'codex' };
}

function noteAnchor(content: string, note: RfmReviewItem): string {
  const exact = note.anchorText ?? note.originalText;
  if (exact?.trim()) return exact.trim();

  // Addition suggestions don't encode their insertion anchor in RFM. Give the
  // reviewer only the adjacent line fragment, never the whole document.
  const lineStart = content.lastIndexOf('\n', Math.max(0, note.offset - 1)) + 1;
  const lineEndRaw = content.indexOf('\n', note.endOffset);
  const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
  const before = content.slice(lineStart, note.offset).trim();
  if (before) return before.slice(-500);
  const after = content.slice(note.endOffset, lineEnd).trim();
  return after ? after.slice(0, 500) : '(standalone note)';
}

function buildSingleNotePrompt(note: RfmReviewItem, anchor: string, message: string): string {
  return `Continue one o8.md margin-note thread. Do not review the rest of the document and do not create or regenerate annotations.

Anchor text:
"""
${anchor}
"""

Existing note:
"""
${note.text}
"""

Operator reply:
"""
${message}
"""

Answer the operator's reply in 1-3 short sentences. Return only the reply text.`;
}

function appendThreadReply(
  content: string,
  options: { parentId: string; message: string; author: string },
): string {
  const before = extractRoughdraftReviewIndex(content);
  const existingIds = new Set(before.items.map((item) => item.id));
  const parent = before.items.find((item) => item.id === options.parentId);
  if (!parent) throw new Error(`Review item not found: ${options.parentId}`);
  const threadEnd = before.items.reduce(
    (end, item) => item.parentId === options.parentId ? Math.max(end, item.endOffset) : end,
    parent.endOffset,
  );
  const inserted = appendRoughdraftReply(content, options);
  const added = extractRoughdraftReviewIndex(inserted).items.find((item) => !existingIds.has(item.id));
  if (!added || threadEnd === parent.endOffset) return inserted;

  // The shared helper correctly creates the canonical reply marker but places
  // it immediately after the parent. Move only that new marker to the prior
  // end of the thread so repeated scoped turns remain chronological.
  const marker = inserted.slice(added.offset, added.endOffset);
  const withoutMarker = `${inserted.slice(0, added.offset)}${inserted.slice(added.endOffset)}`;
  return `${withoutMarker.slice(0, threadEnd)}${marker}${withoutMarker.slice(threadEnd)}`;
}

/**
 * Warm a sonnet-5|xhigh REPL so the FIRST "Ask o8 to review" click doesn't
 * cold-spawn. Fire-and-forget + idempotent (the pool keeps at most one idle proc
 * per key), so calling it per pane-open just maintains one warm proc; it reaps
 * after the pool's idle window if it's never used. (2026-07-02)
 */
export function prewarmReview(): void {
  const binary = defaultClaudeBin();
  if (!binary) return;
  try { prewarmClaudeRepl(binary, REVIEW_MODEL, REVIEW_EFFORT); } catch { /* best effort */ }
}

/**
 * Continue exactly one annotation thread through the same warm reviewer used
 * by the full review. The prompt contains only the addressed note, its anchor,
 * and the operator's message; it never exposes the full o8.md or parses a new
 * annotation array. Both sides of the exchange are appended under the parent.
 */
export async function runSingleNoteReply(
  content: string,
  parentId: string,
  message: string,
): Promise<{ updated: string; result: SingleNoteReplyResult }> {
  const note = extractRoughdraftReviewIndex(content).items.find((item) => item.id === parentId);
  if (!note || (note.kind !== 'comment' && note.kind !== 'suggestion')) {
    throw new Error(`Review item not found: ${parentId}`);
  }
  const operatorMessage = message.trim();
  if (!operatorMessage) throw new Error('message is required');

  const prompt = buildSingleNotePrompt(note, noteAnchor(content, note), operatorMessage);
  const { text, backend } = await runLLM(prompt, SINGLE_NOTE_SYSTEM);
  const reply = text.trim();
  if (!reply) throw new Error('Reviewer returned an empty reply');

  const withOperatorReply = appendThreadReply(content, {
    parentId,
    message: operatorMessage,
    author: 'user',
  });
  const updated = appendThreadReply(withOperatorReply, {
    parentId,
    message: reply,
    author: 'AI',
  });

  return {
    updated,
    result: { backend, parentId, reply },
  };
}

/**
 * Run a headless review of `content` (a repo's o8.md) and return the annotated
 * markdown + a summary. Pure transform — the caller writes it (and byte-checks).
 * Bad anchors / unparseable items are skipped, never thrown, so one bad
 * annotation can't sink the batch.
 */
export async function runSpecReview(repoPath: string, content: string): Promise<{ updated: string; result: SpecReviewResult }> {
  const prompt = buildPrompt(content, recentCommits(repoPath));
  const { text: raw, backend } = await runLLM(prompt);
  const annotations = parseAnnotations(raw);

  let md = content;
  let applied = 0;
  let skipped = 0;
  const usedAnchors = new Set<string>();

  for (const a of annotations) {
    // Guard against the model reusing an anchor — splicing the same text twice
    // would nest markers and corrupt the doc.
    if (a.anchor && usedAnchors.has(a.anchor)) {
      skipped += 1;
      continue;
    }
    try {
      if (a.kind === 'comment' && typeof a.body === 'string' && a.body.trim()) {
        md = appendComment(md, { body: a.body.trim(), ...(a.anchor ? { anchor: a.anchor } : {}), author: 'AI' });
        applied += 1;
        if (a.anchor) usedAnchors.add(a.anchor);
      } else if (a.kind === 'suggestion' && (a.suggestionKind === 'add' || a.suggestionKind === 'del' || a.suggestionKind === 'sub')) {
        md = insertSuggestion(md, {
          kind: a.suggestionKind as SuggestionKind,
          ...(a.anchor ? { anchor: a.anchor } : {}),
          ...(typeof a.text === 'string' ? { text: a.text } : {}),
          ...(typeof a.replacement === 'string' ? { replacement: a.replacement } : {}),
          author: 'AI',
        });
        applied += 1;
        if (a.anchor) usedAnchors.add(a.anchor);
      } else {
        skipped += 1;
      }
    } catch {
      // Anchor not found / raw delimiter / missing field — skip this one.
      skipped += 1;
    }
  }

  return { updated: md, result: { applied, skipped, total: annotations.length, backend } };
}
