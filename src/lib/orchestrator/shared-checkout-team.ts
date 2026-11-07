import { createHash } from 'node:crypto';
import { execFileSync } from '@/lib/providers/child-process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import type { WorkerRouting } from './types';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import { getDataDir } from '@/lib/data-dir-migration';

export interface SharedCheckoutMember {
  /** Exact assistant turn that launched this worker; absent on older receipts. */
  parentTurnId?: string;
  workerRouting?: WorkerRouting;
  carrier?: ClaudeCodeModelSource | null;
  executionCarrier?: ExecutionCarrierId | null;
  surfaceId: string | null;
  runtime: string;
  taskName: string;
  clientMutationId: string;
  launchedAt: string;
  paths: string[];
  state: 'reserved' | 'running' | 'failed' | 'settled';
  settledOutcome?: 'finished' | 'interrupted' | 'failed';
}

export interface SharedCheckoutTeam {
  id: string;
  path: string;
  branch: string;
  baseHead: string;
  parentThreadId: string;
  createdAt: string;
  initialChangedPaths: string[];
  initialChangedFingerprints: Record<string, string>;
  members: SharedCheckoutMember[];
  reconciliations?: SharedCheckoutReconciliation[];
}

interface SharedCheckoutReview {
  id: string;
  head: string;
  paths: string[];
  fingerprints: Record<string, string>;
}

interface SharedCheckoutReconciliation extends SharedCheckoutReview {
  reviewedAt: string;
  reviewSummary: string;
}

interface TeamInput {
  repoPath: string;
  parentThreadId: string;
  dataDir?: string;
}

function git(cwd: string, ...args: string[]): string {
  return gitRaw(cwd, ...args).trim();
}

function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000, windowsHide: true });
}

function changedPaths(path: string): string[] {
  const tracked = gitRaw(path, 'diff', '--no-renames', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
  const staged = gitRaw(path, 'diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
  const untracked = gitRaw(path, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  return [...new Set([...tracked, ...staged, ...untracked])].sort();
}

function changedFingerprint(root: string, relativePath: string): string {
  const file = join(root, relativePath);
  const digest = createHash('sha256');
  digest.update(git(root, 'status', '--porcelain', '-z', '--', relativePath));
  digest.update(git(root, 'diff', '--binary', 'HEAD', '--', relativePath));
  digest.update(git(root, 'ls-files', '--stage', '-z', '--', relativePath));
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) digest.update('missing');
  else {
    digest.update(String(info.mode));
    if (info.isSymbolicLink()) digest.update(readlinkSync(file));
    else if (info.isFile()) digest.update(readFileSync(file));
    else digest.update(info.isDirectory() ? 'directory' : 'special');
  }
  return `index-v2:${digest.digest('hex')}`;
}

function changedFingerprints(root: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, changedFingerprint(root, path)]));
}

function committedPaths(path: string, baseHead: string): string[] {
  return gitRaw(path, 'diff', '--no-renames', '--name-only', '-z', baseHead, 'HEAD').split('\0').filter(Boolean).sort();
}

function teamLocation(input: TeamInput): { id: string; file: string; lock: string; path: string } {
  const path = realpathSync(input.repoPath);
  const id = createHash('sha256').update(path).digest('hex').slice(0, 24);
  const directory = join(input.dataDir ?? getDataDir(), 'shared-checkout-teams');
  return { id, path, file: join(directory, `${id}.json`), lock: join(directory, `${id}.lock`) };
}

function currentCheckout(path: string): { branch: string; head: string } {
  if (realpathSync(git(path, 'rev-parse', '--show-toplevel')) !== path) {
    throw new Error('Shared mode requires the exact checkout root.');
  }
  let branch: string;
  try {
    branch = git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  } catch {
    throw new Error('Shared checkout branch changed or is detached; refusing launch.');
  }
  return { branch, head: git(path, 'rev-parse', 'HEAD') };
}

function readFile(file: string): SharedCheckoutTeam | null {
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, 'utf8')) as SharedCheckoutTeam;
  if (!value || !Array.isArray(value.members) || typeof value.parentThreadId !== 'string') {
    throw new Error('Shared checkout ownership receipt is invalid.');
  }
  return value;
}

