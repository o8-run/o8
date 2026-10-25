import { NextResponse, type NextRequest } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import {
  PromptLibraryDuplicateError,
  PromptLibraryRevisionError,
  PromptLibraryValidationError,
  deletePromptLibraryEntry,
  getPromptLibraryEntry,
  updatePromptLibraryEntry,
  type PromptLibraryScope,
} from '@/lib/prompt-library/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;
type RouteContext = { params: Promise<{ id: string }> };

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE });
}

function errorResponse(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return response({
    schema: 'o8/prompt-library.error/v1',
    ok: false,
    error: { code, message, ...details },
  }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof PromptLibraryRevisionError) {
    return errorResponse('stale_revision', error.message, 409);
  }
  if (error instanceof PromptLibraryValidationError) {
    return errorResponse(error.code, error.message, 400);
  }
  if (error instanceof PromptLibraryDuplicateError) {
    return errorResponse('duplicate_prompt', error.message, 409, { existing: error.existing });
  }
  return errorResponse('prompt_library_failed', 'The prompt library request could not be completed.', 500);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { id } = await context.params;
  const prompt = getPromptLibraryEntry(id);
  if (!prompt) return errorResponse('prompt_not_found', 'Saved prompt not found.', 404);
  return response({ schema: 'o8/prompt-library.entry/v1', ok: true, prompt });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const payload: unknown = await request.json().catch(() => null);
  if (!isRecord(payload)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object.', 400);
  }
  if (payload.title !== undefined && typeof payload.title !== 'string') {
    return errorResponse('invalid_title', 'title must be a string.', 400);
  }
  if (payload.expectedUpdatedAt !== undefined && (
    typeof payload.expectedUpdatedAt !== 'number' || !Number.isSafeInteger(payload.expectedUpdatedAt) || payload.expectedUpdatedAt <= 0
  )) {
    return errorResponse('invalid_revision', 'expectedUpdatedAt must be a positive integer.', 400);
  }
  if (payload.body !== undefined && typeof payload.body !== 'string') {
    return errorResponse('invalid_body', 'body must be a string.', 400);
  }
  if (payload.tags !== undefined && (
    !Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== 'string')
  )) {
    return errorResponse('invalid_tags', 'tags must be an array of strings.', 400);
  }
  if (payload.scope !== undefined && payload.scope !== 'global' && payload.scope !== 'repo') {
    return errorResponse('invalid_scope', 'scope must be global or repo.', 400);
  }
  if (payload.repoPath !== undefined && payload.repoPath !== null && typeof payload.repoPath !== 'string') {
    return errorResponse('invalid_repo_path', 'repoPath must be a string or null.', 400);
  }

  const { id } = await context.params;
  try {
    const prompt = updatePromptLibraryEntry(id, {
      expectedUpdatedAt: payload.expectedUpdatedAt as number | undefined,
      title: payload.title as string | undefined,
      body: payload.body as string | undefined,
      tags: payload.tags as string[] | undefined,
      scope: payload.scope as PromptLibraryScope | undefined,
      repoPath: payload.repoPath as string | null | undefined,
    });
    if (!prompt) return errorResponse('prompt_not_found', 'Saved prompt not found.', 404);
    return response({ schema: 'o8/prompt-library.entry/v1', ok: true, prompt });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { id } = await context.params;
  const revision = request.nextUrl.searchParams.get('expectedUpdatedAt');
  const expectedUpdatedAt = revision === null ? undefined : Number(revision);
  if (expectedUpdatedAt !== undefined && (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0)) {
    return errorResponse('invalid_revision', 'expectedUpdatedAt must be a positive integer.', 400);
  }
  try {
    if (!deletePromptLibraryEntry(id, expectedUpdatedAt)) {
      return errorResponse('prompt_not_found', 'Saved prompt not found.', 404);
    }
    return response({ schema: 'o8/prompt-library.delete/v1', ok: true, deletedId: id });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
