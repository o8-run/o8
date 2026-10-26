import { NextResponse, type NextRequest } from 'next/server';
import { join, relative } from 'node:path';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getArtifact } from '@/lib/artifacts/store';
import { getTaskArtifactById } from '@/lib/task-artifacts/store';
import { TASK_ARTIFACT_LIMITS } from '@/lib/task-artifacts/types';
import { getDataDir } from '@/lib/data-dir-migration';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';
import { redactThreadText, redactThreadValue } from '@/lib/threads/redaction';
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
    if (!artifact || !await inScope(artifact.target)) return NextResponse.json({ error: 'Artifact not found.' }, { status: 404 });
    if (Buffer.byteLength(artifact.html) > TASK_ARTIFACT_LIMITS.htmlMaxBytes) return NextResponse.json({ error: 'Artifact too large.' }, { status: 413 });
    return NextResponse.json({ ok: true, result: { artifact: {
      id: artifact.id, title: redactThreadText(artifact.title), html: redactThreadText(artifact.html),
    } } }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  const record = id ? getArtifact(id) : null;
  if (!record || !await inScope(record)) return NextResponse.json({ error: 'Artifact not found.' }, { status: 404 });
  const mime = record.mimeType.toLowerCase().split(';')[0].trim();
  const text = record.kind === 'report' || record.kind === 'receipt';
  const supported = text ? ['application/json', 'text/plain', 'text/html', 'text/markdown']
    : record.kind === 'screenshot' ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
      : record.kind === 'video' ? ['video/mp4', 'video/webm'] : [];
  if (!supported.includes(mime)) return NextResponse.json({ error: 'Unsupported artifact format.' }, { status: 415 });
  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | undefined;
  try {
    opened = await openWorkspaceFile(join(getDataDir(), 'artifacts'), relative('artifacts', record.relPath), 'read');
    if (opened.stat.size > (text ? 2 : 25) * 1024 * 1024) return NextResponse.json({ error: 'Artifact too large.' }, { status: 413 });
    const bytes = await opened.handle.readFile();
    let body: string | Blob = new Blob([Uint8Array.from(bytes)]);
    if (text) {
      const raw = bytes.toString('utf8');
      if (mime === 'application/json') {
        try { body = JSON.stringify(redactThreadValue(JSON.parse(raw))); }
        catch { return NextResponse.json({ error: 'Artifact JSON is invalid.' }, { status: 422 }); }
      } else body = redactThreadText(raw);
    }
    return new NextResponse(body, { headers: {
      'Content-Type': text ? (mime === 'application/json' ? mime : 'text/plain; charset=utf-8') : mime,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    } });
  } catch {
    return NextResponse.json({ error: 'Artifact unavailable.' }, { status: 404 });
  } finally { await opened?.handle.close().catch(() => {}); }
}
