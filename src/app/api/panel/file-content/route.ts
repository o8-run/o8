export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { expandHome } from '@/lib/fs/safe-path';
import { isWorkspaceFileError, openWorkspaceFile, readWorkspaceFile } from '@/lib/fs/workspace-file';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

const NATIVE_PREVIEW_LIMIT = 32 * 1024 * 1024;
async function readNativePreview(root: string, filePath: string): Promise<Buffer | null> {
  const opened = await openWorkspaceFile(root, filePath, 'read');
  try {
    if (opened.stat.size > NATIVE_PREVIEW_LIMIT) return null;
    const chunks: Buffer[] = [];
    let length = 0;
    // A file can grow after fstat. Read at most one extra byte to detect that
    // race, and refuse before decoding or hashing an oversized snapshot.
    for await (const chunk of opened.handle.createReadStream({ start: 0, end: NATIVE_PREVIEW_LIMIT, autoClose: false })) {
      length += chunk.length;
      if (length > NATIVE_PREVIEW_LIMIT) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await opened.handle.close();
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const workspaceParam = searchParams.get('workspace');

    if (!filePath) {
      return NextResponse.json({ content: null, error: 'path param required' }, { status: 400 });
    }

    // Resolve the root. A caller-supplied workspace MUST be a registered repo —
    // never an arbitrary root. This closes the CRIT-3 arbitrary-read where
    // workspace=/ turned the guard into a no-op (SECURITY_AUDIT_2026-07-02 §CRIT-3).
    let root: string | null;
    if (workspaceParam) {
      const { repoRoot } = await resolveRegisteredRepoScope(expandHome(workspaceParam));
      root = repoRoot;
      if (!root) {
        return NextResponse.json({ content: null, error: 'Workspace is not a registered repository' }, { status: 400 });
      }
    } else {
      root = getDefaultLlmRepoRoot();
    }

    const bytes = searchParams.get('preview') === '1'
      ? await readNativePreview(root, filePath)
      : (await readWorkspaceFile(root, filePath)).bytes;
    if (bytes === null) {
      return NextResponse.json({ content: null, error: 'File exceeds 32 MiB', code: 'native_preview_too_large' }, { status: 413 });
    }
    const binary = bytes.includes(0) || !isUtf8(bytes);
    const content = bytes.toString('utf-8');
    const fullContentHash = createHash('sha256').update(bytes).digest('hex');
    // Truncate large files
    if (content.length > 100000) {
      return NextResponse.json({
        content: content.slice(0, 100000) + '\n\n... (truncated at 100KB)',
        contentHash: fullContentHash,
        binary,
        path: filePath,
        truncated: true,
      });
    }
    return NextResponse.json({ content, contentHash: fullContentHash, binary, path: filePath });
  } catch (error) {
    console.error('[panel/file-content] Could not read file', error);
    if (isWorkspaceFileError(error)) {
      return NextResponse.json({ content: null, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ content: null, error: 'Could not read file', code: 'workspace_file_operation_failed' }, { status: 500 });
  }
}
