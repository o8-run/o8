import { viewerImageBytes } from '@/lib/viewers/image-bytes';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { NextRequest } from 'next/server';
import { resolveAllowedMediaTarget } from '@/lib/files/media-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

export async function GET(request: NextRequest) {
  const rawPath = request.nextUrl.searchParams.get('path')?.trim();

  if (!rawPath) {
    return new Response('path is required', { status: 400 });
  }

  try {
    const { path: filePath } = await resolveAllowedMediaTarget(rawPath);
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
