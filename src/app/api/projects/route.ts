import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { withRepoInventoryChange } from '@/lib/repos/inventory-change-publish';
import {
  addRepoToProject,
  createProject,
  getProjectWithRepos,
  listProjects,
  setProjectMainRepo,
} from '@/lib/projects/store';
import {
  syncPanelLedgerFromProjectStore,
  syncProjectStoreFromPanelLedger,
} from '@/lib/projects/context';
import type { ProjectRole, SuggestionOrigin } from '@/lib/projects/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

function hideSyntheticWorkspace<T extends { name: string; slug: string }>(projects: T[]): T[] {
  const hasConcreteProject = projects.some((project) => project.slug !== 'workspace');
  if (!hasConcreteProject) return projects;
  return projects.filter((project) => project.slug !== 'workspace' || project.name.toLowerCase() !== 'workspace');
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    await syncProjectStoreFromPanelLedger();
    const projects = hideSyntheticWorkspace(listProjects());
    return NextResponse.json({ projects }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list projects.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface CreateProjectBody {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  /** Parallel-array shape: list of repo IDs. Aligned with `roles`. */
  repoIds?: unknown;
  /** Parallel array of roles aligned to repoIds, OR a map { repoId: role }. */
  roles?: unknown;
  /**
   * #899 dogfood follow-up — natural inverse of GET response.
   * Object-array shape: `[{ repoId, role? }, ...]`. Auto-detected and
   * normalized to `repoIds` + parallel `roles`. Both shapes can't be supplied
   * at once — pick one or you'll get a 400.
   */
  repos?: unknown;
  mainRepoId?: unknown;
  suggestionOrigin?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry);
  }
  return out;
}

function resolveRoleForRepo(
  repoId: string,
  index: number,
  roles: unknown,
): ProjectRole | null {
  if (!roles) return null;
  if (Array.isArray(roles)) {
    const candidate = roles[index];
    return typeof candidate === 'string' && candidate ? (candidate as ProjectRole) : null;
  }
  if (typeof roles === 'object') {
    const entry = (roles as Record<string, unknown>)[repoId];
    return typeof entry === 'string' && entry ? (entry as ProjectRole) : null;
  }
  return null;
}

/**
 * #899 dogfood follow-up — accept the natural inverse of the GET response
 * shape: `repos: [{ repoId, role? }, ...]`. Returns parallel arrays so the
 * existing repoIds + roles path can consume them, OR a structured error
 * describing why the shape was rejected (so callers don't silently get an
 * empty project).
 *
 * Returns `null` when the body has no `repos` field — the caller falls back
 * to the legacy `repoIds` + `roles` shape.
 */
function normalizeReposField(
  reposField: unknown,
): { ok: true; repoIds: string[]; roles: (ProjectRole | null)[] }
  | { ok: false; error: string }
  | null {
  if (reposField === undefined) return null;
  if (!Array.isArray(reposField)) {
    return { ok: false, error: '`repos` must be an array.' };
  }
  const repoIds: string[] = [];
  const roles: (ProjectRole | null)[] = [];
  for (let i = 0; i < reposField.length; i++) {
    const entry = reposField[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        error: `\`repos[${i}]\` must be an object with a \`repoId\` string. Did you mean to send \`repoIds\`?`,
      };
    }
    const obj = entry as { repoId?: unknown; role?: unknown };
    const repoId = asString(obj.repoId)?.trim();
    if (!repoId) {
      return { ok: false, error: `\`repos[${i}].repoId\` is required and must be a non-empty string.` };
    }
    repoIds.push(repoId);
    const roleStr = asString(obj.role)?.trim();
    roles.push(roleStr ? (roleStr as ProjectRole) : null);
  }
  return { ok: true, repoIds, roles };
}

async function handlePOST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  let body: CreateProjectBody;
  try {
    body = (await req.json()) as CreateProjectBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const name = asString(body.name)?.trim();
  if (!name) {
    return NextResponse.json({ error: 'Project name is required.' }, { status: 400 });
  }

  // #899 dogfood follow-up — auto-detect either shape:
  //   { repoIds: [...], roles: [...] | { repoId: role } }   ← parallel-array (legacy)
  //   { repos: [{ repoId, role? }, ...] }                   ← object-array (natural inverse)
  // Sending both at once is ambiguous and rejected. Sending a malformed
  // `repos` (e.g. array of strings) returns a structured 400 instead of
  // silently creating a project with zero repos.
  let resolvedRepoIds: string[] = [];
  let rolesSource: unknown = body.roles;
  if (body.repos !== undefined && body.repoIds !== undefined) {
    return NextResponse.json(
      {
        error:
          'Pass either `repos: [{repoId, role?}]` (object array) OR `repoIds` + `roles` (parallel arrays), not both.',
      },
      { status: 400 },
    );
  }
  const reposNormalized = normalizeReposField(body.repos);
  if (reposNormalized) {
    if (!reposNormalized.ok) {
      return NextResponse.json({ error: reposNormalized.error }, { status: 400 });
    }
    resolvedRepoIds = reposNormalized.repoIds;
    rolesSource = reposNormalized.roles;
  } else if (body.repoIds !== undefined) {
    const parsed = asStringArray(body.repoIds);
    if (!parsed) {
      return NextResponse.json(
        { error: '`repoIds` must be an array of strings.' },
        { status: 400 },
      );
    }
    resolvedRepoIds = parsed;
  }

  try {
    const project = createProject({
      name,
      slug: asString(body.slug),
      description: asString(body.description) ?? null,
    });

    const suggestionOrigin =
      (asString(body.suggestionOrigin) as SuggestionOrigin | undefined) ?? 'manual';

    const repos = resolvedRepoIds.map((repoId, index) => {
      const role = resolveRoleForRepo(repoId, index, rolesSource);
      return addRepoToProject(project.id, repoId, role, suggestionOrigin);
    });
    const mainRepoId = asString(body.mainRepoId)?.trim();
    if (mainRepoId && resolvedRepoIds.includes(mainRepoId)) {
      setProjectMainRepo(project.id, mainRepoId);
    }
    const withRepos = getProjectWithRepos(project.id);
    if (withRepos) {
      await syncPanelLedgerFromProjectStore(withRepos);
    }

    return NextResponse.json(
      { project: withRepos ?? { ...project, repos } },
      { status: 201, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create project.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withRepoInventoryChange('project-create', handlePOST);
