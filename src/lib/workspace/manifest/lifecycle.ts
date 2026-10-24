import { stopWorkspaceServices, readWorkspaceServiceState } from './services';
import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { recordLaneEvent } from '@/lib/lane/events';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { releaseWorkspacePortLeases } from './port-leases';

const RECEIPT_VERSION = 1 as const;
const RECEIPT_DIRECTORY = '.o8';
const RECEIPT_FILENAME = 'workspace-manifest-receipt.json';
const ARCHIVE_PREFIX = 'workspace-manifest-receipt.';
const ARCHIVE_LIMIT = 3;
const RESET_HANDOFF_DIRECTORY = 'workspace-manifest-reset-receipts';

export type WorkspaceManifestState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'crashed';

export interface WorkspaceManifestHealthReceipt {
  kind: 'http' | 'tcp';
  target: string;
  ok: boolean;
  durationMs: number;
  checkedAt: string;
  error?: string;
}

export interface WorkspaceManifestSetupReceipt {
  index: number;
  commandId: string;
  durationMs: number;
  completedAt: string;
}

export interface WorkspaceManifestServiceReceipt {
  name: string;
  commandId: string;
  cwd: string;
  port: number | null;
  environment: NodeJS.ProcessEnv;
  health: WorkspaceManifestHealthReceipt | null;
  pid?: number | null;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  restarts?: number;
  outputBytes?: number;
  attempts?: Array<Record<string, unknown>>;
}

export interface WorkspaceManifestReceipt {
  version: typeof RECEIPT_VERSION;
  packetId: string;
  laneId: string;
  manifestHash: string;
  serviceGeneration?: string;
  state: WorkspaceManifestState;
  pid: number;
  startedAt: string;
  finishedAt?: string;
  step?: string;
  commandId?: string;
  ports: Record<string, number>;
  setup: WorkspaceManifestSetupReceipt[];
  services: WorkspaceManifestServiceReceipt[];
  error?: string;
  cleanup?: { state: string };
}

export interface WorkspaceManifestLifecycleRun {
  readonly packetId: string;
  readonly laneId: string;
  readonly worktreePath: string;
  readonly startedAt: string;
  readonly pid: number;
  readonly signal: AbortSignal;
  serviceGeneration?: string;
}

interface ActiveWorkspaceManifestRun extends WorkspaceManifestLifecycleRun {
  controller: AbortController;
  receiptPath: string;
}

export interface WorkspaceManifestSettlement {
  receipt: WorkspaceManifestReceipt | null;
  changed: boolean;
}

const activeRuns = new Map<string, ActiveWorkspaceManifestRun>();
const receiptMutations = new Map<string, Promise<unknown>>();

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isManifestState(value: unknown): value is WorkspaceManifestState {
  return value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'timed_out'
    || value === 'cancelled'
    || value === 'crashed';
}

function validateReceipt(value: unknown): WorkspaceManifestReceipt {
  if (!isRecord(value)
    || value.version !== RECEIPT_VERSION
    || typeof value.packetId !== 'string'
    || !value.packetId
    || typeof value.laneId !== 'string'
    || !value.laneId
    || typeof value.manifestHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.manifestHash)
    || !isManifestState(value.state)
    || !Number.isInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.startedAt !== 'string'
    || !Number.isFinite(Date.parse(value.startedAt))
    || !isRecord(value.ports)
    || !Object.values(value.ports).every((port) => Number.isInteger(port))
    || !Array.isArray(value.setup)
    || !Array.isArray(value.services)) {
    throw new Error('Workspace manifest receipt has an unsupported shape.');
  }
  if (value.finishedAt !== undefined
    && (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt)))) {
    throw new Error('Workspace manifest receipt has an invalid finishedAt value.');
  }
  if (value.step !== undefined && typeof value.step !== 'string') {
    throw new Error('Workspace manifest receipt has an invalid step value.');
  }
  if (value.commandId !== undefined
    && (typeof value.commandId !== 'string' || !/^[a-f0-9]{64}$/.test(value.commandId))) {
    throw new Error('Workspace manifest receipt has an invalid commandId value.');
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new Error('Workspace manifest receipt has an invalid error value.');
  }
  return value as unknown as WorkspaceManifestReceipt;
}

