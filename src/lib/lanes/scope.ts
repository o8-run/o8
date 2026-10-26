import { execFile } from '@/lib/providers/child-process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { getDataDir } from '@/lib/data-dir-migration';
import { readAllDirectiveTrailers } from '@/lib/cortex/directive-merges';
import { directiveAppliesToRepo, resolveActiveDirectiveProjectScope } from '@/lib/cortex/directives/filter';
import { parseDirectiveFile, type ParsedDirective } from '@/lib/cortex/directives/parse';
import { appendEvent, getLane, getLaneEvents, listLanes } from '@/lib/lane/registry';
import type { Lane, LaneRuntime, LaneStatus } from '@/lib/lane/types';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES } from '@/lib/orchestrator/preservation-envelope';
import { resolvePacketScope } from '@/lib/orchestrator/packet-scope-policy';
import { resolvePacketWorkMode } from '@/lib/orchestrator/packet-launch-context';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import type { OrchestratorPacket, OrchestratorPacketStatus, WorkerWorkMode } from '@/lib/orchestrator/types';
import { buildProjectTaskBrief, getProjectContext, type ProjectContextRepo } from '@/lib/projects/context';
import { listProjectLocks, type ProjectLock } from '@/lib/projects/locks';
import { getRuntimeProcessForWorktree, type RuntimeProcessOwner } from '@/lib/runtime/registry';

const execFileAsync = promisify(execFile);
const PACKET_SCOPE_SCHEMA = 'o8/packet.scope/v1';
const BLOCKED_PATHS = ['dist/**', 'out/**', '.next/**'];
const RELATED_PACKET_STATUSES = new Set<OrchestratorPacketStatus>(['running', 'awaiting_review', 'blocked']);
const INACTIVE_LANE_STATUSES = new Set<LaneStatus>(['completed', 'archived', 'failed']);

export interface PacketScopeDirective {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  projects: string[];
  recentMerges: string[];
}

export interface PacketScopeDirectiveReference {
  id: string;
  title: string;
}

export interface RelatedPacketScope {
  packetId: string;
  laneId: string | null;
  title: string;
  status: OrchestratorPacketStatus;
  runtime: string;
  branch: string | null;
  worktreePath: string | null;
  overlappingPaths: string[];
}

export interface PacketScopeProjectRepo {
  id: string;
  name: string;
  localPath: string;
  role: string | null;
  isMain: boolean;
  isCurrent: boolean;
}

export interface PacketScopeProjectLock {
  laneId: string;
  packetId: string | null;
  label: string;
  repoName: string;
  repoPath: string;
  runtime: string;
  branch: string;
  status: LaneStatus;
  stale: boolean;
  isCurrentLane: boolean;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
}

export interface PacketScopeProject {
  id: string;
  name: string;
  slug: string;
  runtimeProjectId: string;
  mainRepo: PacketScopeProjectRepo | null;
  currentRepo: PacketScopeProjectRepo | null;
  relatedRepos: PacketScopeProjectRepo[];
  instructions: string | null;
  taskBrief: string;
  locks: PacketScopeProjectLock[];
  files: {
    enabled: boolean;
    note: string;
  };
  definitionOfDone: string[];
  doNotTouch: string[];
}

export interface PacketScope {
  schema: typeof PACKET_SCOPE_SCHEMA;
  packetId: string | null;
  laneId: string;
  runtime: string;
  actualRuntime: LaneRuntime | null;
  /** Durable packet pin, not an assertion about the running process's OS permissions. */
  workMode: WorkerWorkMode | null;
  branch: string;
  baseBranch: string;
  headSha: string | null;
  worktreePath: string | null;
  fileLineCeiling: number;
  allowedPaths: string[];
  blockedPaths: string[];
  directives: PacketScopeDirective[];
  relatedPackets: RelatedPacketScope[];
  project: PacketScopeProject;
}

