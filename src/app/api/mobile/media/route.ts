import { viewerImageBytes } from '@/lib/viewers/image-bytes';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { NextRequest } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKSPACE_ROOT = process.env.CORTEX_IDE_WORKSPACE_ROOT || require('os').homedir();
const MEDIA_ROOT = process.env.CORTEX_IDE_MEDIA_ROOT || join(getDataDir(), 'media');
const EXTRA_MEDIA_ROOTS = [
  `${WORKSPACE_ROOT}/inbox`,
  `${WORKSPACE_ROOT}/archive/artifacts`,
];
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);

function contentTypeForExtension(path: string) {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

async function resolveAllowedMediaPath(rawPath: string) {
  const extension = extname(rawPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error('Requested media type is not allowed.');
  }

  const resolvedPath = await realpath(rawPath);
  const candidateRoots = [MEDIA_ROOT, ...EXTRA_MEDIA_ROOTS];
  const resolvedRoots = (await Promise.allSettled(candidateRoots.map((root) => realpath(root))))
    .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

  const allowed = resolvedRoots.some((resolvedRoot) => resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`));
  if (!allowed) {
    throw new Error('Requested media path is outside the allowed media roots.');
  }

  return resolvedPath;
}

export async function GET(request: NextRequest) {
  const rawPath = request.nextUrl.searchParams.get('path')?.trim();

  if (!rawPath) {
    return new Response('path is required', { status: 400 });
  }

  try {
    const filePath = await resolveAllowedMediaPath(rawPath);
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const buffer = await readFile(filePath);
    return viewerImageBytes(buffer, contentTypeForExtension(filePath));
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
