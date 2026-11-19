import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { addRepoToProject, getProjectWithRepos } from '@/lib/projects/store';
import { syncPanelLedgerFromProjectStore } from '@/lib/projects/context';
import type { ProjectRole, SuggestionOrigin } from '@/lib/projects/types';
import { withRepoInventoryChange } from '@/lib/repos/inventory-change-publish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

interface AddRepoBody {
  repoId?: unknown;
  role?: unknown;
  suggestionOrigin?: unknown;
}

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  let body: AddRepoBody;
  try {
    body = (await req.json()) as AddRepoBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const repoId = typeof body.repoId === 'string' ? body.repoId.trim() : '';
  if (!repoId) {
    return NextResponse.json({ error: 'repoId is required.' }, { status: 400 });
  }

  const role = typeof body.role === 'string' && body.role
    ? (body.role as ProjectRole)
    : null;
  const suggestionOrigin = typeof body.suggestionOrigin === 'string' && body.suggestionOrigin
    ? (body.suggestionOrigin as SuggestionOrigin)
    : 'manual';

  try {
    const link = addRepoToProject(id, repoId, role, suggestionOrigin);
    const project = getProjectWithRepos(id);
    if (project) {
      await syncPanelLedgerFromProjectStore(project);
    }
    return NextResponse.json({ link }, { status: 201, headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add repo.';
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withRepoInventoryChange('project-repo-add', handlePOST);
