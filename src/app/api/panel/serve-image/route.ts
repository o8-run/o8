import { viewerBytes } from '@/lib/viewers/bytes';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { extname } from 'node:path';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { confineToRoots } from '@/lib/fs/safe-path';
import { isWorkspaceFileError, openWorkspaceFile } from '@/lib/fs/workspace-file';

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

const ALLOWED_ROOTS = [
  process.env.HOME || require('os').homedir(),
  '/tmp',
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path param required' }, { status: 400 });
  }

  // Security: normalize (collapsing any `..`) and confine to an allowed root.
  // A plain startsWith on the un-normalized path let `~/../../etc/x` escape.
  const resolved = confineToRoots(filePath, ALLOWED_ROOTS);
  if (!resolved) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
  }

  const ext = extname(resolved).toLowerCase();
  const mimeType = MIME_MAP[ext];
  if (!mimeType) {
    return NextResponse.json({ error: 'Not an image file' }, { status: 400 });
  }

  const allowedRoot = ALLOWED_ROOTS
    .map((root) => resolve(root))
    .find((root) => {
      const rel = relative(root, resolved);
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    });
  if (!allowedRoot) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
  }

  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
  try {
    opened = await openWorkspaceFile(allowedRoot, relative(allowedRoot, resolved), 'read');
    if (opened.stat.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large' }, { status: 400 });
    }

    const buffer = await opened.handle.readFile();
    return viewerBytes(buffer, mimeType);
  } catch (error) {
    if (isWorkspaceFileError(error)) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'Could not read file', code: 'workspace_file_operation_failed' }, { status: 500 });
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}
