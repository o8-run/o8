import { McpInputError } from '@/lib/mcp/api-error';
import { errorText } from '@/lib/mcp/operator-handlers/shared';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse, resolve } from 'node:path';

import {
  type McpTool,
  type McpToolResult,
  apiFetch,
  jsonResult,
  optionalString,
  requiredString,
  textResult,
} from './shared';

type ProjectLedger = {
  activeProjectId?: string;
  projects?: Array<{
    id: string;
    name: string;
    color?: string;
    repoPaths?: string[];
  }>;
};

type RepoRecord = {
  id: string;
  name: string;
  localPath: string;
  remoteUrl?: string | null;
  defaultBranch?: string;
  exists?: boolean;
  readiness?: { state?: string };
};

type RepoListResponse = { repos?: RepoRecord[] };

export const REPO_MGMT_TOOLS: McpTool[] = [
  {
    name: 'o8_list_repos',
    description:
      'List every local Git repository registered in the running o8 app. Use this before selecting, assigning, or removing a repo; it works from any current directory and returns stable repo IDs plus absolute paths.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'o8_register_repo',
    description:
      'USE THIS WHEN the user says "register this folder", "add /path/to/repo to o8", or "track this project in o8". Registers an existing local git repo in o8 so agents can dispatch into it without using the sidebar + button. Example: o8_register_repo({path: "/Users/me/Projects/app"})',
    inputSchema: {
      // No top-level anyOf — OpenAI strict function-calling rejects oneOf /
      // anyOf / allOf siblings to `type: 'object'`. The handler's
      // requiredPath() validates that either `path` or `repoPath` is present
      // and throws a clear message if not.
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or ~/ path, to an existing local git repo. Either path or repoPath is required.',
        },
        repoPath: {
          type: 'string',
          description: 'Alias for path. Either path or repoPath is required.',
        },
      },
      required: [],
    },
  },
  {
    name: 'o8_remove_repo',
    description:
      'Remove a repository from the running o8 app registry by repo ID or absolute path. This removes project membership and repo-bound app state, but never deletes the local folder, Git history, or remote repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: {
          type: 'string',
          description: 'Stable repo ID from o8_list_repos. Provide repoId or repoPath.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute path, or ~/ path, to the registered repo. Provide repoId or repoPath.',
        },
      },
      required: [],
    },
  },
  {
    name: 'o8_init_repo',
    description:
      'USE THIS WHEN the user says "start a new project at /tmp/foo" or "initialize a repo here". Creates the folder if needed, runs git init on main, makes an initial commit, and registers the repo in o8. Example: o8_init_repo({path: "~/Projects/hello-world", name: "hello-world"})',
    inputSchema: {
      // No top-level anyOf — see comment on o8_register_repo. Handler's
      // requiredPath() enforces either-or.
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or ~/ path, where the repo should exist. Either path or repoPath is required.',
        },
        repoPath: {
          type: 'string',
          description: 'Alias for path. Either path or repoPath is required.',
        },
        name: {
          type: 'string',
          description: 'Optional project name used for the initial README.',
        },
      },
      required: [],
    },
  },
  {
    name: 'o8_list_projects',
    description:
      'List o8 projects, the active project, and each project\'s registered repo paths. Use this before switching, editing membership, or deleting a project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'o8_create_project',
    description:
      'USE THIS WHEN the user says "create project named X" or "start a new project". Creates an o8 sidebar project and optionally assigns registered repo paths to it. Example: o8_create_project({name: "Website", repoPaths: ["/Users/me/Projects/site"]})',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name to show in o8.',
        },
        color: {
          type: 'string',
          description: 'Optional project color from o8 project palette.',
        },
        repoPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute paths, or ~/ paths, for repos to assign to the project.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'o8_set_active_project',
    description:
      'Switch the running o8 app to a project by stable project ID. This changes the operator context used for future work and does not modify any repository.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Stable project ID from o8_list_projects.',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'o8_set_project_repos',
    description:
      'Replace one o8 project\'s repo membership with an exact list of registered repo paths. Repositories stay registered and every local folder stays on disk; pass an empty list to leave the project with no repos.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Stable project ID from o8_list_projects.',
        },
        repoPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Complete desired membership as absolute paths, or ~/ paths, from o8_list_repos.',
        },
      },
      required: ['projectId', 'repoPaths'],
    },
  },
  {
    name: 'o8_delete_project',
    description:
      'Delete an o8 project by stable project ID. Exclusive repo registrations are also removed so they do not reappear as loose projects, but local folders, Git history, and remotes are never deleted. o8 keeps at least one project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Stable project ID from o8_list_projects.',
        },
      },
      required: ['projectId'],
    },
  },
];

