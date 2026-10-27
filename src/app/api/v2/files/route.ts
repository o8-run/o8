import { isMaskedViewerReplay } from '@/lib/viewers/copy-safety';
import { viewerJson } from '@/lib/viewers/response';
/**
 * POST /api/v2/files — Write/edit files in the workspace
 * GET /api/v2/files?path=... — Read a file
 *
 * Used by LLM Chat "Apply to File" feature.
 */

export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import {
  isWorkspaceFileError,
  readWorkspaceFile,
  openWorkspaceFile,
  writeWorkspaceFile,
} from '@/lib/fs/workspace-file';
import {
  ABSOLUTE_PATH_NOT_ALLOWLISTED,
  resolveAllowedOperatorConfigPath,
  resolveRepoRelativeFilePath,
} from '@/lib/files/operator-config-docs';
import { contentHash } from '@/lib/markdown/transport';
import { assertNotKnowledgeSource, KnowledgeSourceWriteError, normalizeKnowledgeWritePath } from '@/lib/cortex/knowledge/sources';

async function resolveRoot(workspace?: string | null) {
  if (!workspace) return getDefaultLlmRepoRoot();

  const requestedPath = normalizeKnowledgeWritePath(workspace);

  const { repoRoot } = await resolveRegisteredRepoScope(requestedPath);
  return repoRoot;
}

async function resolveFileTarget(filePath: string, workspace?: string | null) {
  if (isAbsolute(filePath)) {
    const resolved = resolveAllowedOperatorConfigPath(filePath);
    if (!resolved) {
      return {
        error: 'Absolute path is not allowlisted',
        code: ABSOLUTE_PATH_NOT_ALLOWLISTED,
        status: 400,
      } as const;
    }
    const root = homedir();
    return { root, relativePath: relative(root, resolved) } as const;
  }

  const root = await resolveRoot(workspace);
  if (!root) {
    return {
      error: 'Workspace is not registered',
      code: 'workspace_not_registered',
      status: 400,
    } as const;
  }

  const resolved = resolveRepoRelativeFilePath(root, filePath);
  if (!resolved) {
    return {
      error: 'Path outside repository',
      code: 'path_outside_repository',
      status: 400,
    } as const;
  }

  return { root, relativePath: relative(root, resolved) } as const;
}

function fileError(error: unknown) {
  if (error instanceof KnowledgeSourceWriteError) {
    return viewerJson({ error: error.message, code: 'knowledge_source_read_only' }, { status: 403 });
  }
  if (isWorkspaceFileError(error)) {
    return viewerJson({ error: error.message, code: error.code }, { status: error.status });
  }
  return viewerJson({ error: 'Workspace file operation failed', code: 'workspace_file_operation_failed' }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');
  if (!path) {
    return viewerJson({ error: 'path required' }, { status: 400 });
  }

  const target = await resolveFileTarget(path, request.nextUrl.searchParams.get('workspace'));
  if ('error' in target) {
    return viewerJson({ error: target.error, code: target.code }, { status: target.status });
  }

  try {
    if (request.nextUrl.searchParams.get('preview') === '1') {
      const opened = await openWorkspaceFile(target.root, target.relativePath, 'read');
      try {
        const size = Number(opened.stat.size);
        const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await opened.handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const content = buffer.subarray(0, offset).toString('utf-8');
        return viewerJson({ content, path, exists: true, size, truncated: size > buffer.length });
      } finally { await opened.handle.close(); }
    }
    const opened = await readWorkspaceFile(target.root, target.relativePath);
    const content = opened.bytes.toString('utf-8');
    return viewerJson({ content, contentHash: await contentHash(content), path, exists: true });
  } catch (err) {
    if (isWorkspaceFileError(err) && err.code === 'workspace_file_not_found') {
      return viewerJson({ error: 'File not found', code: err.code, exists: false }, { status: 404 });
    }
    return fileError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const path = typeof body?.path === 'string' ? body.path : '';
    const content = typeof body?.content === 'string' ? body.content : undefined;
    const workspace = typeof body?.workspace === 'string' ? body.workspace : undefined;
    const expectedHash = typeof body?.expectedHash === 'string' ? body.expectedHash : undefined;
    const force = body?.force === true;

    if (!path || content === undefined) {
      return viewerJson({ error: 'path and content required' }, { status: 400 });
    }

    assertNotKnowledgeSource(workspace || getDefaultLlmRepoRoot());
    const target = await resolveFileTarget(path, workspace);
    if ('error' in target) {
      return viewerJson({ error: target.error, code: target.code }, { status: target.status });
    }

    if (expectedHash !== undefined && !force) {
      let currentContent: string | null = null;
      try {
        const current = await readWorkspaceFile(target.root, target.relativePath);
        currentContent = current.bytes.toString('utf-8');
      } catch (err) {
        if (!isWorkspaceFileError(err) || err.code !== 'workspace_file_not_found') throw err;
      }
      const currentHash = currentContent === null ? null : await contentHash(currentContent);
      if (currentHash !== expectedHash) {
        return viewerJson({
          error: 'changed-on-disk',
          contentHash: currentHash,
          content: currentContent,
        }, { status: 409 });
      }
    }

    // Existing editors must not turn an opaque display chip into source text.
    // This refusal applies even when a caller forces an otherwise valid save.
    let source = '';
    try { source = (await readWorkspaceFile(target.root, target.relativePath)).bytes.toString('utf8'); }
    catch (error) { if (!isWorkspaceFileError(error) || error.code !== 'workspace_file_not_found') throw error; }
    if (isMaskedViewerReplay(source, content)) {
      return viewerJson({ error: 'Masked viewer content is read-only', code: 'redacted_content_read_only' }, { status: 409 });
    }
    const result = await writeWorkspaceFile(target.root, target.relativePath, content);
    const oldContent = result.previousBytes?.toString('utf-8') ?? null;

    return viewerJson({
      success: true,
      path,
      isNew: result.created,
      oldContent,
      contentHash: await contentHash(content),
    });
  } catch (err) {
    return fileError(err);
  }
}