export function workspaceManifestReceiptPath(worktreePath: string): string {
  return path.join(path.resolve(worktreePath), RECEIPT_DIRECTORY, RECEIPT_FILENAME);
}

function stateDirectory(worktreePath: string): string {
  return path.dirname(workspaceManifestReceiptPath(worktreePath));
}

async function ensureStateDirectory(worktreePath: string): Promise<string> {
  const directory = stateDirectory(worktreePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Workspace manifest receipt directory is not an exact directory.');
  }
  return directory;
}

async function readReceiptFile(receiptPath: string): Promise<WorkspaceManifestReceipt | null> {
  try {
    return validateReceipt(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeReceiptFile(
  worktreePath: string,
  receiptPath: string,
  receipt: WorkspaceManifestReceipt,
): Promise<void> {
  const directory = await ensureStateDirectory(worktreePath);
  if (path.dirname(receiptPath) !== directory) {
    throw new Error('Workspace manifest receipt path escaped its state directory.');
  }
  const temporaryPath = path.join(directory, `${path.basename(receiptPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, receiptPath);
    await chmod(receiptPath, 0o600).catch(() => {});
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function writePrivateJsonFile(
  directory: string,
  filePath: string,
  receipt: WorkspaceManifestReceipt,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function withReceiptMutation<T>(
  worktreePath: string,
  operation: (receiptPath: string) => Promise<T>,
): Promise<T> {
  const receiptPath = workspaceManifestReceiptPath(worktreePath);
  const prior = receiptMutations.get(receiptPath) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(() => operation(receiptPath));
  receiptMutations.set(receiptPath, current);
  try {
    return await current;
  } finally {
    if (receiptMutations.get(receiptPath) === current) receiptMutations.delete(receiptPath);
  }
}

function archiveTimestamp(startedAt: string): string {
  return startedAt.replace(/[:]/g, '-');
}

function resetHandoffDirectory(packetId: string): string {
  const packetKey = createHash('sha256').update(packetId).digest('hex');
  return path.join(getDataDir(), RESET_HANDOFF_DIRECTORY, packetKey);
}

async function trimArchives(directory: string): Promise<void> {
  const archives = (await readdir(directory))
    .filter((name) => name.startsWith(ARCHIVE_PREFIX) && name.endsWith('.json'))
    .sort()
    .reverse();
  await Promise.all(archives.slice(ARCHIVE_LIMIT).map((name) => (
    unlink(path.join(directory, name)).catch(() => {})
  )));
}

async function archiveReceipt(
  worktreePath: string,
  receipt: WorkspaceManifestReceipt,
): Promise<string> {
  const directory = await ensureStateDirectory(worktreePath);
  const archivePath = path.join(
    directory,
    `${ARCHIVE_PREFIX}${archiveTimestamp(receipt.startedAt)}.json`,
  );
  await writeReceiptFile(worktreePath, archivePath, receipt);
  await trimArchives(directory);
  return archivePath;
}

async function stageResetArchives(worktreePath: string, packetId: string): Promise<void> {
  const sourceDirectory = stateDirectory(worktreePath);
  const names = (await readdir(sourceDirectory))
    .filter((name) => name.startsWith(ARCHIVE_PREFIX) && name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, ARCHIVE_LIMIT);
  const handoffDirectory = resetHandoffDirectory(packetId);
  for (const name of names) {
    const receipt = await readReceiptFile(path.join(sourceDirectory, name));
    if (!receipt || receipt.packetId !== packetId) continue;
    await writePrivateJsonFile(handoffDirectory, path.join(handoffDirectory, name), receipt);
  }
  await trimArchives(handoffDirectory);
}

async function restoreResetArchives(worktreePath: string, packetId: string): Promise<void> {
  const handoffDirectory = resetHandoffDirectory(packetId);
  let names: string[];
  try {
    names = (await readdir(handoffDirectory))
      .filter((name) => name.startsWith(ARCHIVE_PREFIX) && name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const receipt = await readReceiptFile(path.join(handoffDirectory, name));
    if (!receipt || receipt.packetId !== packetId) continue;
    await writeReceiptFile(worktreePath, path.join(stateDirectory(worktreePath), name), receipt);
  }
  await trimArchives(await ensureStateDirectory(worktreePath));
  await rm(handoffDirectory, { recursive: true, force: true });
}

function sameAttempt(
  receipt: WorkspaceManifestReceipt,
  run: WorkspaceManifestLifecycleRun,
): boolean {
  return receipt.packetId === run.packetId
    && receipt.laneId === run.laneId
    && receipt.startedAt === run.startedAt
    && receipt.pid === run.pid;
}

function findActiveRun(input: {
  worktreePath?: string | null;
  packetId: string;
  laneId: string;
}): ActiveWorkspaceManifestRun | null {
  if (input.worktreePath) {
    const exact = activeRuns.get(workspaceManifestReceiptPath(input.worktreePath));
    if (exact?.packetId === input.packetId && exact.laneId === input.laneId) return exact;
  }
  return [...activeRuns.values()].find((run) => (
    run.packetId === input.packetId && run.laneId === input.laneId
  )) ?? null;
}

function recordFailureSafely(receipt: WorkspaceManifestReceipt): void {
  try {
    recordLaneEvent(receipt.laneId, 'workspace_manifest_failed', 'system', {
      ...(receipt.step ? { step: receipt.step } : {}),
      ...(receipt.commandId ? { commandId: receipt.commandId } : {}),
      error: receipt.error ?? `Workspace manifest settled as ${receipt.state}.`,
      state: receipt.state,
    });
  } catch (error) {
    console.warn(
      `[workspace-manifest] Could not record workspace_manifest_failed for ${receipt.laneId}: ${formatError(error)}`,
    );
  }
}

async function settleReceiptDirectly(input: {
  worktreePath: string;
  packetId: string;
  laneId: string;
  state: Exclude<WorkspaceManifestState, 'running' | 'completed'>;
  error: string;
}): Promise<WorkspaceManifestSettlement> {
  return withReceiptMutation(input.worktreePath, async (receiptPath) => {
    const receipt = await readReceiptFile(receiptPath);
    if (!receipt
      || receipt.state !== 'running'
      || receipt.packetId !== input.packetId
      || receipt.laneId !== input.laneId) {
      return { receipt, changed: false };
    }
    const settled: WorkspaceManifestReceipt = {
      ...receipt,
      state: input.state,
      finishedAt: new Date().toISOString(),
      error: input.error,
    };
    await writeReceiptFile(input.worktreePath, receiptPath, settled);
    return { receipt: settled, changed: true };
  });
}

export async function readWorkspaceManifestReceipt(
  worktreePath: string,
): Promise<WorkspaceManifestReceipt | null> {
  return readReceiptFile(workspaceManifestReceiptPath(worktreePath));
}

export async function beginWorkspaceManifestRun(input: {
  worktreePath: string;
  packetId: string;
  laneId: string;
  manifestHash: string;
}): Promise<WorkspaceManifestLifecycleRun> {
  const worktreePath = path.resolve(input.worktreePath);
  if (activeRuns.has(workspaceManifestReceiptPath(worktreePath))) throw new Error('Workspace manifest setup is already running.');
  const prior = await readWorkspaceManifestReceipt(worktreePath);
  if (prior) await stopWorkspaceServices({ worktreePath, packetId: prior.packetId, laneId: prior.laneId, serviceGeneration: prior.serviceGeneration });
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const active: ActiveWorkspaceManifestRun = {
    packetId: input.packetId,
    laneId: input.laneId,
    worktreePath,
    startedAt,
    pid: process.pid,
    signal: controller.signal,
    controller,
    receiptPath: workspaceManifestReceiptPath(worktreePath),
  };
  let crashed: WorkspaceManifestReceipt | null = null;

  await withReceiptMutation(worktreePath, async (receiptPath) => {
    if (activeRuns.has(receiptPath)) {
      throw new Error(`Workspace manifest setup is already running for ${worktreePath}.`);
    }
    await restoreResetArchives(worktreePath, input.packetId);
    let previous = await readReceiptFile(receiptPath);
    if (previous?.state === 'running') {
      if (previous.pid === process.pid) {
        throw new Error('Workspace manifest receipt belongs to an unsettled run in this process.');
      }
      const owner = await probeMetadataLockProcessIdentity(previous.pid);
      if (owner.state !== 'absent') {
        throw new Error(
          owner.state === 'live'
            ? `Workspace manifest setup is still owned by process ${previous.pid}.`
            : `Workspace manifest setup owner ${previous.pid} could not be verified: ${owner.detail}`,
        );
      }
      previous = {
        ...previous,
        state: 'crashed',
        finishedAt: new Date().toISOString(),
        error: `Workspace manifest owner process ${previous.pid} exited before setup settled.`,
      };
      await writeReceiptFile(worktreePath, receiptPath, previous);
      crashed = previous;
    }
    if (previous) {
      await releaseWorkspacePortLeases({
        packetId: previous.packetId,
        laneId: previous.laneId,
      });
      await archiveReceipt(worktreePath, previous);
    }
    const running: WorkspaceManifestReceipt = {
      version: RECEIPT_VERSION,
      packetId: input.packetId,
      laneId: input.laneId,
      manifestHash: input.manifestHash,
      state: 'running',
      pid: process.pid,
      startedAt,
      ports: {},
      setup: [],
      services: [],
    };
    await writeReceiptFile(worktreePath, receiptPath, running);
    activeRuns.set(receiptPath, active);
  });

  if (crashed) recordFailureSafely(crashed);
  return active;
}

export async function updateWorkspaceManifestRun(
  run: WorkspaceManifestLifecycleRun,
  update: (receipt: WorkspaceManifestReceipt) => WorkspaceManifestReceipt,
): Promise<WorkspaceManifestReceipt | null> {
  return withReceiptMutation(run.worktreePath, async (receiptPath) => {
    const receipt = await readReceiptFile(receiptPath);
    if (!receipt || receipt.state !== 'running' || !sameAttempt(receipt, run)) return receipt;
    const next = update(receipt);
    await writeReceiptFile(run.worktreePath, receiptPath, next);
    return next;
  });
}

export async function settleWorkspaceManifestRun(
  run: WorkspaceManifestLifecycleRun,
  input: {
    state: Exclude<WorkspaceManifestState, 'running' | 'crashed'>;
    step?: string;
    commandId?: string;
    error?: string;
  },
): Promise<WorkspaceManifestSettlement> {
  return withReceiptMutation(run.worktreePath, async (receiptPath) => {
    const receipt = await readReceiptFile(receiptPath);
    if (!receipt || receipt.state !== 'running' || !sameAttempt(receipt, run)) {
      return { receipt, changed: false };
    }
    const settled: WorkspaceManifestReceipt = {
      ...receipt,
      state: input.state,
      finishedAt: new Date().toISOString(),
      ...(input.step ? { step: input.step } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    if (input.state === 'completed') {
      delete settled.step;
      delete settled.commandId;
      delete settled.error;
    }
    await writeReceiptFile(run.worktreePath, receiptPath, settled);
    return { receipt: settled, changed: true };
  });
}

export async function recordWorkspaceServiceOutcome(run: WorkspaceManifestLifecycleRun, failed = false): Promise<void> {
  const state = await readWorkspaceServiceState(run);
  if (!state || state.generation !== run.serviceGeneration) return;
  await withReceiptMutation(run.worktreePath, async receiptPath => {
    const receipt = await readReceiptFile(receiptPath);
    if (!receipt || !sameAttempt(receipt, run)) return;
    const updated: WorkspaceManifestReceipt = { ...receipt, services: state.services, ...(state.teardown ? { cleanup: state.teardown } : {}) };
    if (failed && receipt.state === 'completed') {
      updated.state = 'failed';
      updated.error = state.error ?? 'Workspace service exited unexpectedly.';
      updated.finishedAt = new Date().toISOString();
      recordFailureSafely(updated);
    }
    await writeReceiptFile(run.worktreePath, receiptPath, updated);
    if (state.state === 'stopped' && receipt.state === 'completed' && !receipt.cleanup) recordLaneEvent(run.laneId, 'workspace_manifest_services_stopped', 'system', { generation: state.generation, state: 'stopped' });
    if ((failed || state.state === 'stopped') && !state.cleanupUnconfirmed && state.teardown?.state !== 'failed') await releaseWorkspacePortLeases(run);
  });
}

export function finishWorkspaceManifestRun(run: WorkspaceManifestLifecycleRun): void {
  const receiptPath = workspaceManifestReceiptPath(run.worktreePath);
  const active = activeRuns.get(receiptPath);
  if (active
    && active.packetId === run.packetId
    && active.laneId === run.laneId
    && active.pid === run.pid
    && active.startedAt === run.startedAt) {
    activeRuns.delete(receiptPath);
  }
}

async function settleOwnedServices(input: { worktreePath: string; packetId: string; laneId: string }): Promise<void> {
  const receipt = await readWorkspaceManifestReceipt(input.worktreePath);
  const run = receipt?.packetId === input.packetId && receipt.laneId === input.laneId
    ? { ...receipt, worktreePath: input.worktreePath, signal: new AbortController().signal } : null;
  try { await stopWorkspaceServices({ ...input, serviceGeneration: run?.serviceGeneration }); }
  catch (error) {
    if (run) await recordWorkspaceServiceOutcome(run, true);
    throw error;
  }
  if (run) await recordWorkspaceServiceOutcome(run);
}

export function settleTerminalWorkspaceManifest(input: {
  worktreePath?: string | null;
  packetId: string;
  laneId: string;
}): Promise<void> {
  const active = findActiveRun(input);
  active?.controller.abort(new Error('Workspace manifest cancelled because its lane became terminal.'));
  const worktreePath = active?.worktreePath ?? input.worktreePath;
  return (async () => {
    if (worktreePath) await settleOwnedServices({ ...input, worktreePath });
    let settlement: WorkspaceManifestSettlement = { receipt: null, changed: false };
    if (active) {
      settlement = await settleWorkspaceManifestRun(active, {
        state: 'cancelled',
        error: 'Workspace manifest cancelled because its lane became terminal.',
      });
    } else if (worktreePath) {
      settlement = await settleReceiptDirectly({
        worktreePath,
        packetId: input.packetId,
        laneId: input.laneId,
        state: 'cancelled',
        error: 'Workspace manifest cancelled because its lane became terminal.',
      });
    }
    if (settlement.changed && settlement.receipt) recordFailureSafely(settlement.receipt);
    await releaseWorkspacePortLeases({ packetId: input.packetId, laneId: input.laneId });
  })();
}

export function archiveWorkspaceManifestRunForReset(input: {
  worktreePath?: string | null;
  packetId: string;
  laneId: string;
}): Promise<string | null> {
  const active = findActiveRun(input);
  active?.controller.abort(new Error('Workspace manifest cancelled by packet reset.'));
  const worktreePath = active?.worktreePath ?? input.worktreePath;
  return (async () => {
    if (worktreePath) await settleOwnedServices({ ...input, worktreePath });
    await releaseWorkspacePortLeases({ packetId: input.packetId, laneId: input.laneId });
    if (!worktreePath) {
      return null;
    }
    return withReceiptMutation(worktreePath, async (receiptPath) => {
      let receipt = await readReceiptFile(receiptPath);
      if (receipt
        && receipt.packetId === input.packetId
        && receipt.laneId === input.laneId
        && receipt.state === 'running') {
        const owner = receipt.pid === process.pid
          ? null
          : await probeMetadataLockProcessIdentity(receipt.pid);
        const crashed = owner?.state === 'absent';
        receipt = {
          ...receipt,
          state: crashed ? 'crashed' : 'cancelled',
          finishedAt: new Date().toISOString(),
          error: crashed
            ? `Workspace manifest owner process ${receipt.pid} exited before packet reset.`
            : 'Workspace manifest cancelled by packet reset.',
        };
        await writeReceiptFile(worktreePath, receiptPath, receipt);
        recordFailureSafely(receipt);
      }
      if (!receipt
        || receipt.packetId !== input.packetId
        || receipt.laneId !== input.laneId) return null;
      const archived = await archiveReceipt(worktreePath, receipt);
      await stageResetArchives(worktreePath, input.packetId);
      await unlink(receiptPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      activeRuns.delete(receiptPath);
      return archived;
    });
  })();
}
