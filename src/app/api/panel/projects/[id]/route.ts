import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { getSqlite } from '@/lib/db';
import { projectMergeModeKey } from '@/lib/lane/project-merge-mode-migration';
import { RepoRuntimeStopUnconfirmed } from '@/lib/repos/runtime-removal';
import { NextRequest, NextResponse } from 'next/server';
import {
  deleteProject,
  getProjectsLedger,
  renameProject,
  setProjectColor,
  setProjectRepos,
  type ProjectColor,
  PROJECT_COLOR_PALETTE,
} from '@/lib/repos/projects';
import { withRepoInventoryChange } from '@/lib/repos/inventory-change-publish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function handlePATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { name?: string; repoPaths?: string[]; color?: string; mergeMode?: unknown }
    | null;
  if (!body) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: NO_STORE });
  }
  try {
    let ledger;
    if (body.mergeMode !== undefined) {
      if (resolveRequestPrincipalContext(request).role !== 'operator') {
        return NextResponse.json({ error: 'Project merge policy requires an operator credential.' }, { status: 403 });
      }
      if (body.mergeMode !== 'direct' && body.mergeMode !== 'pr_only') {
        return NextResponse.json({ error: 'mergeMode must be direct or pr_only.' }, { status: 400 });
      }
      ledger = await getProjectsLedger();
      const project = ledger.projects.find(project => project.id === id || project.sqliteProjectId === id);
      if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
      const sqlite = getSqlite();
      sqlite.transaction(() => {
        const save = sqlite.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
        for (const projectId of new Set([project.id, project.sqliteProjectId].filter((id): id is string => Boolean(id)))) {
          save.run(projectMergeModeKey(projectId), body.mergeMode, Date.now());
        }
      })();
    }
    if (typeof body.name === 'string') {
      ledger = await renameProject(id, body.name);
    }
    if (Array.isArray(body.repoPaths)) {
      ledger = await setProjectRepos(id, body.repoPaths);
    }
    if (typeof body.color === 'string') {
      if (!PROJECT_COLOR_PALETTE.includes(body.color as ProjectColor)) {
        return NextResponse.json({ error: 'unknown project color' }, { status: 400, headers: NO_STORE });
      }
      ledger = await setProjectColor(id, body.color as ProjectColor);
    }
    if (!ledger) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    console.error('[api] panel/projects/[id] failed:', error);
    const message = 'Failed to update project.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}

async function handleDELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const ledger = await deleteProject(id);
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof RepoRuntimeStopUnconfirmed) {
      return NextResponse.json({ ok: false, error: error.message, note: error.cleanup.note, stoppedSessions: error.cleanup }, { status: 409, headers: NO_STORE });
    }
    console.error('[api] panel/projects/[id] failed:', error);
    const message = 'Failed to delete project.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}

export const PATCH = withRepoInventoryChange('project-update', handlePATCH);

export const DELETE = withRepoInventoryChange('project-delete', handleDELETE);
