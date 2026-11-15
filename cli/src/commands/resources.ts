import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

interface RepoEntry {
  id: string;
  name: string;
  localPath: string;
  remoteUrl?: string | null;
  defaultBranch?: string;
  exists?: boolean;
  readiness?: {
    state?: string;
    label?: string;
    dispatchable?: boolean;
    nextAction?: string;
    failedCheck?: string;
    correctiveAction?: string;
  };
}

interface RepoListResponse {
  repos?: RepoEntry[];
}

interface ProjectEntry {
  id: string;
  name: string;
  color?: string;
  repoPaths?: string[];
  createdAt?: string;
}

interface ProjectLedger {
  activeProjectId?: string;
  projects?: ProjectEntry[];
}

interface RepoDeleteResponse {
  ok?: boolean;
  removedId?: string;
  stoppedSessions?: {
    targetedSessionCount?: number;
    stoppedSessionCount?: number;
    removedTerminalBindings?: number;
    cleanupPending?: boolean;
  };
}

function positionals(rest: string[], valueFlags: Set<string>): string[] {
  const values: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('-')) {
      values.push(token);
      continue;
    }
    const [flag, inline] = token.split('=', 2);
    if (valueFlags.has(flag!)) {
      if (inline === undefined) index += 1;
      continue;
    }
  }
  return values;
}

function flagValues(rest: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === name) {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CliError(
          'invalid_args',
          `${name} requires a value.`,
          EXIT.INVALID_ARGS,
        );
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (token.startsWith(`${name}=`)) {
      const value = token.slice(name.length + 1).trim();
      if (!value) {
        throw new CliError(
          'invalid_args',
          `${name} requires a value.`,
          EXIT.INVALID_ARGS,
        );
      }
      values.push(value);
    }
  }
  return values;
}

function rejectUnknownFlags(rest: string[], allowed: Set<string>): void {
  for (const token of rest) {
    if (!token.startsWith('-')) continue;
    const flag = token.split('=', 1)[0]!;
    if (allowed.has(flag)) continue;
    throw new CliError(
      'invalid_args',
      `Unknown flag: ${flag}`,
      EXIT.INVALID_ARGS,
    );
  }
}

function requireSingleTarget(
  group: 'repo' | 'project',
  action: string,
  rest: string[],
  valueFlags: Set<string> = new Set(),
): string {
  const candidates = positionals(rest, valueFlags);
  if (candidates.length !== 1) {
    throw new CliError(
      'invalid_args',
      `o8 ${group} ${action} requires exactly one ${group} id, name, or path.`,
      EXIT.INVALID_ARGS,
      `Run \`o8 ${group} list\` to inspect available ${group}s.`,
    );
  }
  return candidates[0]!;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/')
      ? resolve(homedir(), trimmed.slice(2))
      : trimmed;
  const absolute = resolve(expanded);
  try {
    const canonical = realpathSync.native(absolute);
    return canonical === parse(canonical).root ? canonical : canonical.replace(/[\\/]+$/, '');
  } catch {
    return absolute === parse(absolute).root ? absolute : absolute.replace(/[\\/]+$/, '');
  }
}

function looksLikePath(value: string): boolean {
  return value === '.'
    || value === '..'
    || value === '~'
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~/')
    || isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value);
}

function resolveRepo(repos: RepoEntry[], target: string): RepoEntry {
  const byId = repos.find((repo) => repo.id === target);
  if (byId) return byId;

  if (looksLikePath(target)) {
    const wanted = normalizePath(target);
    const byPath = repos.find((repo) => normalizePath(repo.localPath) === wanted);
    if (byPath) return byPath;
  }

  const matches = repos.filter((repo) => repo.name.toLowerCase() === target.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliError(
      'ambiguous_repo',
      `More than one registered repo is named ${target}.`,
      EXIT.CONFLICT,
      'Use the repo id or absolute path from `o8 repo list`.',
    );
  }
  throw new CliError(
    'repo_not_found',
    `No registered repo matched ${target}.`,
    EXIT.NOT_FOUND,
    'Run `o8 repo list` to inspect registered repos.',
  );
}

function resolveProject(projects: ProjectEntry[], target: string): ProjectEntry {
  const byId = projects.find((project) => project.id === target);
  if (byId) return byId;
  const matches = projects.filter((project) => project.name.toLowerCase() === target.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliError(
      'ambiguous_project',
      `More than one project is named ${target}.`,
      EXIT.CONFLICT,
      'Use the project id from `o8 project list`.',
    );
  }
  throw new CliError(
    'project_not_found',
    `No project matched ${target}.`,
    EXIT.NOT_FOUND,
    'Run `o8 project list` to inspect projects.',
  );
}