function requiredPath(args: Record<string, unknown>, primary: 'path' | 'repoPath') {
  const first = args[primary];
  const fallback = args[primary === 'path' ? 'repoPath' : 'path'];
  const value = typeof first === 'string' && first.trim()
    ? first
    : typeof fallback === 'string' && fallback.trim()
      ? fallback
      : '';
  if (!value) {
    throw new McpInputError(`${primary} is required`);
  }
  return value.trim();
}

function repoFromResponse(data: Record<string, unknown>) {
  const repo = data.repo && typeof data.repo === 'object'
    ? data.repo as Record<string, unknown>
    : {};
  return {
    repoId: typeof repo.id === 'string' ? repo.id : null,
    repoPath: typeof repo.localPath === 'string'
      ? repo.localPath
      : typeof data.repoPath === 'string'
        ? data.repoPath
        : null,
  };
}

function normalizeRepoPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim();
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? resolve(homedir(), trimmed.slice(2))
      : trimmed;
  try {
    const canonical = realpathSync.native(resolve(expanded));
    return canonical === parse(canonical).root ? canonical : canonical.replace(/[\\/]+$/, '');
  } catch {
    const absolute = resolve(expanded);
    return absolute === parse(absolute).root ? absolute : absolute.replace(/[\\/]+$/, '');
  }
}

function repoSummary(repo: RepoRecord) {
  return {
    id: repo.id,
    name: repo.name,
    repoPath: repo.localPath,
    remoteUrl: repo.remoteUrl ?? null,
    defaultBranch: repo.defaultBranch ?? null,
    exists: repo.exists ?? null,
    readiness: repo.readiness?.state ?? null,
  };
}

async function listRegisteredRepos(): Promise<RepoRecord[]> {
  const data = await apiFetch('/api/panel/repos') as RepoListResponse;
  return data.repos ?? [];
}

async function readRawProjectLedger(): Promise<ProjectLedger> {
  return await apiFetch('/api/panel/projects') as ProjectLedger;
}

function publicProjectLedger(ledger: ProjectLedger): ProjectLedger {
  const projects = ledger.projects ?? [];
  const hasConcreteProject = projects.some((project) => project.id !== 'default');
  return {
    ...ledger,
    projects: hasConcreteProject
      ? projects.filter((project) => project.id !== 'default')
      : projects,
  };
}

async function readProjectLedger(): Promise<ProjectLedger> {
  return publicProjectLedger(await readRawProjectLedger());
}

function findProject(ledger: ProjectLedger, projectId: string) {
  return (ledger.projects ?? []).find((project) => project.id === projectId) ?? null;
}

async function projectIdForRepo(repoPath: string | null): Promise<string | null> {
  if (!repoPath) return null;
  try {
    const ledger = await apiFetch('/api/panel/projects') as ProjectLedger;
    const target = normalizeRepoPath(repoPath);
    const project = (ledger.projects ?? []).find((entry) => (
      (entry.repoPaths ?? []).some((candidate) => normalizeRepoPath(candidate) === target)
    ));
    return project?.id ?? ledger.activeProjectId ?? null;
  } catch {
    return null;
  }
}

function activeProjectFromLedger(ledger: ProjectLedger) {
  const activeId = ledger.activeProjectId;
  return (ledger.projects ?? []).find((project) => project.id === activeId)
    ?? (ledger.projects ?? [])[0]
    ?? null;
}

