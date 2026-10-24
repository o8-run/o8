import { RepoRuntimeStopUnconfirmed } from '@/lib/repos/runtime-removal';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { deleteProject, getProjectsLedger } from '@/lib/repos/projects';
import { resolveProjectIdentity } from '@/lib/repos/project-identity';
import {
  getProjectWithRepos,
  updateProject,
} from '@/lib/projects/store';
import { syncPanelLedgerFromProjectStore } from '@/lib/projects/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const project = getProjectWithRepos(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  return NextResponse.json({ project }, { headers: NO_STORE });
}

interface UpdateProjectBody {
  name?: unknown;
  description?: unknown;
  mainRepoId?: unknown;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  let body: UpdateProjectBody;
  try {
    body = (await req.json()) as UpdateProjectBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const updates: { name?: string; description?: string | null; mainRepoId?: string | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name must be a string.' }, { status: 400 });
    }
    updates.name = body.name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return NextResponse.json({ error: 'description must be a string or null.' }, { status: 400 });
    }
    updates.description = body.description as string | null;
  }
  if (body.mainRepoId !== undefined) {
    if (body.mainRepoId !== null && typeof body.mainRepoId !== 'string') {
      return NextResponse.json({ error: 'mainRepoId must be a string or null.' }, { status: 400 });
    }
    updates.mainRepoId = body.mainRepoId as string | null;
  }

  try {
    // Capture the legacy pair before a name change can break its old slug bridge.
    const ledger = await getProjectsLedger();
    if (!ledger.projects.some((project) => project.id === id || project.sqliteProjectId === id)) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    }
    const identity = resolveProjectIdentity(id, ledger);
    const project = identity.sqlite ? updateProject(identity.sqlite.id, updates) : null;
    if (!project) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    }
    const withRepos = getProjectWithRepos(project.id);
    if (withRepos) {
      await syncPanelLedgerFromProjectStore(withRepos, identity.project.id);
    }
    return NextResponse.json({ project: withRepos ?? project }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update project.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  // Full-semantics delete (shared with the panel route): kills the SQLite row,
  // the ledger entry, AND the project's exclusive repos — otherwise unassigned
  // repos re-project as same-named virtual rows and the delete "doesn't work".
  if (!getProjectWithRepos(id)) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  try {
    await deleteProject(id);
  } catch (err) {
    if (err instanceof RepoRuntimeStopUnconfirmed) {
      return NextResponse.json({ ok: false, error: err.message, note: err.cleanup.note, stoppedSessions: err.cleanup }, { status: 409, headers: NO_STORE });
    }
    const message = err instanceof Error ? err.message : 'Failed to delete project.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