export type PacketScopeResponse = Omit<PacketScope, 'directives'> & {
  directiveCount: number;
  directives: PacketScopeDirective[] | PacketScopeDirectiveReference[];
};

export function projectPacketScope(
  scope: PacketScope,
  includeDirectives = false,
): PacketScopeResponse {
  return {
    ...scope,
    directiveCount: scope.directives.length,
    directives: includeDirectives
      ? scope.directives
      : scope.directives.map(({ id, title }) => ({ id, title })),
  };
}

export interface GetPacketScopeInput {
  packetId?: string;
  laneId?: string;
}

function normalizeId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

function findLaneByPacketId(packetId: string): Lane | null {
  return listLanes().find((lane) => lane.packetId === packetId) ?? null;
}

function packetOverlapPaths(packet: OrchestratorPacket | null): string[] {
  if (!packet) return [];
  const paths = packet.allowedFiles && packet.allowedFiles.length > 0
    ? packet.allowedFiles
    : packet.predictedFiles ?? [];
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function packetAllowedPaths(packet: OrchestratorPacket | null): string[] {
  if (!packet) return [];
  return resolvePacketScope(packet).allowedPaths;
}

function normalizePathPattern(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function patternOverlaps(left: string, right: string): boolean {
  const a = normalizePathPattern(left);
  const b = normalizePathPattern(right);
  if (a === b) return true;

  const aPrefix = a.endsWith('/**') ? a.slice(0, -2) : null;
  const bPrefix = b.endsWith('/**') ? b.slice(0, -2) : null;
  if (aPrefix && b.startsWith(aPrefix)) return true;
  if (bPrefix && a.startsWith(bPrefix)) return true;
  return false;
}

function overlappingPaths(left: string[], right: string[]): string[] {
  const overlaps = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      if (patternOverlaps(a, b)) {
        overlaps.add(a);
        overlaps.add(b);
      }
    }
  }
  return [...overlaps].sort();
}

function toDirectiveSummary(parsed: ParsedDirective, recentMerges: string[]): PacketScopeDirective {
  return {
    id: parsed.id,
    title: parsed.title,
    scope: parsed.scope,
    repoName: parsed.repoName,
    priority: parsed.priority,
    body: parsed.body,
    projects: parsed.projects,
    recentMerges,
  };
}

async function readDirectivesForRepo(repoPath: string): Promise<PacketScopeDirective[]> {
  const directivesDir = join(getDataDir(), 'directives');
  if (!existsSync(directivesDir)) return [];

  const parsed: ParsedDirective[] = [];
  for (const name of readdirSync(directivesDir).filter((entry) => entry.endsWith('.md'))) {
    try {
      const raw = readFileSync(join(directivesDir, name), 'utf-8');
      const directive = parseDirectiveFile(raw, name.replace(/\.md$/, ''));
      if (directive) parsed.push(directive);
    } catch (error) {
      console.warn(`[packet-scope] Failed to read directive ${name}:`, error);
    }
  }

  const projectScope = await resolveActiveDirectiveProjectScope(repoPath);
  const trailerMap = readAllDirectiveTrailers(3);
  return parsed
    .filter((directive) => directiveAppliesToRepo(directive, repoPath, projectScope))
    .map((directive) => toDirectiveSummary(directive, trailerMap[directive.id] ?? []))
    .sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      return a.title.localeCompare(b.title);
    });
}

