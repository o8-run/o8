import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';
import { isWorkspaceFileError, writeWorkspaceFile } from '@/lib/fs/workspace-file';
import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Inline image assets for o8.md. Stored repo-relative at <repoPath>/o8-assets/
// so they travel WITH the repo (dispatched agents see them) and are served back
// through the existing path-jailed /api/panel/file-asset reader. The markdown in
// o8.md stays a tiny ref — ![alt](o8-assets/foo.png "WxH"), never base64 — so the
// 256KB o8.md cap is never at risk and the orchestrator's per-dispatch read of
// o8.md stays lean. Companion writer to that reader; same loopback posture as the
// sibling /api/repo-spec GET/PUT/POST.

const ASSET_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per image
const VIDEO_MAX_BYTES = 100 * 1024 * 1024; // GitHub refuses single files over 100 MB
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm']);
const ASSETS_DIR = 'o8-assets';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/** Lowercase extension → canonical extension + MIME pair. Used by the
 *  `srcPath` branch (Finder-drag drops that come in as absolute paths via
 *  Tauri's drag-drop bridge rather than a multipart body). */
const PATH_EXT_TO_MIME: Record<string, { ext: string; mime: string }> = {
  '.png':  { ext: 'png',  mime: 'image/png' },
  '.jpg':  { ext: 'jpg',  mime: 'image/jpeg' },
  '.jpeg': { ext: 'jpg',  mime: 'image/jpeg' },
  '.gif':  { ext: 'gif',  mime: 'image/gif' },
  '.webp': { ext: 'webp', mime: 'image/webp' },
  '.avif': { ext: 'avif', mime: 'image/avif' },
  '.svg':  { ext: 'svg',  mime: 'image/svg+xml' },
  '.mp4':  { ext: 'mp4',  mime: 'video/mp4' },
  '.m4v':  { ext: 'mp4',  mime: 'video/mp4' },
  '.mov':  { ext: 'mov',  mime: 'video/quicktime' },
  '.webm': { ext: 'webm', mime: 'video/webm' },
};

function repoDir(repoPath: string): string | null {
  if (!repoPath || typeof repoPath !== 'string' || !existsSync(repoPath)) return null;
  try {
    if (!statSync(repoPath).isDirectory()) return null;
  } catch {
    return null;
  }
  return repoPath;
}

function slugifyStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'image';
}

export async function POST(request: NextRequest) {
  const sourceRefusal = knowledgeSourceWriteRefusal(request.nextUrl.searchParams.get('repoPath'));
  if (sourceRefusal) return sourceRefusal;
  const repoPath = repoDir(request.nextUrl.searchParams.get('repoPath') ?? '');
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }

  // Two ingest paths:
  //  - body bytes (the original POST shape — paste, programmatic upload,
  //    and the HTML5-drop fallback). `Content-Type` carries the MIME.
  //  - `?srcPath=<absolute path>` (the Tauri drag-drop bridge — Tauri
  //    intercepts Finder→app drops and gives JS only the file path, not
  //    a File. The server reads the bytes from disk on the local FS).
  const srcPath = request.nextUrl.searchParams.get('srcPath');

  let buf: Buffer;
  let ext: string;
  let rawName: string;

  if (srcPath) {
    // srcPath reads an arbitrary server-local file (the Tauri Finder-drag bridge)
    // — operator only. The desktop operator is the sole legitimate caller; any
    // other principal (worker, plugin, spectator, device) is refused, or this
    // becomes a local image/video read+exfil primitive for a non-operator bearer:
    // it could copy any on-disk image/video into the workspace assets and read it
    // back. The device (phone over the relay) and other bearers keep the
    // body-bytes upload path; only this server-path branch is operator-gated.
    if (resolveRequestPrincipal(request) !== 'operator') {
      return NextResponse.json({ ok: false, error: 'srcPath is not permitted for this credential' }, { status: 403 });
    }
    if (!existsSync(srcPath) || !statSync(srcPath).isFile()) {
      return NextResponse.json({ ok: false, error: 'srcPath not a readable file' }, { status: 400 });
    }
    const pathExt = extname(srcPath).toLowerCase();
    const mapped = PATH_EXT_TO_MIME[pathExt];
    if (!mapped) {
      return NextResponse.json({ ok: false, error: `unsupported image extension: ${pathExt || '(none)'}` }, { status: 415 });
    }
    try {
      buf = readFileSync(srcPath);
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'read failed' }, { status: 500 });
    }
    ext = mapped.ext;
    rawName = srcPath.split('/').pop() ?? 'image';
  } else {
    const mime = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mappedExt = EXT_BY_MIME[mime];
    if (!mappedExt) {
      return NextResponse.json({ ok: false, error: `unsupported image type: ${mime || '(none)'}` }, { status: 415 });
    }
    buf = Buffer.from(await request.arrayBuffer());
    ext = mappedExt;
    try {
      rawName = decodeURIComponent(request.headers.get('x-filename') ?? '');
    } catch {
      rawName = '';
    }
  }

  if (buf.byteLength === 0) {
    return NextResponse.json({ ok: false, error: 'empty body' }, { status: 400 });
  }
  const video = VIDEO_EXTENSIONS.has(ext);
  const limit = video ? VIDEO_MAX_BYTES : ASSET_MAX_BYTES;
  if (buf.byteLength > limit) {
    return NextResponse.json({ ok: false, error: `${video ? 'video' : 'image'} exceeds ${limit} bytes` }, { status: 413 });
  }

  // Hash for uniqueness; slug is human-readable context. Re-dropping the exact
  // same file (same name + bytes) is idempotent — the write below is skipped.
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const fileName = `${slugifyStem(rawName)}-${hash}.${ext}`;

  const assetsDir = join(repoPath, ASSETS_DIR);
  const target = join(assetsDir, fileName);
  const targetRefusal = knowledgeSourceWriteRefusal(assetsDir, target);
  if (targetRefusal) return targetRefusal;
  // Defensive path-jail: fileName is slug+hash+ext (no separators), but verify
  // the resolved write still lands under <repoPath>/o8-assets anyway.
  if (!resolve(target).startsWith(resolve(assetsDir) + sep)) {
    return NextResponse.json({ ok: false, error: 'path escapes asset dir' }, { status: 400 });
  }

  try {
    mkdirSync(assetsDir, { recursive: true });
    if (!existsSync(target)) await writeWorkspaceFile(assetsDir, fileName, buf);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'write failed' },
      { status: isWorkspaceFileError(err) ? err.status : 500 },
    );
  }

  return NextResponse.json({ ok: true, relPath: `${ASSETS_DIR}/${fileName}`, name: fileName, bytes: buf.byteLength });
}
