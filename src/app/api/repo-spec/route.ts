import { isMaskedViewerReplay } from '@/lib/viewers/copy-safety';
import { viewerJson } from '@/lib/viewers/response';
import { type NextRequest } from 'next/server';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';
import { isWorkspaceFileError, writeWorkspaceFile } from '@/lib/fs/workspace-file';
import {
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
  appendRoughdraftReply,
  markRoughdraftResolved,
} from '@/lib/o8md/rfm';
import { cleanupOrphanedRoughdraftAnnotations } from '@/lib/o8md/cleanup';
import { appendComment, applySuggestion, insertSuggestion, type SuggestionKind } from '@/lib/o8md/mutate';
import { contentHash } from '@/lib/markdown/transport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// o8.md — repo-scoped spec/notes file. Lives at <repoPath>/o8.md so the
// orchestrator can read it from disk during context assembly the same way
// it reads CLAUDE.md / AGENTS.md. Operator and agents share this surface:
// operator edits via the Spec tab, agents read on dispatch + can write
// back via the existing repo-write tool path.

const MAX_BYTES = 256 * 1024;

function resolveSpecPath(repoPath: string): string | null {
  if (!repoPath || typeof repoPath !== 'string') return null;
  if (!existsSync(repoPath)) return null;
  try {
    const s = statSync(repoPath);
    if (!s.isDirectory()) return null;
  } catch { return null; }
  return join(repoPath, 'o8.md');
}

const DEFAULT_TEMPLATE = `# o8 Spec

> One-page spec for this repo. Operator edits here. Agents read this on
> dispatch and can write back when they need to record a decision.

## Mission

What this repo exists to do, in one paragraph.

## Active scope

- [ ] Goal you're working on right now
- [ ] Next thing after that

## Constraints

- Hard rules the orchestrator must respect.

## Open questions

- Things you want surfaced for the operator before action.
`;

