import { redactOutputText } from '@/lib/acp/output-redaction';
import { viewerRedactionPolicy } from '@/lib/viewers/policy';
import { redactThreadText } from '@/lib/threads/redaction';
import { viewerBytes } from '@/lib/viewers/bytes';
import { isVerifiableRasterType, viewerImageBytes } from '@/lib/viewers/image-bytes';
import { viewerJson } from '@/lib/viewers/response';
import { type NextRequest } from 'next/server';
import { join, relative } from 'node:path';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getArtifact } from '@/lib/artifacts/store';
import { getTaskArtifactById } from '@/lib/task-artifacts/store';
import { TASK_ARTIFACT_LIMITS } from '@/lib/task-artifacts/types';
import { getDataDir } from '@/lib/data-dir-migration';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';
import { createThreadProjectScope, type ThreadTarget } from '@/lib/threads/project-scope';
import { threadProjectMatches } from '@/components/desktop/o8-panel/thread-project-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Recorded IDs resolve under the artifact root; caller paths never grant read authority. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const id = request.nextUrl.searchParams.get('id');
  const projectId = request.nextUrl.searchParams.get('projectId');
  const inScope = async (target: ThreadTarget) => {
    if (projectId === null) return true;
    if (!projectId) return false;
    const scope = await createThreadProjectScope();
    return threadProjectMatches(scope.targetProject(target), projectId);
  };
  if (id && request.nextUrl.searchParams.get('source') === 'interactive') {
    const artifact = getTaskArtifactById(id);
    if (!artifact || !await inScope(artifact.target)) return viewerJson({ error: 'Artifact not found.' }, { status: 404 });
    if (Buffer.byteLength(artifact.html) > TASK_ARTIFACT_LIMITS.htmlMaxBytes) return viewerJson({ error: 'Artifact too large.' }, { status: 413 });
    return viewerJson({ ok: true, result: { artifact: {
      id: artifact.id, title: redactThreadText(redactOutputText(artifact.title, viewerRedactionPolicy()).text), html: redactThreadText(redactOutputText(artifact.html, viewerRedactionPolicy()).text),
    } } }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  const record = id ? getArtifact(id) : null;
  if (!record || !await inScope(record)) return viewerJson({ error: 'Artifact not found.' }, { status: 404 });
  const mime = record.mimeType.toLowerCase().split(';')[0].trim();
  const text = record.kind === 'report' || record.kind === 'receipt';
  const supported = text ? ['application/json', 'text/plain', 'text/html', 'text/markdown']
    : record.kind === 'screenshot' ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
      : record.kind === 'video' ? ['video/mp4', 'video/webm'] : [];
  if (!supported.includes(mime)) return viewerJson({ error: 'Unsupported artifact format.' }, { status: 415 });
  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | undefined;
  try {
    opened = await openWorkspaceFile(join(getDataDir(), 'artifacts'), relative('artifacts', record.relPath), 'read');
    if (opened.stat.size > (text ? 2 : 25) * 1024 * 1024) return viewerJson({ error: 'Artifact too large.' }, { status: 413 });
    const bytes = await opened.handle.readFile();
    // Screenshot artifacts are rasters; serve them through the verified image path
    // (#4773 otherwise refuses them). Reports/receipts (text) and video stay on the
    // text viewer with its thread-text redactor, which images do not need.
    if (!text && isVerifiableRasterType(mime)) return viewerImageBytes(bytes, mime);
    return viewerBytes(bytes, text ? (mime === 'application/json' ? mime : 'text/plain; charset=utf-8') : mime, undefined, redactThreadText);
  } catch {
    return viewerJson({ error: 'Artifact unavailable.' }, { status: 404 });
  } finally { await opened?.handle.close().catch(() => {}); }
}
