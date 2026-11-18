import { NextResponse, type NextRequest } from 'next/server';

import { refuseNodePromptWrite } from '@/lib/prompt-library/write-owner';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  PromptLibraryValidationError,
  createPromptLibraryEntry,
  listPromptLibraryEntries,
  type PromptLibraryScope,
  type PromptLibraryScopeFilter,
} from '@/lib/prompt-library/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;
const SCOPE_FILTERS = new Set<PromptLibraryScopeFilter>(['available', 'global', 'repo', 'all']);

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE });
}

function errorResponse(code: string, message: string, status: number) {
  return response({
    schema: 'o8/prompt-library.error/v1',
    ok: false,
    error: { code, message },
  }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validationResponse(error: unknown) {
  if (error instanceof PromptLibraryValidationError) {
    return errorResponse(error.code, error.message, 400);
  }
  return errorResponse('prompt_library_failed', 'The prompt library request could not be completed.', 500);
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const query = request.nextUrl.searchParams.get('query') ?? '';
  const scopeValue = request.nextUrl.searchParams.get('scope') ?? 'available';
  if (!SCOPE_FILTERS.has(scopeValue as PromptLibraryScopeFilter)) {
    return errorResponse('invalid_scope_filter', 'scope must be available, global, repo, or all.', 400);
  }
  const limitValue = request.nextUrl.searchParams.get('limit');
  const parsedLimit = limitValue === null ? 50 : Number.parseInt(limitValue, 10);
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return errorResponse('invalid_limit', 'limit must be a positive integer.', 400);
  }

  try {
    const prompts = listPromptLibraryEntries({
      query,
      scope: scopeValue as PromptLibraryScopeFilter,
      repoPath: request.nextUrl.searchParams.get('repoPath'),
      limit: parsedLimit,
    });
    return response({
      schema: 'o8/prompt-library.list/v1',
      ok: true,
      prompts,
    });
  } catch (error) {
    return validationResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const ownerRefusal = refuseNodePromptWrite();
  if (ownerRefusal) return ownerRefusal;

  const payload: unknown = await request.json().catch(() => null);
  if (!isRecord(payload)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object.', 400);
  }
  if (typeof payload.title !== 'string') {
    return errorResponse('invalid_title', 'title must be a string.', 400);
  }
  if (typeof payload.body !== 'string') {
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

  try {
    const result = createPromptLibraryEntry({
      title: payload.title,
      body: payload.body,
      tags: payload.tags as string[] | undefined,
      scope: payload.scope as PromptLibraryScope | undefined,
      repoPath: payload.repoPath as string | null | undefined,
    });
    return response({
      schema: 'o8/prompt-library.entry/v1',
      ok: true,
      created: result.created,
      prompt: result.entry,
    }, result.created ? 201 : 200);
  } catch (error) {
    return validationResponse(error);
  }
}