export async function GET(request: NextRequest) {
  const repoPath = request.nextUrl.searchParams.get('repoPath') ?? '';
  const specPath = resolveSpecPath(repoPath);
  if (!specPath) {
    return viewerJson({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }
  const exists = existsSync(specPath);
  const content = exists ? readFileSync(specPath, 'utf-8') : DEFAULT_TEMPLATE;

  // Review-aware views (RFM parser). `view` absent = raw content (back-compat).
  const view = request.nextUrl.searchParams.get('view');
  if (view === 'index') {
    return viewerJson({ ok: true, index: extractRoughdraftReviewIndex(content), exists, path: specPath });
  }
  if (view === 'validate') {
    return viewerJson({ ok: true, validation: validateRoughdraftMarkdown(content), exists, path: specPath });
  }
  return viewerJson({
    ok: true,
    content,
    contentHash: await contentHash(content),
    exists,
    path: specPath,
  });
}

export async function PUT(request: NextRequest) {
  const repoPath = request.nextUrl.searchParams.get('repoPath') ?? '';
  const specPath = resolveSpecPath(repoPath);
  if (!specPath) {
    return viewerJson({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }
  const sourceRefusal = knowledgeSourceWriteRefusal(repoPath, specPath);
  if (sourceRefusal) return sourceRefusal;
  const body = await request.json().catch(() => null) as {
    content?: unknown;
    expectedHash?: unknown;
    force?: unknown;
  } | null;
  const content = typeof body?.content === 'string' ? body.content : null;
  if (content === null) {
    return viewerJson({ ok: false, error: 'content must be a string' }, { status: 400 });
  }
  if (isMaskedViewerReplay(existsSync(specPath) ? readFileSync(specPath, 'utf8') : '', content)) return viewerJson({ error: 'Masked viewer content is read-only', code: 'redacted_content_read_only' }, { status: 409 });
  const cleanup = cleanupOrphanedRoughdraftAnnotations(content);
  if (Buffer.byteLength(cleanup.content, 'utf-8') > MAX_BYTES) {
    return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
  }
  const expectedHash = typeof body?.expectedHash === 'string' ? body.expectedHash : undefined;
  if (expectedHash !== undefined && body?.force !== true) {
    const currentContent = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : null;
    const currentHash = currentContent === null ? null : await contentHash(currentContent);
    if (currentHash !== expectedHash) {
      return viewerJson({
        error: 'changed-on-disk',
        contentHash: currentHash,
        content: currentContent,
      }, { status: 409 });
    }
  }
  try { await writeWorkspaceFile(dirname(specPath), basename(specPath), cleanup.content); }
  catch (error) {
    return viewerJson({ ok: false, error: error instanceof Error ? error.message : 'Spec could not be written.' }, { status: isWorkspaceFileError(error) ? error.status : 500 });
  }
  return viewerJson({
    ok: true,
    path: specPath,
    bytes: Buffer.byteLength(cleanup.content, 'utf-8'),
    content: cleanup.content,
    contentHash: await contentHash(cleanup.content),
    orphanedAnnotationsRemoved: cleanup.removedAnnotations,
  });
}

// POST ?action=reply|resolve — review mutations via the vendored RFM parser.
// These are the AGENT-safe writes (annotation only); full-content authoring
// stays on PUT, which is the operator's panel path. Per the o8 inversion, agent
// replies default to author "AI" (the parser's default), so the operator's prose
// is never overwritten — only annotated. The parser throws on not-found / unsafe
// input, so every mutation is wrapped and returned as a structured error.
export async function POST(request: NextRequest) {
  const repoPath = request.nextUrl.searchParams.get('repoPath') ?? '';
  const specPath = resolveSpecPath(repoPath);
  if (!specPath) {
    return viewerJson({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }
  const sourceRefusal = knowledgeSourceWriteRefusal(repoPath, specPath);
  if (sourceRefusal) return sourceRefusal;
  const action = request.nextUrl.searchParams.get('action');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const suppliedContent = typeof body?.content === 'string' ? body.content : null;
  if (suppliedContent !== null && Buffer.byteLength(suppliedContent, 'utf-8') > MAX_BYTES) {
    return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
  }
  // The editor supplies its current buffer so a note action can't race the
  // autosave debounce and overwrite fresh operator prose. MCP callers omit it
  // and continue operating against the persisted file exactly as before.
  if (suppliedContent !== null && isMaskedViewerReplay(existsSync(specPath) ? readFileSync(specPath, 'utf8') : '', suppliedContent)) return viewerJson({ error: 'Masked viewer content is read-only', code: 'redacted_content_read_only' }, { status: 409 });
  const current = suppliedContent ?? (existsSync(specPath) ? readFileSync(specPath, 'utf-8') : DEFAULT_TEMPLATE);

  try {
    if (action === 'reply') {
      const parentId = typeof body?.parentId === 'string' ? body.parentId : null;
      const message = typeof body?.message === 'string' ? body.message : null;
      if (!parentId || !message) {
        return viewerJson({ ok: false, error: 'parentId and message are required' }, { status: 400 });
      }
      const author = typeof body?.author === 'string' ? body.author : undefined;
      const beforeIds = new Set(extractRoughdraftReviewIndex(current).items.map((i) => i.id));
      const updated = appendRoughdraftReply(current, {
        parentId,
        message,
        ...(author !== undefined ? { author } : {}),
      });
      if (Buffer.byteLength(updated, 'utf-8') > MAX_BYTES) {
        return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
      }
      await writeWorkspaceFile(dirname(specPath), basename(specPath), updated);
      const newId = extractRoughdraftReviewIndex(updated).items.find((i) => !beforeIds.has(i.id))?.id ?? null;
      return viewerJson({ ok: true, id: newId, path: specPath, content: updated });
    }

    if (action === 'comment') {
      const body_ = typeof body?.body === 'string' ? body.body : null;
      if (!body_) {
        return viewerJson({ ok: false, error: 'body is required' }, { status: 400 });
      }
      const anchor = typeof body?.anchor === 'string' ? body.anchor : undefined;
      const author = typeof body?.author === 'string' ? body.author : undefined;
      const beforeIds = new Set(extractRoughdraftReviewIndex(current).items.map((i) => i.id));
      const updated = appendComment(current, {
        body: body_,
        ...(anchor !== undefined ? { anchor } : {}),
        ...(author !== undefined ? { author } : {}),
      });
      if (Buffer.byteLength(updated, 'utf-8') > MAX_BYTES) {
        return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
      }
      await writeWorkspaceFile(dirname(specPath), basename(specPath), updated);
      const newId = extractRoughdraftReviewIndex(updated).items.find((i) => !beforeIds.has(i.id))?.id ?? null;
      return viewerJson({ ok: true, id: newId, path: specPath, content: updated });
    }

    if (action === 'suggest') {
      const rawKind = body?.kind;
      if (rawKind !== 'add' && rawKind !== 'del' && rawKind !== 'sub') {
        return viewerJson({ ok: false, error: 'kind must be add, del, or sub' }, { status: 400 });
      }
      const kind: SuggestionKind = rawKind;
      const anchor = typeof body?.anchor === 'string' ? body.anchor : undefined;
      const text = typeof body?.text === 'string' ? body.text : undefined;
      const replacement = typeof body?.replacement === 'string' ? body.replacement : undefined;
      const author = typeof body?.author === 'string' ? body.author : undefined;
      const beforeIds = new Set(extractRoughdraftReviewIndex(current).items.map((i) => i.id));
      const updated = insertSuggestion(current, {
        kind,
        ...(anchor !== undefined ? { anchor } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(replacement !== undefined ? { replacement } : {}),
        ...(author !== undefined ? { author } : {}),
      });
      if (Buffer.byteLength(updated, 'utf-8') > MAX_BYTES) {
        return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
      }
      await writeWorkspaceFile(dirname(specPath), basename(specPath), updated);
      const newId = extractRoughdraftReviewIndex(updated).items.find((i) => !beforeIds.has(i.id))?.id ?? null;
      return viewerJson({ ok: true, id: newId, path: specPath, content: updated });
    }

    if (action === 'resolve') {
      const targetId = typeof body?.targetId === 'string' ? body.targetId : null;
      if (!targetId) {
        return viewerJson({ ok: false, error: 'targetId is required' }, { status: 400 });
      }
      const summary = typeof body?.summary === 'string' ? body.summary : undefined;
      const updated = markRoughdraftResolved(current, {
        targetId,
        ...(summary !== undefined ? { summary } : {}),
      });
      await writeWorkspaceFile(dirname(specPath), basename(specPath), updated);
      return viewerJson({ ok: true, path: specPath, content: updated });
    }

    if (action === 'scoped-reply') {
      const parentId = typeof body?.parentId === 'string' ? body.parentId : null;
      const message = typeof body?.message === 'string' ? body.message : null;
      if (!parentId || !message) {
        return viewerJson({ ok: false, error: 'parentId and message are required' }, { status: 400 });
      }
      const { runSingleNoteReply } = await import('@/lib/o8md/spec-review');
      const { updated, result } = await runSingleNoteReply(current, parentId, message);
      if (Buffer.byteLength(updated, 'utf-8') > MAX_BYTES) {
        return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
      }
      await writeWorkspaceFile(dirname(specPath), basename(specPath), updated);
      return viewerJson({ ok: true, ...result, path: specPath, content: updated });
    }

    if (action === 'apply-suggestion') {
      const targetId = typeof body?.targetId === 'string' ? body.targetId : null;
      if (!targetId) {
        return viewerJson({ ok: false, error: 'targetId is required' }, { status: 400 });
      }
      const updated = applySuggestion(current, {
        targetId,
        accept: body?.accept !== false,
      });
      await writeWorkspaceFile(dirname(specPath), basename(specPath), updated);
      return viewerJson({ ok: true, path: specPath, content: updated });
    }

    if (action === 'prewarm-review') {
      // Warm a review REPL so the FIRST review click is instant, not a cold
      // spawn. Fire-and-forget + idempotent (pool keeps ≤1 idle proc per key).
      const { prewarmReview } = await import('@/lib/o8md/spec-review');
      prewarmReview();
      return viewerJson({ ok: true });
    }

    if (action === 'review') {
      // Headless one-shot review: an LLM turn reads the notes and returns
      // annotations we splice in here. Never touches the orchestrator session,
      // so it never surfaces in the chat — it just lands on the rail.
      const { runSpecReview } = await import('@/lib/o8md/spec-review');
      const { updated, result } = await runSpecReview(repoPath, current);
      if (updated !== current) {
        if (Buffer.byteLength(updated, 'utf-8') > MAX_BYTES) {
          return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
        }
        await writeWorkspaceFile(dirname(specPath), basename(specPath), updated);
      }
      return viewerJson({ ok: true, ...result, path: specPath });
    }

    return viewerJson({ ok: false, error: `unknown action: ${action ?? '(none)'}` }, { status: 400 });
  } catch (err) {
    if (isWorkspaceFileError(err)) return viewerJson({ ok: false, error: err.message, code: err.code }, { status: err.status });
    // Parser-domain failure (target not found, raw close delimiter, missing
    // metadata): the request was well-formed but can't be applied. 422 so the
    // CLI surfaces the detail message; MCP reads the body regardless of status.
    return viewerJson(
      { ok: false, error: err instanceof Error ? err.message : 'review mutation failed' },
      { status: 422 },
    );
  }
}