async function readHeadSha(cwd: string): Promise<string | null> {
  // Full 40-char SHA. Worker agents diff this against the F42 HEAD-SHA
  // optimistic lock — short SHAs collide on busy repos.
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether a running process may be attributed to this packet's worker.
 *
 * Drift is a governance claim about THIS packet -- "it declared codex and ran
 * claude-code" -- so it may only be made about a process inside the packet's
 * own worktree. A lane with no worktree falls back to the repo root, which the
 * operator's own resident orchestrator also occupies; attributing that process
 * produced an audit record stating a packet ran a runtime it never ran, sitting
 * next to a real failure and reading as its explanation (#1838).
 */
export function runtimeDriftIsAttributable(
  worktreePath: string | null | undefined,
  repoPath: string,
  processCwd: string | null | undefined,
): boolean {
  const worktreeInput = worktreePath?.trim();
  // No isolated directory means nothing can prove ownership.
  if (!worktreeInput) return false;
  const worktree = resolve(worktreeInput);
  const repo = resolve(repoPath.trim());
  // A "worktree" that is the repo root is the shared checkout, not this packet's.
  if (worktree === repo) return false;
  const cwdInput = processCwd?.trim();
  if (!cwdInput) return false;
  const cwd = resolve(cwdInput);
  const fromWorktree = relative(worktree, cwd);
  return fromWorktree === '' || (
    fromWorktree !== '..'
    && !fromWorktree.startsWith(`..${sep}`)
    && !isAbsolute(fromWorktree)
  );
}

function recordRuntimeDriftOnce(
  lane: Lane,
  declaredRuntime: string,
  actualRuntime: LaneRuntime | null,
  processInfo: RuntimeProcessOwner | null,
) {
  if (!actualRuntime || declaredRuntime === actualRuntime) return;
  if (!runtimeDriftIsAttributable(lane.worktreePath, lane.repoPath, processInfo?.cwd)) return;
  const alreadyLogged = getLaneEvents(lane.id, 1000).some((event) => event.verb === 'runtime_drift');
  if (alreadyLogged) return;

  appendEvent(lane.id, 'runtime_drift', 'system', {
    declaredRuntime,
    actualRuntime,
    worktreePath: lane.worktreePath,
    processCwd: processInfo?.cwd ?? null,
    pid: processInfo?.pid ?? null,
    binaryPath: processInfo?.binaryPath ?? null,
  });
}

function relatedPacketsFor(
  targetPacketId: string | null,
  targetPaths: string[],
  packets: OrchestratorPacket[],
): RelatedPacketScope[] {
  if (!targetPacketId || targetPaths.length === 0) return [];
  const lanesByPacket = new Map(listLanes().flatMap((lane) => lane.packetId ? [[lane.packetId, lane] as const] : []));

  return packets.flatMap((packet) => {
    if (packet.id === targetPacketId) return [];
    if (!RELATED_PACKET_STATUSES.has(packet.status)) return [];
    const lane = lanesByPacket.get(packet.id) ?? null;
    if (!lane || INACTIVE_LANE_STATUSES.has(lane.status)) return [];

    const overlaps = overlappingPaths(targetPaths, packetOverlapPaths(packet));
    if (overlaps.length === 0) return [];
    return [{
      packetId: packet.id,
      laneId: lane.id,
      title: packet.title,
      status: packet.status,
      runtime: lane.runtime,
      branch: lane.branch,
      worktreePath: lane.worktreePath,
      overlappingPaths: overlaps,
    }];
  });
}

function toProjectRepo(
  repo: ProjectContextRepo | null,
  primaryRepoId: string | null,
  currentRepoId: string | null,
): PacketScopeProjectRepo | null {
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    localPath: repo.localPath,
    role: repo.role,
    isMain: repo.id === primaryRepoId,
    isCurrent: repo.id === currentRepoId,
  };
}

function toProjectLock(lock: ProjectLock, currentLaneId: string): PacketScopeProjectLock {
  return {
    laneId: lock.laneId,
    packetId: lock.packetId,
    label: lock.label,
    repoName: lock.repoName,
    repoPath: lock.repoPath,
    runtime: lock.runtime,
    branch: lock.branch,
    status: lock.status,
    stale: lock.stale,
    isCurrentLane: lock.laneId === currentLaneId,
    lastHeartbeatAt: lock.lastHeartbeatAt,
    lastEventAt: lock.lastEventAt,
  };
}

export async function getPacketScope(input: GetPacketScopeInput): Promise<PacketScope | null> {
  const packetIdInput = normalizeId(input.packetId);
  const laneIdInput = normalizeId(input.laneId);
  const lane = laneIdInput ? getLane(laneIdInput) : packetIdInput ? findLaneByPacketId(packetIdInput) : null;
  if (!lane) return null;
  if (packetIdInput && lane.packetId !== packetIdInput) return null;

  const mission = currentMissionState();
  const packetId = packetIdInput ?? lane.packetId;
  const workMode = packetId ? resolvePacketWorkMode(packetId) : { found: false } as const;
  const packet = packetId ? mission.packets.find((candidate) => candidate.id === packetId) ?? null : null;
  const repoPath = lane.worktreePath || lane.repoPath;
  const allowedPaths = packetAllowedPaths(packet);
  const overlapPaths = packetOverlapPaths(packet);
  const [directives, headSha, runtimeProcess] = await Promise.all([
    readDirectivesForRepo(lane.repoPath),
    readHeadSha(repoPath),
    getRuntimeProcessForWorktree(lane.worktreePath),
  ]);
  const declaredRuntime = packet?.runtime ?? lane.runtime;
  const actualRuntime = runtimeProcess?.runtime ?? null;
  const projectContext = await getProjectContext({
    repoPath: lane.repoPath,
    projectId: lane.projectId,
  });
  const projectBrief = buildProjectTaskBrief(projectContext, {
    repoPath: lane.repoPath,
    taskTitle: packet?.title ?? lane.label,
    taskBody: packet?.summary ?? null,
  });
  const projectLocks = await listProjectLocks(projectContext.id);
  const primaryRepoId = projectContext.primaryRepo?.id ?? null;
  const currentRepoId = projectContext.currentRepo?.id ?? null;
  const relatedRepos = projectContext.repos
    .filter((repo) => repo.id !== primaryRepoId && repo.id !== currentRepoId)
    .map((repo) => toProjectRepo(repo, primaryRepoId, currentRepoId))
    .filter((repo): repo is PacketScopeProjectRepo => Boolean(repo));

  recordRuntimeDriftOnce(lane, declaredRuntime, actualRuntime, runtimeProcess);

  return {
    schema: PACKET_SCOPE_SCHEMA,
    packetId,
    laneId: lane.id,
    runtime: declaredRuntime,
    actualRuntime,
    workMode: workMode.found ? workMode.workMode ?? 'edit' : null,
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    headSha,
    worktreePath: lane.worktreePath,
    fileLineCeiling: FILE_SIZE_BLOCK_THRESHOLD_LINES,
    allowedPaths,
    blockedPaths: BLOCKED_PATHS,
    directives,
    relatedPackets: relatedPacketsFor(packetId, overlapPaths, mission.packets),
    project: {
      id: projectContext.id,
      name: projectContext.name,
      slug: projectContext.slug,
      runtimeProjectId: projectContext.runtimeProjectId,
      mainRepo: toProjectRepo(projectContext.primaryRepo, primaryRepoId, currentRepoId),
      currentRepo: toProjectRepo(projectContext.currentRepo, primaryRepoId, currentRepoId),
      relatedRepos,
      instructions: projectContext.instructions,
      taskBrief: projectBrief,
      locks: projectLocks.map((lock) => toProjectLock(lock, lane.id)),
      files: {
        enabled: projectContext.files.enabled,
        note: projectContext.files.note,
      },
      definitionOfDone: [
        'Stay inside allowed paths unless the task explicitly requires a scoped expansion.',
        'Request bounded expansion with o8 packet expand-scope and record why each added path is required.',
        'Run targeted checks for the changed surface, or report why checks were not possible.',
        'Report changed repos, locks/conflicts, and review handoffs before completion.',
      ],
      doNotTouch: [
        ...BLOCKED_PATHS,
        'Sibling repos unless the task explicitly requires cross-repo edits.',
        'Unrelated user or agent changes already present in the worktree.',
      ],
    },
  };
}
