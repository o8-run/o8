import { viewerBytes } from '@/lib/viewers/bytes';
import { isVerifiableRasterType, viewerImageBytes } from '@/lib/viewers/image-bytes';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { homedir } from 'node:os';
import { extname } from 'node:path';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';

const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

async function resolveRoot(workspace?: string | null) {
  if (!workspace) return getDefaultLlmRepoRoot();

  const requestedPath = workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;

  const { repoRoot } = await resolveRegisteredRepoScope(requestedPath);
  return repoRoot;
}

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');
  if (!path) {
    return new Response('path required', { status: 400 });
  }

  const root = await resolveRoot(request.nextUrl.searchParams.get('workspace'));
  if (!root) {
    return new Response('Workspace is not registered', { status: 400 });
  }

  const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (!mimeType) {
    return new Response('Preview type not supported', { status: 415 });
  }

  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
  try {
    opened = await openWorkspaceFile(root, path, 'read');
    if (opened.stat.size > MAX_PREVIEW_BYTES) {
      return new Response('File too large for preview', { status: 413 });
    }
    const buffer = await opened.handle.readFile();
    // Serve verifiable raster images through the image path (#4773 refuses them via
    // the text viewer). PDF, audio and video stay on the text viewer and are refused
    // as before; restoring those opaque types is out of this raster-only scope.
    return isVerifiableRasterType(mimeType) ? viewerImageBytes(buffer, mimeType) : viewerBytes(buffer, mimeType);
  } catch {
    return new Response('File not found or path refused', { status: 404 });
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}
