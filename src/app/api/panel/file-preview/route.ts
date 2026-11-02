import { viewerBytes } from '@/lib/viewers/bytes';
import { isVerifiableRasterType, viewerImageBytes } from '@/lib/viewers/image-bytes';
import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { extname } from 'node:path';
import { expandHome } from '@/lib/fs/safe-path';
import { isWorkspaceFileError, openWorkspaceFile } from '@/lib/fs/workspace-file';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp']);
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');
  const workspaceParam = searchParams.get('workspace');

  if (!filePath) {
    return viewerJson({ error: 'path param required' }, { status: 400 });
  }

  let root: string | null = getDefaultLlmRepoRoot();
  if (workspaceParam) {
    const scope = await resolveRegisteredRepoScope(expandHome(workspaceParam));
    root = scope.repoRoot;
  }
  if (!root) {
    return viewerJson({ error: 'Workspace is not a registered repository' }, { status: 400 });
  }

  const ext = extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return viewerJson({ error: 'Not an image file' }, { status: 400 });
  }

  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
  try {
    opened = await openWorkspaceFile(root, filePath, 'read');
    // Limit to 10MB
    if (opened.stat.size > 10 * 1024 * 1024) {
      return viewerJson({ error: 'File too large (>10MB)' }, { status: 400 });
    }

    const buffer = await opened.handle.readFile();
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';

    // For SVGs, return as text
    if (ext === '.svg') {
      return viewerJson({
        type: 'svg',
        content: buffer.toString('utf-8'),
        mimeType,
        size: opened.stat.size,
        path: filePath,
      });
    }

    // SVG returns as JSON text above; serve verifiable rasters through the image
    // path (#4773 otherwise refuses them) and keep any other type on the text viewer.
    return isVerifiableRasterType(mimeType) ? viewerImageBytes(buffer, mimeType) : viewerBytes(buffer, mimeType);
  } catch (error) {
    if (isWorkspaceFileError(error)) {
      return viewerJson({ error: error.message, code: error.code }, { status: error.status });
    }
    return viewerJson({ error: 'Could not read file', code: 'workspace_file_operation_failed' }, { status: 500 });
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}
