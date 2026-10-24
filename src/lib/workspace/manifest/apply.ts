import { childEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';

import { recordLaneEvent } from '@/lib/lane/events';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { runRepoSetupCommand } from '@/lib/workspace/repo-setup';
import {
  beginWorkspaceManifestRun,
  recordWorkspaceServiceOutcome,
  finishWorkspaceManifestRun,
  settleWorkspaceManifestRun,
  updateWorkspaceManifestRun,
  type WorkspaceManifestHealthReceipt,
  type WorkspaceManifestLifecycleRun,
  type WorkspaceManifestServiceReceipt,
  type WorkspaceManifestSetupReceipt,
  type WorkspaceManifestState,
} from './lifecycle';
import { startWorkspaceServices, activateWorkspaceServices, waitWorkspaceServices, stopWorkspaceServices, validateWorkspaceServicePaths, monitorWorkspaceServices, assertWorkspaceManifestSafe, readWorkspaceServiceState } from './services';
import { loadWorkspaceManifestSource } from './loader';
import {
  findWorkspaceManifestApproval,
  resolveWorkspaceManifestExecution,
} from './policy';
import { allocateWorkspaceServicePorts } from './port-leases';
import type {
  WorkspaceManifest,
} from './types';

const DEFAULT_SETUP_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
let setupTimeoutOverrideForTest: number | null = null;

export type {
  WorkspaceManifestHealthReceipt,
  WorkspaceManifestServiceReceipt,
  WorkspaceManifestSetupReceipt,
} from './lifecycle';

export interface WorkspaceManifestApplyResult {
  ports: Record<string, number>;
  preview?: string;
  receipts: {
    setup: WorkspaceManifestSetupReceipt[];
    services: WorkspaceManifestServiceReceipt[];
    completedAt: string;
  };
}

type ApplyStep = 'load' | 'policy' | 'ports' | 'services' | 'preview' | `setup:${number}`;

class WorkspaceManifestSetupTimeoutError extends Error {
  constructor(
    readonly step: `setup:${number}`,
    readonly commandId: string,
    timeoutMs: number,
  ) {
    super(`Workspace manifest ${step} (${commandId}) timed out after ${timeoutMs}ms.`);
    this.name = 'WorkspaceManifestSetupTimeoutError';
  }
}

class WorkspaceManifestCancelledError extends Error {
  constructor() {
    super('Workspace manifest cancelled because its lane became terminal.');
    this.name = 'WorkspaceManifestCancelledError';
  }
}

export function setWorkspaceManifestSetupTimeoutForTest(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('Workspace manifest setup timeout must be a positive number.');
  }
  setupTimeoutOverrideForTest = timeoutMs;
}

