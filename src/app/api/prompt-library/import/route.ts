import { NextResponse, type NextRequest } from 'next/server';

import { refuseNodePromptWrite } from '@/lib/prompt-library/write-owner';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  PROMPT_LIBRARY_IMPORT_MAX,
  PromptLibraryValidationError,
  importPromptLibrarySources,
  listPromptLibraryImportSources,
  type PromptLibraryImportRef,
} from '@/lib/prompt-library/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

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

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  try {
    const sources = listPromptLibraryImportSources({
      repoPath: request.nextUrl.searchParams.get('repoPath'),
      limit: PROMPT_LIBRARY_IMPORT_MAX,
    });
    return response({ schema: 'o8/prompt-library.import-sources/v1', ok: true, sources });
  } catch {
    return errorResponse('prompt_import_sources_failed', 'Existing prompts could not be inspected.', 500);
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const ownerRefusal = refuseNodePromptWrite();
  if (ownerRefusal) return ownerRefusal;

  const payload: unknown = await request.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.sources)) {
    return errorResponse('invalid_request', 'sources must be an array.', 400);
  }
  if (payload.sources.length > PROMPT_LIBRARY_IMPORT_MAX) {
    return errorResponse('too_many_imports', `Import at most ${PROMPT_LIBRARY_IMPORT_MAX} prompts at a time.`, 400);
  }
  const sources: PromptLibraryImportRef[] = [];
  for (const value of payload.sources) {
    if (!isRecord(value)
      || (value.sourceKind !== 'automation' && value.sourceKind !== 'watched_agent')
      || typeof value.sourceId !== 'string'
      || !value.sourceId.trim()) {
      return errorResponse('invalid_source', 'Each source needs a valid sourceKind and sourceId.', 400);
    }
    sources.push({ sourceKind: value.sourceKind, sourceId: value.sourceId.trim() });
  }
  const repoPath = payload.repoPath === null || payload.repoPath === undefined
    ? null
    : typeof payload.repoPath === 'string' ? payload.repoPath : undefined;
  if (repoPath === undefined) {
    return errorResponse('invalid_repo_path', 'repoPath must be a string or null.', 400);
  }

  try {
    const result = importPromptLibrarySources({ sources, repoPath });
    return response({ schema: 'o8/prompt-library.import/v1', ok: true, ...result });
  } catch (error) {
    if (error instanceof PromptLibraryValidationError) {
      return errorResponse(error.code, error.message, 400);
    }
    return errorResponse('prompt_import_failed', 'Existing prompts could not be imported.', 500);
  }
}
