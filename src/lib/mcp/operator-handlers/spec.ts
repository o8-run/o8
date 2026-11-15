/*
 * o8.md review tools for the operator MCP server — the surface external Claude
 * sessions (Claude Code / Desktop / cowork) use to read + annotate a repo's
 * o8.md. Every handler is a thin call to /api/repo-spec (one code path, one
 * gate). Per the o8 inversion the operator authors o8.md and agents only
 * ANNOTATE it — so there is deliberately NO full-overwrite tool here; comment /
 * reply / resolve are the agent's verbs. Full-content writes stay on the
 * operator's panel (PUT).
 *
 * All inputSchemas are flat objects (OpenAI strict-mode safe). Domain
 * validation (close-delimiter rejection, not-found) happens server-side in the
 * vendored parser and is surfaced as a tool error, never a 500.
 */

import {
  apiFetch,
  errorText,
  getApiBase,
  jsonResult,
  optionalString,
  requiredString,
  type McpTool,
  type McpToolResult,
} from '@/lib/mcp/operator-handlers/shared';
import { nativeSpecReadWitness, publishNativeSpec } from '@/lib/mcp/native-read-publication';

const repoPathProp = {
  type: 'string',
  description: 'Absolute path to the repo whose o8.md to act on.',
};

export const SPEC_TOOLS: McpTool[] = [
  {
    name: 'o8_spec_read',
    description: "Read a repo's o8.md (the operator's living spec / scratchpad) as raw markdown.",
    inputSchema: { type: 'object', additionalProperties: false, properties: { repoPath: repoPathProp }, required: ['repoPath'] },
  },
  {
    name: 'o8_spec_review_index',
    description: "Get the structured review index for a repo's o8.md — comments, replies, suggestions, each with id/author/anchor + a summary.",
    inputSchema: { type: 'object', additionalProperties: false, properties: { repoPath: repoPathProp }, required: ['repoPath'] },
  },
  {
    name: 'o8_spec_pending_feedback',
    description: "List only the UNRESOLVED review threads in a repo's o8.md — the open items worth addressing.",
    inputSchema: { type: 'object', additionalProperties: false, properties: { repoPath: repoPathProp }, required: ['repoPath'] },
  },
  {
    name: 'o8_spec_validate',
    description: "Validate the review markup in a repo's o8.md and return diagnostics (missing metadata, unclosed markers, duplicate ids, …).",
    inputSchema: { type: 'object', additionalProperties: false, properties: { repoPath: repoPathProp }, required: ['repoPath'] },
  },
  {
    name: 'o8_spec_comment',
    description: "Leave a NEW comment on the operator's o8.md — a thought, pointer, or question. Annotates, never overwrites the prose. Optionally anchor it to a literal text snippet. Author defaults to AI.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath: repoPathProp,
        body: { type: 'string', description: 'The comment text.' },
        anchor: { type: 'string', description: 'Optional: literal text in o8.md to attach the comment to (first occurrence is highlighted).' },
        by: { type: 'string', description: 'Author label. Defaults to "AI".' },
      },
      required: ['repoPath', 'body'],
    },
  },
  {
    name: 'o8_spec_reply',
    description: 'Reply to an existing o8.md review thread by its parent id. Author defaults to AI.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath: repoPathProp,
        parentId: { type: 'string', description: 'Id of the comment/suggestion to reply to (e.g. "c1").' },
        message: { type: 'string', description: 'The reply text.' },
        author: { type: 'string', description: 'Author label. Defaults to "AI".' },
      },
      required: ['repoPath', 'parentId', 'message'],
    },
  },
  {
    name: 'o8_spec_resolve',
    description: 'Mark an o8.md review item resolved, optionally recording a one-line summary of the resolution.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath: repoPathProp,
        targetId: { type: 'string', description: 'Id of the item to resolve.' },
        summary: { type: 'string', description: 'Optional resolution note.' },
      },
      required: ['repoPath', 'targetId'],
    },
  },
  {
    name: 'o8_spec_suggest',
    description: "Propose a non-destructive edit to the operator's o8.md: add text, delete a snippet, or substitute one phrase for another. The original is preserved inside the marker for the operator to accept or reject. add needs `text`; del needs `anchor`; sub needs `anchor` (original) + `replacement` (new).",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath: repoPathProp,
        kind: { type: 'string', enum: ['add', 'del', 'sub'], description: 'add | del | sub.' },
        anchor: { type: 'string', description: 'Literal text to delete/replace (del/sub), or insert-after point (add).' },
        text: { type: 'string', description: 'Text to add (add only).' },
        replacement: { type: 'string', description: 'Replacement text (sub only).' },
        by: { type: 'string', description: 'Author label. Defaults to "AI".' },
      },
      required: ['repoPath', 'kind'],
    },
  },
];