export async function handleRegisterRepo(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const path = requiredPath(args, 'path');
    const data = await apiFetch('/api/panel/repos', {
      method: 'POST',
      body: JSON.stringify({ action: 'add', localPath: path }),
    }) as Record<string, unknown>;
    if (typeof data.error === 'string') {
      return textResult(data.error, true);
    }
    const repo = repoFromResponse(data);
    const projectId = await projectIdForRepo(repo.repoPath);
    return jsonResult({
      registered: true,
      repoId: repo.repoId,
      repoPath: repo.repoPath,
      projectId,
    });
  } catch (error) {
    return textResult(`Failed to register repo: ${errorText(error)}`, true);
  }
}

export async function handleListRepos(): Promise<McpToolResult> {
  try {
    const repos = await listRegisteredRepos();
    return jsonResult({ count: repos.length, repos: repos.map(repoSummary) });
  } catch (error) {
    return textResult(`Failed to list repos: ${errorText(error)}`, true);
  }
}

export async function handleRemoveRepo(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoId = optionalString(args, 'repoId');
    const repoPath = optionalString(args, 'repoPath');
    if (!repoId && !repoPath) {
      return textResult('repoId or repoPath is required', true);
    }
    const repos = await listRegisteredRepos();
    const normalizedPath = normalizeRepoPath(repoPath);
    const repo = repos.find((entry) => (
      (repoId && entry.id === repoId)
      || (normalizedPath && normalizeRepoPath(entry.localPath) === normalizedPath)
    ));
    if (!repo) return textResult('Registered repo not found. Call o8_list_repos for current IDs and paths.', true);

    const data = await apiFetch('/api/panel/repos', {
      method: 'DELETE',
      body: JSON.stringify({ id: repo.id }),
    }) as Record<string, unknown>;
    return jsonResult({
      removed: repoSummary(repo),
      removedFromRegistry: data.ok === true,
      removedFromProjects: true,
      localFolderPreserved: true,
      runtimeCleanup: data.stoppedSessions ?? null,
    });
  } catch (error) {
    return textResult(`Failed to remove repo: ${errorText(error)}`, true);
  }
}

export async function handleInitRepo(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const path = requiredPath(args, 'path');
    const data = await apiFetch('/api/panel/repos/init', {
      method: 'POST',
      body: JSON.stringify({ path, name: optionalString(args, 'name') || undefined }),
    }) as Record<string, unknown>;
    if (typeof data.error === 'string') {
      return textResult(data.error, true);
    }
    const repo = repoFromResponse(data);
    return jsonResult({
      initialized: true,
      repoId: repo.repoId,
      repoPath: repo.repoPath,
      projectId: typeof data.projectId === 'string' ? data.projectId : null,
      initialCommit: data.initialCommit === true,
    });
  } catch (error) {
    return textResult(`Failed to initialize repo: ${errorText(error)}`, true);
  }
}

