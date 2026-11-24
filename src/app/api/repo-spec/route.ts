import { isMaskedViewerReplay } from '@/lib/viewers/copy-safety';
import { viewerJson } from '@/lib/viewers/response';
import { type NextRequest } from 'next/server';
import { dirname, basename } from 'node:path';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';
import { isWorkspaceFileError, readWorkspaceFile, writeWorkspaceFile } from '@/lib/fs/workspace-file';
import { scopedRepoPath, resolveSpecPath } from '@/lib/o8md/read-scope';
import {
  extractRoughdraftReviewIndex,
  appendRoughdraftReply,
  markRoughdraftResolved,
} from '@/lib/o8md/rfm';
import { cleanupOrphanedRoughdraftAnnotations } from '@/lib/o8md/cleanup';
import { appendComment, applySuggestion } from '@/lib/o8md/mutate';
import { contentHash } from '@/lib/markdown/transport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// o8.md — repo-scoped spec/notes file. Lives at <repoPath>/o8.md so the
// orchestrator can read it from disk during context assembly the same way
// it reads CLAUDE.md / AGENTS.md. Operator and agents share this surface:
// operator edits via the Spec tab, agents read on dispatch + can write
// back via the existing repo-write tool path.

const MAX_BYTES = 256 * 1024;
const OPERATOR_ONLY_REFUSAL = {
  code: 'repo_spec_operator_only',
  message: 'Workers may read o8.md; edits are the operator\'s.',
} as const;

/** o8.md's text, or null when there is none. Like the writes, it refuses a symlinked or non-regular file. */
async function readSpec(specPath: string): Promise<string | null> {
  try {
    return (await readWorkspaceFile(dirname(specPath), basename(specPath))).bytes.toString('utf-8');
  } catch (error) {
    if (isWorkspaceFileError(error) && error.code === 'workspace_file_not_found') return null;
    throw error;
  }
}

function workspaceFileErrorResponse(error: unknown): Response {
  if (!isWorkspaceFileError(error)) throw error;
  return viewerJson({ ok: false, error: error.message, code: error.code }, { status: error.status });
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
  const scope = scopedRepoPath(request);
  if (scope instanceof Response) return scope;
  const specPath = resolveSpecPath(scope.repoPath);
  if (!specPath) {
    return viewerJson({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }
  let stored: string | null;
  try { stored = await readSpec(specPath); } catch (error) { return workspaceFileErrorResponse(error); }
  const exists = stored !== null;
  const content = stored ?? DEFAULT_TEMPLATE;

  // The phone's notes screen reads the open notes already in o8.md.
  if (request.nextUrl.searchParams.get('view') === 'index') {
    return viewerJson({ ok: true, index: extractRoughdraftReviewIndex(content), exists, path: specPath });
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
  const scope = scopedRepoPath(request);
  if (scope instanceof Response) return scope;
  if (scope.worker) return viewerJson({ ok: false, error: OPERATOR_ONLY_REFUSAL }, { status: 403 });
  const repoPath = scope.repoPath;
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
  let stored: string | null;
  try { stored = await readSpec(specPath); } catch (error) { return workspaceFileErrorResponse(error); }
  if (isMaskedViewerReplay(stored ?? '', content)) return viewerJson({ error: 'Masked viewer content is read-only', code: 'redacted_content_read_only' }, { status: 409 });
  const cleanup = cleanupOrphanedRoughdraftAnnotations(content);
  if (Buffer.byteLength(cleanup.content, 'utf-8') > MAX_BYTES) {
    return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
  }
  const expectedHash = typeof body?.expectedHash === 'string' ? body.expectedHash : undefined;
  if (expectedHash !== undefined && body?.force !== true) {
    const currentContent = stored;
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

// POST ?action=reply|resolve|apply-suggestion — the operator answers and settles
// notes already in o8.md through the vendored RFM parser. Full-content authoring stays on PUT.
// The parser throws on not-found / unsafe input, so every mutation is wrapped
// and returned as a structured error.
export async function POST(request: NextRequest) {
  const scope = scopedRepoPath(request);
  if (scope instanceof Response) return scope;
  const repoPath = scope.repoPath;
  const specPath = resolveSpecPath(repoPath);
  if (!specPath) {
    return viewerJson({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }
  const sourceRefusal = knowledgeSourceWriteRefusal(repoPath, specPath);
  if (sourceRefusal) return sourceRefusal;
  const action = request.nextUrl.searchParams.get('action');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (scope.worker) return viewerJson({ ok: false, error: OPERATOR_ONLY_REFUSAL }, { status: 403 });
  const suppliedContent = typeof body?.content === 'string' ? body.content : null;
  if (suppliedContent !== null && Buffer.byteLength(suppliedContent, 'utf-8') > MAX_BYTES) {
    return viewerJson({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
  }
  // The editor supplies its current buffer so a note action can't race the
  // autosave debounce and overwrite fresh operator prose.
  let stored: string | null;
  try { stored = await readSpec(specPath); } catch (error) { return workspaceFileErrorResponse(error); }
  if (suppliedContent !== null && isMaskedViewerReplay(stored ?? '', suppliedContent)) return viewerJson({ error: 'Masked viewer content is read-only', code: 'redacted_content_read_only' }, { status: 409 });
  const current = suppliedContent ?? stored ?? DEFAULT_TEMPLATE;

  try {
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

    return viewerJson({ ok: false, error: `unknown action: ${action ?? '(none)'}` }, { status: 400 });
  } catch (err) {
    if (isWorkspaceFileError(err)) return viewerJson({ ok: false, error: err.message, code: err.code }, { status: err.status });
    // Parser-domain failure (target not found, raw close delimiter, missing
    // metadata): the request was well-formed but can't be applied.
    return viewerJson(
      { ok: false, error: err instanceof Error ? err.message : 'review mutation failed' },
      { status: 422 },
    );
  }
}