function specPath(repoPath: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ repoPath, ...extra });
  return `/api/repo-spec?${params.toString()}`;
}

export async function handleSpecRead(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const witness = nativeSpecReadWitness();
    const response = await apiFetch(specPath(requiredString(args, 'repoPath')));
    publishNativeSpec(getApiBase(), response, witness);
    return jsonResult(response);
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleSpecReviewIndex(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return jsonResult(await apiFetch(specPath(requiredString(args, 'repoPath'), { view: 'index' })));
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleSpecPendingFeedback(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const res = (await apiFetch(specPath(requiredString(args, 'repoPath'), { view: 'index' }))) as {
      index?: { items?: Array<{ status?: string | null }>; summary?: unknown };
    };
    const items = (res.index?.items ?? []).filter((i) => i.status !== 'resolved');
    return jsonResult({ ok: true, items, summary: res.index?.summary });
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleSpecValidate(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return jsonResult(await apiFetch(specPath(requiredString(args, 'repoPath'), { view: 'validate' })));
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleSpecComment(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    const body = requiredString(args, 'body');
    const anchor = optionalString(args, 'anchor');
    const by = optionalString(args, 'by');
    const result = await apiFetch(specPath(repoPath, { action: 'comment' }), {
      method: 'POST',
      body: JSON.stringify({ body, ...(anchor ? { anchor } : {}), ...(by ? { author: by } : {}) }),
    });
    return jsonResult(result);
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleSpecReply(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    const parentId = requiredString(args, 'parentId');
    const message = requiredString(args, 'message');
    const author = optionalString(args, 'author');
    const result = await apiFetch(specPath(repoPath, { action: 'reply' }), {
      method: 'POST',
      body: JSON.stringify({ parentId, message, ...(author ? { author } : {}) }),
    });
    return jsonResult(result);
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleSpecResolve(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    const targetId = requiredString(args, 'targetId');
    const summary = optionalString(args, 'summary');
    const result = await apiFetch(specPath(repoPath, { action: 'resolve' }), {
      method: 'POST',
      body: JSON.stringify({ targetId, ...(summary ? { summary } : {}) }),
    });
    return jsonResult(result);
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleSpecSuggest(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    const kind = requiredString(args, 'kind');
    if (kind !== 'add' && kind !== 'del' && kind !== 'sub') {
      return jsonResult({ ok: false, error: 'kind must be add, del, or sub' });
    }
    const anchor = optionalString(args, 'anchor');
    const text = optionalString(args, 'text');
    const replacement = optionalString(args, 'replacement');
    const by = optionalString(args, 'by');
    const result = await apiFetch(specPath(repoPath, { action: 'suggest' }), {
      method: 'POST',
      body: JSON.stringify({
        kind,
        ...(anchor ? { anchor } : {}),
        ...(text ? { text } : {}),
        ...(replacement ? { replacement } : {}),
        ...(by ? { author: by } : {}),
      }),
    });
    return jsonResult(result);
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}
