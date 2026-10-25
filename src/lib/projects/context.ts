import 'server-only';

import path from 'node:path';

import {
  addRepoToProject,
  createProject,
  listProjects,
  updateProject,
} from '@/lib/projects/store';
import type { ProjectRole, ProjectWithRepos } from '@/lib/projects/types';
import {
  DEFAULT_PROJECT_ID,
  getActiveProjectScopeForRepo,
  getProjectsLedger,
  upsertProjectLedgerRecord,
  type ProjectRecord,
} from '@/lib/repos/projects';
import { listRepos } from '@/lib/repos/registry';
import { sqliteProjectForLedger } from '@/lib/repos/project-identity';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { isVirtualRepoProjectId } from '@/lib/repos/virtual-project-id';
import { truncateText } from '@/lib/util/text';

export interface ProjectContextRepo {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
  role: ProjectRole | null;
  isPrimary: boolean;
  isCurrent: boolean;
  inPanelProject: boolean;
  inSettingsProject: boolean;
}

export interface ProjectContext {
  id: string;
  name: string;
  slug: string;
  runtimeProjectId: string;
  panelProjectId: string;
  settingsProjectId: string | null;
  instructions: string | null;
  repoPaths: string[];
  repos: ProjectContextRepo[];
  primaryRepo: ProjectContextRepo | null;
  currentRepo: ProjectContextRepo | null;
  relatedRepos: ProjectContextRepo[];
  allowedRepoIds: string[];
  repoInProject: boolean;
  files: {
    enabled: boolean;
    items: [];
    note: string;
  };
  source: {
    panelProjectName: string;
    settingsProjectName: string | null;
    syncedFromPanel: boolean;
    warnings: string[];
  };
}

export interface ProjectContextOptions {
  repoPath?: string | null;
  projectId?: string | null;
  primaryRepoId?: string | null;
}