export async function handleCreateProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const name = requiredString(args, 'name');
    let ledger = await apiFetch('/api/panel/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }) as ProjectLedger & { error?: string };
    if (typeof ledger.error === 'string') {
      return textResult(ledger.error, true);
    }

    const project = activeProjectFromLedger(ledger);
    if (!project) {
      return textResult('Project was created but the project ledger did not return it.', true);
    }

    const patch: { color?: string; repoPaths?: string[] } = {};
    const color = optionalString(args, 'color');
    if (color) patch.color = color;
    if (Array.isArray(args.repoPaths)) {
      patch.repoPaths = args.repoPaths
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
    }
    if (patch.color || patch.repoPaths) {
      ledger = await apiFetch(`/api/panel/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }) as ProjectLedger & { error?: string };
      if (typeof ledger.error === 'string') {
        return textResult(ledger.error, true);
      }
    }

    const updated = (ledger.projects ?? []).find((entry) => entry.id === project.id) ?? project;
    return jsonResult({
      projectId: updated.id,
      name: updated.name,
      color: updated.color ?? null,
      repoPaths: updated.repoPaths ?? [],
    });
  } catch (error) {
    return textResult(`Failed to create project: ${errorText(error)}`, true);
  }
}

export async function handleListProjects(): Promise<McpToolResult> {
  try {
    const ledger = await readProjectLedger();
    return jsonResult({
      activeProjectId: ledger.activeProjectId ?? null,
      count: ledger.projects?.length ?? 0,
      projects: (ledger.projects ?? []).map((project) => ({
        ...project,
        active: project.id === ledger.activeProjectId,
        repoPaths: project.repoPaths ?? [],
        repoCount: project.repoPaths?.length ?? 0,
      })),
    });
  } catch (error) {
    return textResult(`Failed to list projects: ${errorText(error)}`, true);
  }
}

export async function handleSetActiveProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = requiredString(args, 'projectId');
    const ledger = await readProjectLedger();
    const project = findProject(ledger, projectId);
    if (!project) return textResult('Project not found. Call o8_list_projects for current IDs.', true);
    const updated = await apiFetch('/api/panel/projects/active', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    }) as ProjectLedger;
    return jsonResult({ activeProjectId: updated.activeProjectId ?? projectId, project });
  } catch (error) {
    return textResult(`Failed to switch project: ${errorText(error)}`, true);
  }
}

export async function handleSetProjectRepos(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = requiredString(args, 'projectId');
    if (!Array.isArray(args.repoPaths)) return textResult('repoPaths must be an array', true);
    const repoPaths = args.repoPaths.map((entry) => (
      typeof entry === 'string' ? entry.trim() : ''
    )).filter(Boolean);
    if (repoPaths.length !== args.repoPaths.length) {
      return textResult('Every repoPaths entry must be a non-empty string', true);
    }
    const [ledger, repos] = await Promise.all([readProjectLedger(), listRegisteredRepos()]);
    if (!findProject(ledger, projectId)) {
      return textResult('Project not found. Call o8_list_projects for current IDs.', true);
    }
    const registeredPaths = new Map(repos.map((repo) => [
      normalizeRepoPath(repo.localPath),
      repo.localPath,
    ]));
    const unknownPaths = repoPaths.filter((repoPath) => !registeredPaths.has(normalizeRepoPath(repoPath)));
    if (unknownPaths.length > 0) {
      return textResult(`These repos are not registered: ${unknownPaths.join(', ')}. Register them first with o8_register_repo.`, true);
    }
    const resolvedRepoPaths = repoPaths.map((repoPath) => registeredPaths.get(normalizeRepoPath(repoPath))!);
    const updated = await apiFetch(`/api/panel/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ repoPaths: resolvedRepoPaths }),
    }) as ProjectLedger;
    const project = findProject(updated, projectId);
    return jsonResult({
      project,
      repoPaths: project?.repoPaths ?? resolvedRepoPaths,
      repoRegistrationsPreserved: true,
      localFoldersPreserved: true,
    });
  } catch (error) {
    return textResult(`Failed to set project repos: ${errorText(error)}`, true);
  }
}

export async function handleDeleteProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = requiredString(args, 'projectId');
    const [rawLedger, beforeRepos] = await Promise.all([readRawProjectLedger(), listRegisteredRepos()]);
    const ledger = publicProjectLedger(rawLedger);
    const project = findProject(ledger, projectId);
    if (!project) return textResult('Project not found. Call o8_list_projects for current IDs.', true);
    if ((rawLedger.projects?.length ?? 0) <= 1) {
      return textResult('o8 keeps one project so new work always has a destination. Create a replacement project, then retry.', true);
    }
    const updated = await apiFetch(`/api/panel/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    }) as ProjectLedger;
    const afterRepos = await listRegisteredRepos();
    const afterIds = new Set(afterRepos.map((repo) => repo.id));
    const removedRepos = beforeRepos.filter((repo) => !afterIds.has(repo.id));
    return jsonResult({
      removedProject: project,
      removedExclusiveRepos: removedRepos.map(repoSummary),
      removedExclusiveRepoCount: removedRepos.length,
      localFoldersPreserved: true,
      activeProjectId: updated.activeProjectId ?? null,
    });
  } catch (error) {
    return textResult(`Failed to delete project: ${errorText(error)}`, true);
  }
}