async function withLock<T>(lock: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(join(lock, '..'), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age: number;
      try {
        age = Date.now() - (await stat(lock)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (age > 30_000) throw new Error('Shared checkout lock is stale; inspect the owner before retrying.');
      if (Date.now() - started > 10_000) throw new Error('Shared checkout is busy; retry after its current operation.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function assertOwner(team: SharedCheckoutTeam, input: TeamInput, path: string, branch: string): void {
  if (team.path !== path) throw new Error('Shared checkout path changed; refusing launch.');
  if (team.parentThreadId !== input.parentThreadId) {
    throw new Error(`This checkout is owned by orchestrator ${team.parentThreadId}. Return to its owner.`);
  }
  if (team.branch !== branch) throw new Error('Shared checkout branch changed; refusing launch.');
}

function writeTeam(file: string, team: SharedCheckoutTeam): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(team, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function readSharedCheckoutTeam(input: TeamInput): SharedCheckoutTeam | null {
  return readFile(teamLocation(input).file);
}

/**
 * Workers a chat launched into its shared checkout. They have no lane, so the owned-session
 * orphan sweeps must not treat their live runs as orphans; the chat owns them.
 */
export function listRunningSharedCheckoutSurfaceIds(dataDir = getDataDir()): Set<string> {
  const directory = join(dataDir, 'shared-checkout-teams');
  const surfaceIds = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return surfaceIds;
  }
  for (const name of names) {
    try {
      for (const member of readFile(join(directory, name))?.members ?? []) {
        if (member.state === 'running' && member.surfaceId) surfaceIds.add(member.surfaceId);
      }
    } catch {
      // An unreadable receipt protects nothing.
    }
  }
  return surfaceIds;
}

/** Read-only workspace restoration. No branch check: a drifted team still needs to be visible. */
export function readActiveSharedCheckoutTeam(repoPath: string): SharedCheckoutTeam | null {
  return readFile(teamLocation({ repoPath, parentThreadId: '' }).file);
}

/** Validate checkout identity without scanning dirty files or claiming new ownership. */
export function assertSharedCheckoutOwner(input: TeamInput): void {
  const location = teamLocation(input);
  const team = readFile(location.file);
  if (!team) throw new Error('Shared checkout ownership is no longer active.');
  assertOwner(team, input, location.path, currentCheckout(location.path).branch);
}

export function inspectSharedCheckoutTeam(input: TeamInput) {
  const team = readSharedCheckoutTeam(input);
  if (!team) return null;
  const checkout = currentCheckout(team.path);
  assertOwner(team, input, team.path, checkout.branch);
  const current = changedPaths(team.path);
  const baseline = new Set(team.initialChangedPaths);
  // Older receipts do not identify the original index; preserve that uncertainty.
  const baselineUnverifiable = team.initialChangedPaths.filter((path) => {
    const fingerprint = team.initialChangedFingerprints?.[path];
    return typeof fingerprint !== 'string' || fingerprint.length !== 73 || !/^index-v2:[0-9a-f]{64}$/.test(fingerprint);
  });
  const unverifiable = new Set(baselineUnverifiable);
  const baselineDrift = team.initialChangedPaths.filter((path) =>
    !unverifiable.has(path) && team.initialChangedFingerprints[path] !== changedFingerprint(team.path, path));
  const newPaths = current.filter((path) => !baseline.has(path));
  const committed = committedPaths(team.path, team.baseHead);
  const claimed = team.members.filter((member) => member.state !== 'failed' || member.surfaceId).flatMap((member) => member.paths);
  const outsideClaims = [...new Set([...newPaths, ...committed])]
    .filter((path) => !claimed.some((scope) => pathsOverlap(path, scope))).sort();
  const reviewPaths = [...new Set([...current, ...committed, ...team.initialChangedPaths])].sort();
  // A directory/gitlink dirty marker cannot prove the nested content reviewed.
  const unsupportedReviewPaths = reviewPaths.filter((path) => {
    const info = lstatSync(join(team.path, path), { throwIfNoEntry: false });
    return info && !info.isFile() && !info.isSymbolicLink();
  });
  const fingerprints = Object.fromEntries(reviewPaths.map((path) => [path, createHash('sha256')
    .update(changedFingerprint(team.path, path))
    // The staged version is separate from both HEAD and the working file.
    .update(gitRaw(team.path, 'diff', '--cached', '--binary', 'HEAD', '--', path))
    .digest('hex')]));
  const review: SharedCheckoutReview = {
    id: createHash('sha256').update(JSON.stringify({ path: team.path, branch: team.branch,
      head: checkout.head, baseHead: team.baseHead, createdAt: team.createdAt, parent: team.parentThreadId,
      baseline: team.initialChangedFingerprints, members: team.members, fingerprints })).digest('hex'),
    head: checkout.head,
    paths: reviewPaths,
    fingerprints,
  };
  const reconciliation = team.reconciliations?.findLast((receipt) => receipt.id === review.id) ?? null;
  return {
    team,
    currentHead: checkout.head,
    changedPaths: current,
    initialChangedPaths: team.initialChangedPaths,
    baselineDrift,
    baselineUnverifiable,
    newPaths,
    committedPaths: committed,
    outsideClaims,
    scopeClean: outsideClaims.length === 0 && baselineDrift.length === 0 && baselineUnverifiable.length === 0,
    baselineClean: team.initialChangedPaths.length === 0,
    review,
    reconciliation,
    unsupportedReviewPaths,
  };
}

export function findSharedCheckoutMemberByMutation(input: TeamInput, clientMutationId: string): SharedCheckoutMember | null {
  return readSharedCheckoutTeam(input)?.members.find((member) => member.clientMutationId === clientMutationId) ?? null;
}

function normalizeClaim(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.includes(':')
    || normalized.split('/').some((part) => !part || part === '..' || part === '.' || part === '.git')) {
    throw new Error(`Invalid shared worker path claim: ${path}`);
  }
  return normalized;
}

function assertScopeInsideCheckout(root: string, scope: string): void {
  let candidate = join(root, scope);
  while (!existsSync(candidate) && candidate !== root) candidate = dirname(candidate);
  const resolved = realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Shared worker scope escapes the checkout through a symlink: ${scope}`);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function validateSharedCheckoutPaths(paths: string[]): string[] {
  const normalized = [...new Set(paths.map(normalizeClaim))];
  if (normalized.length === 0) throw new Error('Shared workers need explicit, non-overlapping file or directory scopes.');
  return normalized;
}

export async function reserveSharedCheckoutMember(input: TeamInput & {
  workerRouting?: WorkerRouting;
  carrier?: ClaudeCodeModelSource | null;
  executionCarrier?: ExecutionCarrierId | null;
  clientMutationId: string;
  runtime: string;
  taskName: string;
  paths: string[];
}): Promise<SharedCheckoutTeam> {
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const paths = validateSharedCheckoutPaths(input.paths);
    if (!/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(input.parentThreadId)) {
      throw new Error('Shared mode requires a durable orchestrator chat.');
    }
    const checkout = currentCheckout(location.path);
    const existingTeam = await admitExistingTeam(input, location, checkout.branch);
    const initialChangedPaths = existingTeam ? [] : changedPaths(location.path);
    const team = existingTeam ?? {
      id: location.id,
      path: location.path,
      branch: checkout.branch,
      baseHead: checkout.head,
      parentThreadId: input.parentThreadId,
      createdAt: new Date().toISOString(),
      initialChangedPaths,
      initialChangedFingerprints: changedFingerprints(location.path, initialChangedPaths),
      members: [],
    };
    for (const path of paths) assertScopeInsideCheckout(team.path, path);
    const existing = team.members.find((member) => member.clientMutationId === input.clientMutationId);
    if (existing) {
      if (existing.runtime !== input.runtime || existing.taskName !== input.taskName
        || JSON.stringify(existing.paths) !== JSON.stringify(paths)
        || existing.workerRouting?.selectedModel !== input.workerRouting?.selectedModel
        || existing.workerRouting?.requestedEffort !== input.workerRouting?.requestedEffort
        || (existing.carrier ?? null) !== (input.carrier ?? null)
        || (existing.executionCarrier ?? null) !== (input.executionCarrier ?? null)) {
        throw new Error('Shared worker mutation was reused with different scope or runtime.');
      }
      return team;
    }
    if (paths.some((path) => team.initialChangedPaths.some((changed) => pathsOverlap(path, changed)))) {
      throw new Error('Shared worker scope overlaps files that were dirty before the team started. Assign a clean scope.');
    }
    // Only a matching terminal owned receipt releases a created surface's claim.
    for (const member of team.members.filter(holdsPathClaim)) {
      if (paths.some((path) => member.paths.some((claimed) => pathsOverlap(path, claimed)))) {
        throw new Error(`Shared checkout path overlaps worker ${member.taskName}; assign separate paths or wait for group review.`);
      }
    }
    team.members.push({
      surfaceId: null,
      runtime: input.runtime,
      taskName: input.taskName,
      clientMutationId: input.clientMutationId,
      launchedAt: new Date().toISOString(),
      paths,
      state: 'reserved',
      ...(input.workerRouting ? { workerRouting: input.workerRouting } : {}),
      ...(input.carrier ? { carrier: input.carrier } : {}),
      ...(input.executionCarrier ? { executionCarrier: input.executionCarrier } : {}),
    });
    writeTeam(location.file, team);
    return team;
  });
}

export async function failSharedCheckoutMember(input: TeamInput & { clientMutationId: string }): Promise<void> {
  const location = teamLocation(input);
  await withLock(location.lock, async () => {
    const team = readFile(location.file);
    const member = team?.members.find((candidate) => candidate.clientMutationId === input.clientMutationId);
    if (!team || !member) return;
    member.state = 'failed';
    writeTeam(location.file, team);
  });
}

export async function ensureSharedCheckoutTeam(input: TeamInput): Promise<SharedCheckoutTeam> {
  if (!/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(input.parentThreadId)) {
    throw new Error('Shared mode requires a durable orchestrator chat.');
  }
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const checkout = currentCheckout(location.path);
    const existing = await admitExistingTeam(input, location, checkout.branch);
    if (existing) return existing;
    const team: SharedCheckoutTeam = {
      id: location.id,
      path: location.path,
      branch: checkout.branch,
      baseHead: checkout.head,
      parentThreadId: input.parentThreadId,
      createdAt: new Date().toISOString(),
      initialChangedPaths: changedPaths(location.path),
      initialChangedFingerprints: changedFingerprints(location.path, changedPaths(location.path)),
      members: [],
    };
    writeTeam(location.file, team);
    return team;
  });
}

export async function recordSharedCheckoutMember(input: TeamInput & {
  parentTurnId?: string;
  surfaceId: string;
  runtime: string;
  taskName: string;
  clientMutationId: string;
}): Promise<SharedCheckoutTeam> {
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const team = readFile(location.file);
    if (!team) throw new Error('Shared checkout team was not created.');
    assertOwner(team, input, location.path, currentCheckout(location.path).branch);
    const existing = team.members.find((member) => member.clientMutationId === input.clientMutationId);
    if (!existing) throw new Error('Shared worker has no path reservation.');
    if (existing.surfaceId && existing.surfaceId !== input.surfaceId) throw new Error('Shared worker mutation was reused for another surface.');
    existing.surfaceId = input.surfaceId;
    if (input.parentTurnId && !existing.parentTurnId) existing.parentTurnId = input.parentTurnId;
    existing.state = 'running';
    delete existing.settledOutcome;
    writeTeam(location.file, team);
    return team;
  });
}

function holdsPathClaim(member: SharedCheckoutMember): boolean {
  return member.state !== 'failed' || Boolean(member.surfaceId && !member.settledOutcome);
}

/** Refresh from the owned index only. Unknown or contradictory evidence holds ownership. */
async function refreshMembers(team: SharedCheckoutTeam): Promise<string[]> {
  const owned = await import('@/lib/runtimes/shared/owned-session-index');
  const blockers: string[] = [];
  for (const member of team.members) {
    const launch = await owned.findOwnedLaunchByMutationId(member.clientMutationId);
    // A rejected foreign mutation never launched a member in this checkout.
    if (member.state === 'failed' && !member.surfaceId && (!launch || launch.cwd !== team.path)) continue;
    if (!launch || (member.surfaceId && launch.surfaceId !== member.surfaceId) || launch.cwd !== team.path) {
      delete member.settledOutcome;
      blockers.push(`Worker ${member.taskName} has no matching owned runtime completion receipt.`);
      continue;
    }
    member.surfaceId = launch.surfaceId;
    const active = await owned.lookupOwnedActiveRunFresh(launch.surfaceId);
    if (launch.outcome === 'running' || active?.pid !== undefined || active?.tmuxSession !== undefined) {
      member.state = 'running';
      delete member.settledOutcome;
      blockers.push(`live worker ${member.taskName} is still active. Wait for it to finish or interrupt it first.`);
      continue;
    }
    member.state = launch.outcome === 'finished' ? 'settled' : 'failed';
    member.settledOutcome = launch.outcome;
  }
  return blockers;
}

async function refreshTeam(file: string, team: SharedCheckoutTeam): Promise<string[]> {
  const before = JSON.stringify(team.members);
  const blockers = await refreshMembers(team);
  if (JSON.stringify(team.members) !== before) writeTeam(file, team);
  return blockers;
}

/** Repair membership even if the checkout branch drifted; never change checkout files. */
export async function settleSharedCheckoutTeam(input: TeamInput): Promise<void> {
  const location = teamLocation(input);
  await withLock(location.lock, async () => {
    const team = readFile(location.file);
    if (team) await refreshTeam(location.file, team);
  });
}

function archiveTeam(file: string, team: SharedCheckoutTeam, receipt: Record<string, unknown>): void {
  const archive = join(file, '..', 'archive');
  mkdirSync(archive, { recursive: true });
  // Keep the active receipt until its complete archive is written.
  // Exclusive creation also prevents two releases in one millisecond colliding.
  let suffix = Date.now();
  for (;;) {
    try {
      writeFileSync(join(archive, `${team.id}-${suffix}.json`), `${JSON.stringify({ ...team, ...receipt }, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      suffix += 1;
    }
  }
}

/** Called inside the checkout receipt lock before either admission entry point. */
async function admitExistingTeam(input: TeamInput, location: ReturnType<typeof teamLocation>, branch: string): Promise<SharedCheckoutTeam | null> {
  const team = readFile(location.file);
  if (!team) return null;
  assertOwner(team, { ...input, parentThreadId: team.parentThreadId }, location.path, branch);
  const blockers = await refreshTeam(location.file, team);
  if (team.parentThreadId === input.parentThreadId) return team;
  const refusal = `This checkout is owned by orchestrator ${team.parentThreadId}: `;
  if (blockers.length) throw new Error(`${refusal}${blockers.join(' ')}`);
  const status = inspectSharedCheckoutTeam({ ...input, parentThreadId: team.parentThreadId });
  if (!status) throw new Error(`${refusal}ownership inspection is unavailable.`);
  const uncommitted = [...new Set([...status.newPaths, ...status.baselineDrift, ...status.baselineUnverifiable])].sort();
  if (uncommitted.length) throw new Error(`${refusal}uncommitted paths ${uncommitted.join(', ')}.`);
  archiveTeam(location.file, team, { releasedAt: new Date().toISOString(), releasedBy: input.parentThreadId,
    reason: 'settled-clean-takeover', reviewedHead: status.currentHead, committedPaths: status.committedPaths });
  await rm(location.file);
  return null;
}

async function assertMembersSettled(team: SharedCheckoutTeam, file: string): Promise<void> {
  const blockers = await refreshTeam(file, team);
  if (blockers.length) throw new Error(blockers.join(' '));
}

/** Acknowledge only an exact, explicitly reviewed checkout state. No Git or
 * source mutation, and the original baseline remains the provenance authority. */
export async function reconcileSharedCheckoutTeam(input: TeamInput & {
  reviewId: string;
  reviewedHead: string;
  acknowledgedPaths: string[];
  reviewSummary: string;
}): Promise<SharedCheckoutReconciliation> {
  if (!input.reviewSummary.trim()) throw new Error('Reconciliation requires an explicit review summary.');
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const team = readFile(location.file);
    if (!team) throw new Error('There is no active Shared team in this checkout.');
    assertOwner(team, input, location.path, currentCheckout(location.path).branch);
    await assertMembersSettled(team, location.file);
    const status = inspectSharedCheckoutTeam(input);
    if (!status || status.review.id !== input.reviewId || status.review.head !== input.reviewedHead) {
      throw new Error('Checkout review is stale. Inspect and review the current changes before reconciling.');
    }
    if (status.unsupportedReviewPaths.length) {
      throw new Error(`Nested repositories or special files need separate review: ${status.unsupportedReviewPaths.join(', ')}`);
    }
    const acknowledged = [...input.acknowledgedPaths].sort();
    if (JSON.stringify(acknowledged) !== JSON.stringify(status.review.paths)) {
      throw new Error('Acknowledge every exact path in the reviewed checkout, without omissions or extra paths.');
    }
    const workerEdits = status.newPaths.filter((path) => !status.outsideClaims.includes(path));
    if (workerEdits.length) throw new Error(`Team edits are still uncommitted: ${workerEdits.join(', ')}`);
    if (status.reconciliation) return status.reconciliation;
    if (!status.outsideClaims.length && !status.baselineDrift.length && !status.baselineUnverifiable.length) {
      throw new Error('No independent checkout changes need reconciliation. Use Finish after reviewing the team.');
    }
    const receipt: SharedCheckoutReconciliation = { ...status.review,
      reviewedAt: new Date().toISOString(), reviewSummary: input.reviewSummary.trim() };
    team.reconciliations = [...(team.reconciliations ?? []), receipt];
    writeTeam(location.file, team);
    return receipt;
  });
}

/** Release checkout ownership only after every owned worker has settled and
 * the orchestrator has committed/reviewed the team's scoped work. */
export async function finishSharedCheckoutTeam(input: TeamInput & {
  reviewSummary: string;
  verification: string;
}): Promise<{ team: SharedCheckoutTeam; reviewedHead: string; committedPaths: string[] }> {
  if (!input.reviewSummary.trim() || !input.verification.trim()) {
    throw new Error('Finishing a Shared team requires a review summary and verification receipt.');
  }
  const location = teamLocation(input);
  return withLock(location.lock, async () => {
    const team = readFile(location.file);
    if (!team) throw new Error('There is no active Shared team in this checkout.');
    const checkout = currentCheckout(location.path);
    assertOwner(team, input, location.path, checkout.branch);
    await assertMembersSettled(team, location.file);
    const status = inspectSharedCheckoutTeam(input);
    if (!status) throw new Error('Shared team review state disappeared.');
    if (status.unsupportedReviewPaths.length) {
      throw new Error(`Nested repositories or special files need separate review: ${status.unsupportedReviewPaths.join(', ')}`);
    }
    if (status.outsideClaims.length > 0 && !status.reconciliation) {
      throw new Error(`Changes outside worker scopes need review: ${status.outsideClaims.join(', ')}`);
    }
    if (status.baselineUnverifiable.length > 0 && !status.reconciliation) {
      throw new Error(`Pre-existing operator edit fingerprints cannot be verified: ${status.baselineUnverifiable.join(', ')}. Review the original baseline before finishing.`);
    }
    if (status.baselineDrift.length > 0 && !status.reconciliation) {
      throw new Error(`Pre-existing operator edits changed during this team: ${status.baselineDrift.join(', ')}`);
    }
    const uncommitted = status.newPaths.filter((path) => !status.reconciliation || !status.outsideClaims.includes(path));
    if (uncommitted.length > 0) {
      throw new Error(`Team edits are still uncommitted: ${uncommitted.join(', ')}`);
    }
    archiveTeam(location.file, team, {
      finishedAt: new Date().toISOString(),
      releasedBy: input.parentThreadId,
      reason: 'finished',
      reviewedHead: status.currentHead,
      committedPaths: status.committedPaths,
      reviewSummary: input.reviewSummary.trim(),
      verification: input.verification.trim(),
    });
    await rm(location.file);
    return { team, reviewedHead: status.currentHead, committedPaths: status.committedPaths };
  });
}
