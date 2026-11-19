import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getProjectWithRepos, removeRepoFromProject, setRepoRole } from '@/lib/projects/store';
import { syncPanelLedgerFromProjectStore } from '@/lib/projects/context';
import type { ProjectRole } from '@/lib/projects/types';
import { withRepoInventoryChange } from '@/lib/repos/inventory-change-publish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; repoId: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id, repoId } = await params;
  const removed = removeRepoFromProject(id, repoId);
  if (!removed) {
    return NextResponse.json({ error: 'Project repo link not found.' }, { status: 404 });
  }
  const project = getProjectWithRepos(id);
  if (project) {
    await syncPanelLedgerFromProjectStore(project);
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

interface PatchRepoBody {
  role?: unknown;
}

async function handlePATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; repoId: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id, repoId } = await params;
  let body: PatchRepoBody;
  try {
    body = (await req.json()) as PatchRepoBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (body.role !== null && typeof body.role !== 'string') {
    return NextResponse.json(
      { error: 'role must be a string or null.' },
      { status: 400 },
    );
  }

  const role = body.role ? (body.role as ProjectRole) : null;
  const link = setRepoRole(id, repoId, role);
  if (!link) {
    return NextResponse.json({ error: 'Project repo link not found.' }, { status: 404 });
  }
  const project = getProjectWithRepos(id);
  if (project) {
    await syncPanelLedgerFromProjectStore(project);
  }
  return NextResponse.json({ link }, { headers: NO_STORE });
}

export const PATCH = withRepoInventoryChange('project-repo-role-update', handlePATCH);
export const DELETE = withRepoInventoryChange('project-repo-remove', handleDELETE);