async function fetchRepos(): Promise<RepoEntry[]> {
  const response = await apiFetch<RepoListResponse>(resolveConfig(), '/api/panel/repos');
  return response.data?.repos ?? [];
}

async function fetchProjectsRaw(): Promise<ProjectLedger> {
  const response = await apiFetch<ProjectLedger>(resolveConfig(), '/api/panel/projects');
  return response.data ?? { projects: [] };
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

async function fetchProjects(): Promise<ProjectLedger> {
  return publicProjectLedger(await fetchProjectsRaw());
}

function repoPayload(repo: RepoEntry) {
  return {
    id: repo.id,
    name: repo.name,
    path: repo.localPath,
    remoteUrl: repo.remoteUrl ?? null,
    defaultBranch: repo.defaultBranch ?? null,
    exists: repo.exists ?? null,
    readiness: repo.readiness?.state ?? null,
    dispatchable: repo.readiness?.dispatchable ?? null,
    failedCheck: repo.readiness?.failedCheck ?? null,
    correctiveAction: repo.readiness?.correctiveAction ?? repo.readiness?.nextAction ?? null,
    nextAction: repo.readiness?.nextAction ?? repo.readiness?.correctiveAction ?? null,
  };
}

function projectPayload(project: ProjectEntry, activeProjectId?: string) {
  return {
    id: project.id,
    name: project.name,
    active: project.id === activeProjectId,
    color: project.color ?? null,
    repoPaths: project.repoPaths ?? [],
    repoCount: project.repoPaths?.length ?? 0,
    createdAt: project.createdAt ?? null,
  };
}

async function runRepoList(mode: OutputMode, rest: string[]): Promise<number> {
  rejectUnknownFlags(rest, new Set());
  if (positionals(rest, new Set()).length > 0) {
    throw new CliError('invalid_args', 'o8 repo list does not accept positional arguments.', EXIT.INVALID_ARGS);
  }
  const repos = await fetchRepos();
  const payload = {
    schema: 'o8/cli/repo.list/v1',
    count: repos.length,
    repos: repos.map(repoPayload),
  };
  if (mode.human) {
    printHumanHeading(`repos (${repos.length})`);
    if (repos.length === 0) process.stdout.write('  (no registered repos)\n');
    else printHumanKv(repos.map((repo) => [repo.id, `${repo.name} · ${repo.localPath}`]));
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

async function runRepoAdd(mode: OutputMode, rest: string[]): Promise<number> {
  rejectUnknownFlags(rest, new Set());
  const target = requireSingleTarget('repo', 'add', rest);
  const response = await apiFetch<{ repo?: RepoEntry }>(resolveConfig(), '/api/panel/repos', {
    method: 'POST',
    body: { action: 'add', localPath: normalizePath(target) },
  });
  const repo = response.data?.repo;
  if (!repo) {
    throw new CliError('invalid_response', 'The o8 app did not return the registered repo.', EXIT.INVALID_ARGS);
  }
  const payload = {
    schema: 'o8/cli/repo.add/v1',
    registered: true,
    repo: repoPayload(repo),
  };
  if (mode.human) {
    printHumanHeading('repo added');
    printHumanKv([
      ['id', repo.id],
      ['name', repo.name],
      ['path', repo.localPath],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

async function runRepoRemove(mode: OutputMode, rest: string[]): Promise<number> {
  rejectUnknownFlags(rest, new Set());
  const target = requireSingleTarget('repo', 'remove', rest);
  const repos = await fetchRepos();
  const repo = resolveRepo(repos, target);
  const response = await apiFetch<RepoDeleteResponse>(resolveConfig(), '/api/panel/repos', {
    method: 'DELETE',
    body: { id: repo.id },
  });
  const payload = {
    schema: 'o8/cli/repo.remove/v1',
    removed: repoPayload(repo),
    removedFromRegistry: response.data?.ok === true,
    removedFromProjects: true,
    localFolderPreserved: true,
    runtimeCleanup: response.data?.stoppedSessions ?? null,
  };
  if (mode.human) {
    printHumanHeading('repo removed');
    printHumanKv([
      ['id', repo.id],
      ['name', repo.name],
      ['registry', 'removed'],
      ['local folder', `preserved at ${repo.localPath}`],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

async function runProjectList(mode: OutputMode, rest: string[]): Promise<number> {
  rejectUnknownFlags(rest, new Set());
  if (positionals(rest, new Set()).length > 0) {
    throw new CliError('invalid_args', 'o8 project list does not accept positional arguments.', EXIT.INVALID_ARGS);
  }
  const ledger = await fetchProjects();
  const projects = ledger.projects ?? [];
  const payload = {
    schema: 'o8/cli/project.list/v1',
    activeProjectId: ledger.activeProjectId ?? null,
    count: projects.length,
    projects: projects.map((project) => projectPayload(project, ledger.activeProjectId)),
  };
  if (mode.human) {
    printHumanHeading(`projects (${projects.length})`);
    if (projects.length === 0) process.stdout.write('  (no projects)\n');
    else {
      printHumanKv(projects.map((project) => [
        project.id,
        `${project.name}${project.id === ledger.activeProjectId ? ' · active' : ''} · ${project.repoPaths?.length ?? 0} repos`,
      ]));
    }
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

async function runProjectCreate(mode: OutputMode, rest: string[]): Promise<number> {
  const valueFlags = new Set(['--name', '--repo']);
  rejectUnknownFlags(rest, valueFlags);
  const positional = positionals(rest, valueFlags);
  const nameValues = flagValues(rest, '--name');
  if (nameValues.length > 1 || positional.length > 1 || (nameValues.length === 1 && positional.length === 1)) {
    throw new CliError(
      'invalid_args',
      'Provide the project name once, either positionally or with --name.',
      EXIT.INVALID_ARGS,
      'Example: `o8 project create "Website" --repo /path/to/site`.',
    );
  }
  const name = (nameValues[0] ?? positional[0] ?? '').trim();
  if (!name) {
    throw new CliError(
      'invalid_args',
      'o8 project create requires a project name.',
      EXIT.INVALID_ARGS,
      'Example: `o8 project create "Website"`.',
    );
  }

  const repoTargets = flagValues(rest, '--repo');
  const repos = repoTargets.length > 0 ? await fetchRepos() : [];
  const repoPaths = repoTargets.map((target) => resolveRepo(repos, target).localPath);
  let response = await apiFetch<ProjectLedger>(resolveConfig(), '/api/panel/projects', {
    method: 'POST',
    body: { name },
  });
  let ledger = response.data ?? { projects: [] };
  const created = (ledger.projects ?? []).find((project) => project.id === ledger.activeProjectId)
    ?? (ledger.projects ?? []).find((project) => project.name === name);
  if (!created) {
    throw new CliError('invalid_response', 'The o8 app created a project but did not return it.', EXIT.INVALID_ARGS);
  }

  if (repoPaths.length > 0) {
    response = await apiFetch<ProjectLedger>(resolveConfig(), `/api/panel/projects/${encodeURIComponent(created.id)}`, {
      method: 'PATCH',
      body: { repoPaths },
    });
    ledger = response.data ?? ledger;
  }
  const updated = (ledger.projects ?? []).find((project) => project.id === created.id) ?? created;
  const payload = {
    schema: 'o8/cli/project.create/v1',
    created: projectPayload(updated, ledger.activeProjectId),
  };
  if (mode.human) {
    printHumanHeading('project created');
    printHumanKv([
      ['id', updated.id],
      ['name', updated.name],
      ['repos', String(updated.repoPaths?.length ?? 0)],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

async function runProjectUse(mode: OutputMode, rest: string[]): Promise<number> {
  rejectUnknownFlags(rest, new Set());
  const target = requireSingleTarget('project', 'use', rest);
  const ledger = await fetchProjects();
  const project = resolveProject(ledger.projects ?? [], target);
  const response = await apiFetch<ProjectLedger>(resolveConfig(), '/api/panel/projects/active', {
    method: 'POST',
    body: { projectId: project.id },
  });
  const payload = {
    schema: 'o8/cli/project.use/v1',
    activeProjectId: response.data?.activeProjectId ?? project.id,
    project: projectPayload(project, project.id),
  };
  if (mode.human) {
    printHumanHeading('active project');
    printHumanKv([['id', project.id], ['name', project.name]]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

async function runProjectMembership(
  mode: OutputMode,
  rest: string[],
  action: 'add-repo' | 'remove-repo',
): Promise<number> {
  rejectUnknownFlags(rest, new Set());
  const targets = positionals(rest, new Set());
  if (targets.length !== 2) {
    throw new CliError(
      'invalid_args',
      `o8 project ${action} requires a project target and a repo target.`,
      EXIT.INVALID_ARGS,
      `Example: \`o8 project ${action} "Website" /path/to/repo\`.`,
    );
  }
  const [projectTarget, repoTarget] = targets as [string, string];
  const [ledger, repos] = await Promise.all([fetchProjects(), fetchRepos()]);
  const project = resolveProject(ledger.projects ?? [], projectTarget);
  const repo = resolveRepo(repos, repoTarget);
  const current = project.repoPaths ?? [];
  const wanted = normalizePath(repo.localPath);
  const repoPaths = action === 'add-repo'
    ? Array.from(new Set([...current, repo.localPath]))
    : current.filter((candidate) => normalizePath(candidate) !== wanted);
  const response = await apiFetch<ProjectLedger>(resolveConfig(), `/api/panel/projects/${encodeURIComponent(project.id)}`, {
    method: 'PATCH',
    body: { repoPaths },
  });
  const updated = (response.data?.projects ?? []).find((entry) => entry.id === project.id)
    ?? { ...project, repoPaths };
  const payload = {
    schema: `o8/cli/project.${action}/v1`,
    action,
    project: projectPayload(updated, response.data?.activeProjectId),
    repo: repoPayload(repo),
    repoRegistrationPreserved: true,
    localFolderPreserved: true,
  };
  if (mode.human) {
    printHumanHeading(action === 'add-repo' ? 'repo added to project' : 'repo removed from project');
    printHumanKv([
      ['project', `${project.name} (${project.id})`],
      ['repo', `${repo.name} (${repo.id})`],
      ['local folder', 'preserved'],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

async function runProjectDelete(mode: OutputMode, rest: string[]): Promise<number> {
  rejectUnknownFlags(rest, new Set());
  const target = requireSingleTarget('project', 'delete', rest);
  const [rawLedger, beforeRepos] = await Promise.all([fetchProjectsRaw(), fetchRepos()]);
  const ledger = publicProjectLedger(rawLedger);
  const projects = ledger.projects ?? [];
  const project = resolveProject(projects, target);
  if ((rawLedger.projects?.length ?? 0) <= 1) {
    throw new CliError(
      'last_project',
      'o8 keeps one project so new work always has a destination.',
      EXIT.CONFLICT,
      'Create a replacement with `o8 project create "Workspace"`, then retry the delete.',
    );
  }
  const response = await apiFetch<ProjectLedger>(resolveConfig(), `/api/panel/projects/${encodeURIComponent(project.id)}`, {
    method: 'DELETE',
  });
  const afterRepos = await fetchRepos();
  const afterIds = new Set(afterRepos.map((repo) => repo.id));
  const removedRepos = beforeRepos.filter((repo) => !afterIds.has(repo.id));
  const payload = {
    schema: 'o8/cli/project.delete/v1',
    removedProject: projectPayload(project, ledger.activeProjectId),
    removedExclusiveRepos: removedRepos.map(repoPayload),
    removedExclusiveRepoCount: removedRepos.length,
    localFoldersPreserved: true,
    activeProjectId: response.data?.activeProjectId ?? null,
  };
  if (mode.human) {
    printHumanHeading('project deleted');
    printHumanKv([
      ['project', `${project.name} (${project.id})`],
      ['exclusive repo registrations removed', String(removedRepos.length)],
      ['local folders', 'preserved'],
      ['active project', response.data?.activeProjectId ?? 'unknown'],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

export async function runRepo(
  mode: OutputMode,
  subcommand: string | undefined,
  rest: string[],
): Promise<number> {
  switch (subcommand) {
    case 'list':
      return runRepoList(mode, rest);
    case 'add':
    case 'register':
      return runRepoAdd(mode, rest);
    case 'remove':
    case 'unregister':
      return runRepoRemove(mode, rest);
    default:
      throw new CliError(
        'unknown_repo_subcommand',
        `Unknown repo subcommand: ${subcommand ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Subcommands: list | add | remove. Run `o8 repo --help`.',
      );
  }
}

export async function runProject(
  mode: OutputMode,
  subcommand: string | undefined,
  rest: string[],
): Promise<number> {
  switch (subcommand) {
    case 'list':
      return runProjectList(mode, rest);
    case 'create':
      return runProjectCreate(mode, rest);
    case 'use':
      return runProjectUse(mode, rest);
    case 'add-repo':
      return runProjectMembership(mode, rest, 'add-repo');
    case 'remove-repo':
      return runProjectMembership(mode, rest, 'remove-repo');
    case 'delete':
      return runProjectDelete(mode, rest);
    default:
      throw new CliError(
        'unknown_project_subcommand',
        `Unknown project subcommand: ${subcommand ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Subcommands: list | create | use | add-repo | remove-repo | delete. Run `o8 project --help`.',
      );
  }
}