function commandId(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setupShell(command: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return { command: '/bin/sh', args: ['-lc', command] };
}

function portEnvironment(
  manifest: WorkspaceManifest,
  ports: Record<string, number>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  };
  for (const service of manifest.services ?? []) {
    const name = service.port?.env;
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Service ${service.name} has an invalid port environment name.`);
    }
    const value = String(ports[service.name]);
    if (environment[name] !== undefined && environment[name] !== value) {
      throw new Error(`Workspace services assign different ports to environment variable ${name}.`);
    }
    environment[name] = value;
  }
  return environment;
}

function resolveTemplate(
  template: string,
  ports: Record<string, number>,
  defaultPort?: number,
): string {
  let resolved = template.replaceAll('{{port}}', () => {
    if (defaultPort === undefined) throw new Error('Preview {{port}} has no allocated service port.');
    return String(defaultPort);
  });
  resolved = resolved.replace(/\{\{service:([^}]+)\}\}/g, (_match, serviceName: string) => {
    const port = ports[serviceName];
    if (port === undefined) {
      throw new Error(`Template references service ${JSON.stringify(serviceName)} without an allocated port.`);
    }
    return String(port);
  });
  if (/\{\{[^}]+\}\}/.test(resolved)) {
    throw new Error(`Template contains an unsupported placeholder: ${resolved}.`);
  }
  return resolved;
}

async function httpHealth(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // Health is status-based; release unused bodies without overriding that status.
    await response.body?.cancel().catch(() => undefined);
    return response.ok
      ? { ok: true }
      : { ok: false, error: `HTTP health probe returned ${response.status}.` };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

export async function probeHttpHealth(
  url: string,
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<WorkspaceManifestHealthReceipt> {
  const startedAt = Date.now();
  const result = await httpHealth(url, timeoutMs, signal);
  return {
    kind: 'http',
    target: url,
    ok: result.ok,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function applyLoadedManifest(input: {
  manifest: WorkspaceManifest;
  worktreePath: string;
  packetId: string;
  laneId: string;
  lifecycle: WorkspaceManifestLifecycleRun;
  setupTimeoutMs: number;
  setStep: (step: ApplyStep, commandId?: string) => Promise<void>;
}): Promise<WorkspaceManifestApplyResult> {
  await input.setStep('ports');
  const services = input.manifest.services ?? [];
  const ports = await allocateWorkspaceServicePorts({
    packetId: input.packetId,
    laneId: input.laneId,
    services: services.flatMap((service) => service.port
      ? [{ name: service.name, preferred: service.port.preferred }]
      : []),
  });
  await updateWorkspaceManifestRun(input.lifecycle, (receipt) => ({ ...receipt, ports }));
  const allocatedEnvironment = portEnvironment(input.manifest, ports);
  await validateWorkspaceServicePaths(input.manifest, input.worktreePath);
  await startWorkspaceServices({ ...input, environment: allocatedEnvironment, ports, resolveTemplate: (value, port) => resolveTemplate(value, ports, port), onGeneration: async generation => {
    input.lifecycle.serviceGeneration = generation;
    await updateWorkspaceManifestRun(input.lifecycle, receipt => ({ ...receipt, serviceGeneration: generation }));
  } });
  const setupEnvironment = childEnvironment({ inherit: false, inject: false, env: {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...allocatedEnvironment,
  } });
  const setupReceipts: WorkspaceManifestSetupReceipt[] = [];
  for (const [index, setupCommand] of (input.manifest.setup ?? []).entries()) {
    if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    const step = `setup:${index + 1}` as const;
    const setupCommandId = commandId(setupCommand);
    await input.setStep(step, setupCommandId);
    const startedAt = Date.now();
    const shell = setupShell(setupCommand);
    const timeoutController = new AbortController();
    const timeoutError = new WorkspaceManifestSetupTimeoutError(
      step,
      setupCommandId,
      input.setupTimeoutMs,
    );
    const timer = setTimeout(() => timeoutController.abort(timeoutError), input.setupTimeoutMs);
    timer.unref?.();
    try {
      await runRepoSetupCommand({
        ...shell,
        cwd: input.worktreePath,
        timeoutMs: input.setupTimeoutMs,
        maxOutputBytes: input.manifest.limits?.outputLimitBytes,
        env: setupEnvironment,
        signal: AbortSignal.any([input.lifecycle.signal, timeoutController.signal]),
      });
    } catch (error) {
      if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
      if (timeoutController.signal.aborted) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    const setupReceipt: WorkspaceManifestSetupReceipt = {
      index,
      commandId: setupCommandId,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
    setupReceipts.push(setupReceipt);
    await updateWorkspaceManifestRun(input.lifecycle, (receipt) => {
      const next = { ...receipt, setup: [...receipt.setup, setupReceipt] };
      delete next.commandId;
      return next;
    });
  }
  const serviceReceipts: WorkspaceManifestServiceReceipt[] = [];
  if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
  await input.setStep('services');
  if (services.length || input.manifest.teardown?.length) {
    if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    await activateWorkspaceServices(input);
    const state = await waitWorkspaceServices(input, input.lifecycle.signal);
    serviceReceipts.push(...state.services);
    await updateWorkspaceManifestRun(input.lifecycle, receipt => ({ ...receipt, services: state.services }));
    if (state.state !== 'ready') throw new Error(state.error ?? 'Workspace services stopped before readiness.');
  }
  await input.setStep('preview');
  const firstPort = services.map((service) => ports[service.name]).find((port) => port !== undefined);
  const preview = input.manifest.preview
    ? resolveTemplate(input.manifest.preview.url, ports, firstPort)
    : undefined;
  return {
    ports,
    ...(preview ? { preview } : {}),
    receipts: {
      setup: setupReceipts,
      services: serviceReceipts,
      completedAt: new Date().toISOString(),
    },
  };
}

function recordEventSafely(
  laneId: string,
  verb: 'workspace_manifest_applied' | 'workspace_manifest_failed' | 'workspace_manifest_skipped',
  payload: Record<string, unknown>,
): void {
  try {
    recordLaneEvent(laneId, verb, 'system', payload);
  } catch (error) {
    console.warn(`[workspace-manifest] Could not record ${verb} for ${laneId}: ${formatError(error)}`);
  }
}

export async function applyWorkspaceManifest(input: {
  repoPath: string;
  worktreePath: string;
  packetId: string;
  laneId: string;
}): Promise<WorkspaceManifestApplyResult | null> {
  const startedAt = Date.now();
  let step: ApplyStep = 'load';
  let lifecycle: WorkspaceManifestLifecycleRun | null = null;
  try {
    const loaded = await loadWorkspaceManifestSource(input.worktreePath);
    if (!loaded) return null;
    assertWorkspaceManifestSafe(loaded.manifest);
    step = 'policy';
    const policy = (await getOperatorDefaults()).values.workspaceManifestPolicy;
    const decision = await resolveWorkspaceManifestExecution({
      repoPath: input.repoPath,
      manifestSource: loaded.source,
      policy,
    });
    if (!decision.allowed) {
      const approval = decision.reason === 'awaiting_approval' || decision.reason === 'rejected'
        ? findWorkspaceManifestApproval(input.repoPath, decision.manifestHash)
        : null;
      recordEventSafely(input.laneId, 'workspace_manifest_skipped', {
        policy,
        manifestHash: decision.manifestHash,
        ...(approval ? { approvalId: approval.id } : {}),
        ...(decision.reason === 'rejected' ? { reason: 'rejected' } : {}),
      });
      return null;
    }
    lifecycle = await beginWorkspaceManifestRun({
      worktreePath: path.resolve(input.worktreePath),
      packetId: input.packetId,
      laneId: input.laneId,
      manifestHash: decision.manifestHash,
    });
    const result = await applyLoadedManifest({
      manifest: loaded.manifest,
      worktreePath: path.resolve(input.worktreePath),
      packetId: input.packetId,
      laneId: input.laneId,
      lifecycle,
      setupTimeoutMs: setupTimeoutOverrideForTest ?? loaded.manifest.limits?.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      setStep: async (next, setupCommandId) => {
        step = next;
        await updateWorkspaceManifestRun(lifecycle!, (receipt) => {
          const updated = { ...receipt, step: next };
          if (setupCommandId) updated.commandId = setupCommandId;
          else delete updated.commandId;
          return updated;
        });
      },
    });
    if (lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    const previewOpen = loaded.manifest.preview?.autoOpen && result.preview
      ? await (await import('./preview-open')).openWorkspacePreview(result.preview) : undefined;
    if (lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    if (loaded.manifest.services?.length) {
      const current = await readWorkspaceServiceState({ ...input, serviceGeneration: lifecycle.serviceGeneration });
      if (current?.state !== 'ready') throw new Error(current?.error ?? 'Workspace services are no longer ready.');
    }
    const settlement = await settleWorkspaceManifestRun(lifecycle, { state: 'completed' });
    if (settlement.changed) {
      const completedRun = lifecycle;
      if (loaded.manifest.services?.length) monitorWorkspaceServices({ ...input, serviceGeneration: lifecycle.serviceGeneration }, async state => recordWorkspaceServiceOutcome(completedRun, state.state === 'failed'));
      recordEventSafely(input.laneId, 'workspace_manifest_applied', {
        services: Object.entries(result.ports).map(([name, port]) => ({ name, port })),
        ...(result.preview ? { preview: result.preview } : {}),
        ...(previewOpen ? { previewOpen } : {}),
        durationMs: Date.now() - startedAt,
        state: 'completed',
      });
      return result;
    }
    return null;
  } catch (error) {
    // Failed setup/provisioning owns settlement too; do not release routes before services stop.
    let cleanupError: unknown;
    if (lifecycle) {
      try { await stopWorkspaceServices({ ...input, serviceGeneration: lifecycle.serviceGeneration }); }
      catch (failure) { cleanupError = failure; }
    }
    const message = formatError(cleanupError ?? error);
    const state: Exclude<WorkspaceManifestState, 'running' | 'completed' | 'crashed'> =
      error instanceof WorkspaceManifestSetupTimeoutError
        ? 'timed_out'
        : error instanceof WorkspaceManifestCancelledError || lifecycle?.signal.aborted
          ? 'cancelled'
          : 'failed';
    const commandId = error instanceof WorkspaceManifestSetupTimeoutError
      ? error.commandId
      : undefined;
    console.warn(
      `[workspace-manifest] Apply failed for packet ${input.packetId} in ${path.resolve(input.repoPath)} at ${step}: ${message}`,
    );
    const settlement = lifecycle
      ? await settleWorkspaceManifestRun(lifecycle, { state, step, commandId, error: message })
      : { receipt: null, changed: true };
    if (lifecycle) {
      await recordWorkspaceServiceOutcome(lifecycle);
      const { releaseWorkspacePortLeases } = await import('./port-leases');
      if (settlement.changed && !cleanupError) await releaseWorkspacePortLeases(input);
    }
    if (settlement.changed) {
      recordEventSafely(input.laneId, 'workspace_manifest_failed', {
        step,
        ...(commandId ? { commandId } : {}),
        error: message,
        state,
      });
    }
    if (cleanupError) throw cleanupError;
    return null;
  } finally {
    if (lifecycle) finishWorkspaceManifestRun(lifecycle);
  }
}