export interface ProjectTaskBriefOptions extends ProjectContextOptions {
  taskTitle?: string | null;
  taskBody?: string | null;
  includeLocalPaths?: boolean;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId.trim()} does not exist.`);
    this.name = 'ProjectNotFoundError';
  }
}

const RAIL_IMPORT_PLACEHOLDER = 'Imported from the desktop project rail.';

function normalizeRepoPath(inputPath: string) {
  return path.resolve(inputPath.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? ''));
}

function projectNameToSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project';
}

function inferRepoRole(repo: RepoRegistryEntry): ProjectRole | null {
  const haystack = `${repo.name} ${repo.localPath} ${repo.remoteUrl ?? ''}`.toLowerCase();
  if (/\b(mobile|ios|android|expo|react-native)\b/.test(haystack)) return 'mobile';
  if (/\b(site|web|marketing|docs)\b/.test(haystack)) return 'site';
  if (/\b(api|server|service)\b/.test(haystack)) return 'service';
  if (/\b(infra|deploy|terraform)\b/.test(haystack)) return 'infra';
  if (/\b(lib|library|sdk|shared)\b/.test(haystack)) return 'library';
  return 'fullstack';
}

function repoByPath(repos: RepoRegistryEntry[]) {
  const map = new Map<string, RepoRegistryEntry>();
  for (const repo of repos) {
    map.set(normalizeRepoPath(repo.localPath), repo);
  }
  return map;
}

function repoById(repos: RepoRegistryEntry[]) {
  return new Map(repos.map((repo) => [repo.id, repo]));
}

function findSettingsProject(
  projects: ProjectWithRepos[],
  panelProject: ProjectRecord,
  scopedRepoId: string | null,
): ProjectWithRepos | null {
  // Prefer the SQLite project that matches the resolved (active) panel project.
  // A repo can belong to several projects, so a repo-id match alone would pick an
  // arbitrary one — the active project is the right context.
  const panelSlug = projectNameToSlug(panelProject.name);
  const byPanel = projects.find((project) => project.slug === panelSlug)
    ?? projects.find((project) => project.name.toLowerCase() === panelProject.name.toLowerCase());
  if (byPanel) return byPanel;

  if (scopedRepoId) {
    const byRepo = projects.find((project) => project.repos.some((link) => link.repoId === scopedRepoId));
    if (byRepo) return byRepo;
  }

  return null;
}

function resolveExplicitProject(
  projects: ProjectWithRepos[],
  ledgerProjects: ProjectRecord[],
  requestedProjectId: string,
): { panelProject: ProjectRecord; settingsProject: ProjectWithRepos | null } {
  const requested = requestedProjectId.trim().toLowerCase();
  if (isVirtualRepoProjectId(requested)) {
    const panelProject = ledgerProjects.find((project) => project.id.toLowerCase() === requested);
    if (!panelProject) {
      throw new ProjectNotFoundError(requestedProjectId);
    }
    // Virtual single-repo ids represent their own ledger projection. A Settings
    // project with the same name is a different identity and owns different repos.
    return { panelProject, settingsProject: null };
  }
  const settingsProject = projects.find((project) => project.id.toLowerCase() === requested)
    ?? projects.find((project) => project.slug.toLowerCase() === requested)
    ?? null;
  const panelProject = settingsProject
    ? ledgerProjects.find((project) => project.id.toLowerCase() === settingsProject.id.toLowerCase())
      ?? ledgerProjects.find((project) => (
        projectNameToSlug(project.name) === settingsProject.slug
        && project.name.toLowerCase() === settingsProject.name.toLowerCase()
      ))
      ?? null
    : ledgerProjects.find((project) => project.id.toLowerCase() === requested)
      ?? ledgerProjects.find((project) => projectNameToSlug(project.name) === requested)
      ?? null;

  if (!panelProject) {
    throw new ProjectNotFoundError(requestedProjectId);
  }

  const matchedSettingsProject = settingsProject
    ?? projects.find((project) => project.id === panelProject.id)
    ?? projects.find((project) => (
      project.slug === projectNameToSlug(panelProject.name)
      && project.name.toLowerCase() === panelProject.name.toLowerCase()
    ))
    ?? null;
  return { panelProject, settingsProject: matchedSettingsProject };
}

function primaryRepoScore(repo: ProjectContextRepo): number {
  switch (repo.role) {
    case 'fullstack':
      return 100;
    case 'backend':
      return 90;
    case 'service':
      return 80;
    case 'frontend':
      return 70;
    case 'shared':
      return 60;
    case 'library':
      return 55;
    case 'mobile':
      return 40;
    case 'site':
      return 35;
    case 'docs':
      return 20;
    case 'infra':
      return 10;
    default:
      return 50;
  }
}

function chooseProjectPrimaryRepo(
  repos: ProjectContextRepo[],
  preferredRepoId: string | null,
): ProjectContextRepo | null {
  if (preferredRepoId) {
    const explicit = repos.find((repo) => repo.id === preferredRepoId);
    if (explicit) return explicit;
  }

  return [...repos].sort((left, right) => {
    const scoreDelta = primaryRepoScore(right) - primaryRepoScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    if (left.inSettingsProject !== right.inSettingsProject) return left.inSettingsProject ? -1 : 1;
    if (left.inPanelProject !== right.inPanelProject) return left.inPanelProject ? -1 : 1;
    return left.name.localeCompare(right.name);
  })[0] ?? null;
}

export async function syncProjectStoreFromPanelLedger(): Promise<{
  createdProjects: number;
  linkedRepos: number;
}> {
  const [ledger, repos] = await Promise.all([getProjectsLedger(), listRepos()]);
  const byPath = repoByPath(repos);
  let projects = listProjects();
  let createdProjects = 0;
  let linkedRepos = 0;
  const hasConcretePanelProject = ledger.projects.some((project) => project.id !== DEFAULT_PROJECT_ID);

  for (const panelProject of ledger.projects) {
    if (hasConcretePanelProject && panelProject.id === DEFAULT_PROJECT_ID) continue;

    const slug = projectNameToSlug(panelProject.name);
    let settingsProject = sqliteProjectForLedger(panelProject, projects, ledger.projects);

    if (!settingsProject) {
      const created = createProject({
        name: panelProject.name,
        slug,
        description: null,
      });
      settingsProject = { ...created, repos: [] };
      projects = [settingsProject, ...projects];
      createdProjects += 1;
    } else if (settingsProject.description?.startsWith(RAIL_IMPORT_PLACEHOLDER)) {
      const updated = updateProject(settingsProject.id, { description: null });
      if (updated) {
        const cleanedProject = { ...settingsProject, description: updated.description };
        settingsProject = cleanedProject;
        projects = projects.map((project) => (
          project.id === cleanedProject.id ? cleanedProject : project
        ));
      }
    }

    const existingRepoIds = new Set(settingsProject.repos.map((link) => link.repoId));
    for (const repoPath of panelProject.repoPaths) {
      const repo = byPath.get(normalizeRepoPath(repoPath));
      if (!repo || existingRepoIds.has(repo.id)) continue;
      const link = addRepoToProject(settingsProject.id, repo.id, inferRepoRole(repo), 'manual');
      settingsProject.repos.push(link);
      existingRepoIds.add(repo.id);
      linkedRepos += 1;
    }
  }

  return { createdProjects, linkedRepos };
}

export async function syncPanelLedgerFromProjectStore(project: ProjectWithRepos, ledgerProjectId = project.id): Promise<void> {
  const repos = await listRepos();
  const byId = repoById(repos);
  const repoPaths = project.repos
    .map((link) => byId.get(link.repoId)?.localPath ?? null)
    .filter((repoPath): repoPath is string => Boolean(repoPath?.trim()))
    .map(normalizeRepoPath);

  await upsertProjectLedgerRecord({
    id: ledgerProjectId,
    sqliteProjectId: project.id,
    name: project.name,
    slug: project.slug,
    repoPaths,
  });
}

export async function getProjectContext(options: ProjectContextOptions = {}): Promise<ProjectContext> {
  // SQLite project_repos is the source of truth for membership; the ledger is a
  // derived read-model. We deliberately do NOT sync the ledger back into SQLite
  // here — that add-only sync is what resurrected removed repos on every call.
  const [repos, ledger] = await Promise.all([
    listRepos(),
    getProjectsLedger(),
  ]);
  const projects = listProjects();
  const byPath = repoByPath(repos);
  const byId = repoById(repos);
  const requestedRepoPath = options.repoPath?.trim() ? normalizeRepoPath(options.repoPath) : null;
  const explicitPrimaryRepo = options.primaryRepoId ? byId.get(options.primaryRepoId) ?? null : null;
  const currentRepoCandidate = requestedRepoPath ? byPath.get(requestedRepoPath) ?? null : null;
  const requestedProjectId = options.projectId?.trim() || null;
  let panelProject: ProjectRecord;
  let settingsProject: ProjectWithRepos | null;
  if (requestedProjectId) {
    ({ panelProject, settingsProject } = resolveExplicitProject(
      projects,
      ledger.projects,
      requestedProjectId,
    ));
  } else {
    const activeScope = await getActiveProjectScopeForRepo(options.repoPath);
    // Prefer the ACTIVE project when the requested repo belongs to it — a repo can
    // sit in multiple projects, and the agent context should follow whichever
    // project is active in the dashboard, not just the first that contains it.
    const projectHasRepo = (project: ProjectRecord) => Boolean(requestedRepoPath)
      && project.repoPaths.some((repoPath) => normalizeRepoPath(repoPath) === requestedRepoPath);
    panelProject = requestedRepoPath
      ? (projectHasRepo(activeScope.project)
          ? activeScope.project
          : ledger.projects.find(projectHasRepo) ?? activeScope.project)
      : activeScope.project;
    settingsProject = findSettingsProject(
      projects,
      panelProject,
      currentRepoCandidate?.id ?? explicitPrimaryRepo?.id ?? null,
    );
  }

  const settingsRoles = new Map<string, ProjectRole | null>();
  for (const link of settingsProject?.repos ?? []) {
    settingsRoles.set(link.repoId, link.role);
  }

  const panelPaths = new Set(panelProject.repoPaths.map(normalizeRepoPath));
  const seenRepoIds = new Set<string>();
  const contextRepos: ProjectContextRepo[] = [];
  const pushRepo = (repo: RepoRegistryEntry, flags: { inPanelProject: boolean; inSettingsProject: boolean }) => {
    if (seenRepoIds.has(repo.id)) return;
    seenRepoIds.add(repo.id);
    const isCurrent = currentRepoCandidate
      ? repo.id === currentRepoCandidate.id
      : requestedRepoPath
        ? normalizeRepoPath(repo.localPath) === requestedRepoPath
        : false;
    contextRepos.push({
      id: repo.id,
      name: repo.name,
      localPath: normalizeRepoPath(repo.localPath),
      remoteUrl: repo.remoteUrl,
      defaultBranch: repo.defaultBranch,
      role: settingsRoles.get(repo.id) ?? null,
      isPrimary: false,
      isCurrent,
      inPanelProject: flags.inPanelProject,
      inSettingsProject: flags.inSettingsProject,
    });
  };

  // SQLite membership is authoritative when a Settings project exists. A
  // ledger-only project (including a virtual single-repo project) uses its own
  // paths. An explicit project never absorbs an unrelated current repo.
  for (const link of settingsProject?.repos ?? []) {
    const repo = byId.get(link.repoId);
    if (repo) pushRepo(repo, { inPanelProject: panelPaths.has(normalizeRepoPath(repo.localPath)), inSettingsProject: true });
  }
  if (!settingsProject) {
    for (const panelRepoPath of panelProject.repoPaths) {
      const repo = byPath.get(normalizeRepoPath(panelRepoPath));
      if (repo) pushRepo(repo, { inPanelProject: true, inSettingsProject: false });
    }
  }
  const currentRepoBelongsToExplicitProject = currentRepoCandidate && (
    settingsRoles.has(currentRepoCandidate.id)
    || panelPaths.has(normalizeRepoPath(currentRepoCandidate.localPath))
  );
  if (currentRepoCandidate && (!requestedProjectId || currentRepoBelongsToExplicitProject)) {
    pushRepo(currentRepoCandidate, {
      inPanelProject: panelPaths.has(normalizeRepoPath(currentRepoCandidate.localPath)),
      inSettingsProject: settingsRoles.has(currentRepoCandidate.id),
    });
  }

  const primaryRepo = chooseProjectPrimaryRepo(
    contextRepos,
    explicitPrimaryRepo?.id ?? settingsProject?.mainRepoId ?? null,
  );
  const currentRepo = contextRepos.find((repo) => repo.isCurrent)
    ?? (requestedRepoPath ? null : primaryRepo);
  if (primaryRepo) {
    primaryRepo.isPrimary = true;
  }

  const warnings: string[] = [];
  if (!settingsProject) {
    warnings.push('No Settings project matched the active panel project; using panel project scope only.');
  }
  if (requestedRepoPath && !contextRepos.some((repo) => repo.localPath === requestedRepoPath)) {
    warnings.push('Requested repo is not part of the resolved project context.');
  }

  const repoInProject = requestedRepoPath
    ? contextRepos.some((repo) => repo.localPath === requestedRepoPath)
    : true;
  const name = settingsProject?.name ?? panelProject.name;
  const slug = settingsProject?.slug ?? projectNameToSlug(panelProject.name);

  return {
    id: settingsProject?.id ?? panelProject.id,
    name,
    slug,
    runtimeProjectId: panelProject.id,
    panelProjectId: panelProject.id,
    settingsProjectId: settingsProject?.id ?? null,
    instructions: settingsProject?.description?.trim() || null,
    repoPaths: contextRepos.map((repo) => repo.localPath),
    repos: contextRepos,
    primaryRepo,
    currentRepo,
    relatedRepos: contextRepos.filter((repo) => repo.id !== primaryRepo?.id),
    allowedRepoIds: contextRepos.map((repo) => repo.id),
    repoInProject,
    files: {
      enabled: false,
      items: [],
      note: 'Project files are not wired yet; repos and instructions are the active project context.',
    },
    source: {
      panelProjectName: panelProject.name,
      settingsProjectName: settingsProject?.name ?? null,
      syncedFromPanel: false,
      warnings,
    },
  };
}

function formatRepoLabel(repo: ProjectContextRepo) {
  return `${repo.name}${repo.role ? ` [${repo.role}]` : ''}`;
}

export const PROJECT_REPO_POLICY = 'Repo policy: treat all project repositories as one codebase. Choose the repositories needed for the task, including cross-repository changes, from the project repository list. Search, read files, and query Engineering Brain across those repositories using their repository scopes. The main repo identifies the navigation default. Plan a separate packet for each repository that needs changes. Each packet stays within its assigned repository, worktree, allowed paths, and task contract; each repository keeps its own branch, review, and merge. Preserve project membership, approvals, and locks.';

export function buildProjectTaskBrief(context: ProjectContext, options: ProjectTaskBriefOptions = {}): string {
  const siblingRepos = context.relatedRepos.filter((repo) => repo.id !== context.currentRepo?.id);
  const lines = [
    `Project: ${context.name} (${context.repos.length} repo${context.repos.length === 1 ? '' : 's'})`,
    context.primaryRepo
      ? `Main repo: ${formatRepoLabel(context.primaryRepo)}${options.includeLocalPaths === false ? '' : ` at ${context.primaryRepo.localPath}`}`
      : null,
    context.currentRepo && context.currentRepo.id !== context.primaryRepo?.id
      ? `Current repo: ${formatRepoLabel(context.currentRepo)}${options.includeLocalPaths === false ? '' : ` at ${context.currentRepo.localPath}`}`
      : null,
    siblingRepos.length > 0
      ? `Related repos: ${siblingRepos.map(formatRepoLabel).join(', ')}`
      : null,
    context.repos.length > 0
      ? `Project repositories:\n${context.repos.map(repo => `- ${formatRepoLabel(repo)}${options.includeLocalPaths === false ? '' : ` at ${repo.localPath}`}`).join('\n')}`
      : null,
    context.instructions
      ? `Project instructions:\n${context.instructions}`
      : null,
    options.taskTitle?.trim()
      ? `Task: ${truncateText(options.taskTitle, 240, { normalizeWhitespace: true })}`
      : null,
    options.taskBody?.trim()
      ? `Task detail: ${truncateText(options.taskBody, 700, { normalizeWhitespace: true })}`
      : null,
    PROJECT_REPO_POLICY,
    'Output policy: call out which repo(s) changed, any locks/conflicts encountered, and whether follow-up project wiring is needed.',
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

export async function buildProjectTaskBriefForOptions(options: ProjectTaskBriefOptions = {}): Promise<string> {
  const context = await getProjectContext(options);
  return buildProjectTaskBrief(context, options);
}
