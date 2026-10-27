import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { readFile } from 'node:fs/promises';
import { getArtifact, artifactAbsPath } from '@/lib/artifacts/store';

/**
 * Serve a stored `report` artifact's HTML by id (#1491). The path is resolved
 * from the DB record (never caller-supplied), so there is no traversal surface.
 * Returns `{ html }` so the review surface can render it in a sandboxed iframe
 * srcDoc (allow-scripts, no same-origin) — the same trust model as HtmlPreview.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return viewerJson({ error: 'id param required' }, { status: 400 });
  }

  const record = getArtifact(id);
  if (!record || record.kind !== 'report') {
    return viewerJson({ error: 'Report not found' }, { status: 404 });
  }

  try {
    const html = await readFile(artifactAbsPath(record.relPath), 'utf8');
    return viewerJson({ html }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return viewerJson({ error: 'Could not read report' }, { status: 500 });
  }
}
