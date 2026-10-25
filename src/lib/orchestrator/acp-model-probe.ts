/**
 * Discover an ACP backend's model catalogue without holding a turn open.
 *
 * The catalogue only exists inside a live ACP session (`session/new` returns it
 * as `configOptions`), but the picker has to render BEFORE the operator's first
 * turn. So this does the cheapest possible handshake — spawn, initialize,
 * session/new, read, kill — and persists the result so subsequent opens are
 * instant and survive a restart.
 *
 * Disk cache rather than memory-only because the probe costs a process spawn
 * plus ~5s of agent boot; paying that every time a menu opens is not a menu.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { acpLaunchFingerprint } from '@/lib/acp/local-connection';
import { AcpClient } from '@/lib/acp/client';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';

export interface AcpModelProbeResult {
  models: Array<{ value: string; name?: string }>;
  currentModel: string | null;
  /** Epoch ms of the probe that produced this, for staleness display. */
  probedAt: number;
  source: 'cache' | 'probe';
}

/** Catalogues change when the operator adds a provider — a day is plenty. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;

function cachePath(id: OrchestratorBackendId): string {
  return join(getDataDir(), 'acp-models', `${id}.json`);
}

function readCache(id: OrchestratorBackendId, fingerprint?: string): AcpModelProbeResult | null {
  try {
    const path = cachePath(id);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AcpModelProbeResult> & { fingerprint?: string };
    if (fingerprint && parsed.fingerprint !== fingerprint) return null;
    if (!Array.isArray(parsed.models) || typeof parsed.probedAt !== 'number') return null;
    return {
      models: parsed.models,
      currentModel: typeof parsed.currentModel === 'string' ? parsed.currentModel : null,
      probedAt: parsed.probedAt,
      source: 'cache',
    };
  } catch {
    return null;
  }
}

function writeCache(id: OrchestratorBackendId, result: AcpModelProbeResult, fingerprint: string): void {
  try {
    const path = cachePath(id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...result, fingerprint, source: undefined }, null, 2), 'utf-8');
  } catch {
    // A cache miss is slow, not broken — never fail the probe on a write error.
  }
}

/**
 * Probe (or serve from cache) the model list for an ACP backend.
 * `force` bypasses a fresh cache — the picker's explicit refresh.
 */
export async function probeAcpModels(
  id: OrchestratorBackendId,
  launch: import('@/lib/lane/orchestrator-backends/acp').AcpLaunch,
  repoPath: string,
  options?: { force?: boolean },
): Promise<AcpModelProbeResult> {
  const fingerprint = acpLaunchFingerprint(launch);
  if (!options?.force) {
    const cached = readCache(id, fingerprint);
    if (cached && Date.now() - cached.probedAt < CACHE_TTL_MS) return cached;
  }

  const client = new AcpClient({ runtimeId: id, command: launch.command, args: launch.args, cwd: repoPath, env: launch.env, omitEnv: launch.omitEnv, localEnvironment: launch.localEnvironment });
  const timeout = setTimeout(() => client.kill(), PROBE_TIMEOUT_MS);
  try {
    await client.initialize();
    const created = await client.newSession(repoPath, []);
    const modelOption = created.configOptions.find((o) => o.id === 'model' || o.category === 'model');
    const result: AcpModelProbeResult = {
      models: modelOption?.options ?? [],
      currentModel: modelOption?.currentValue ?? null,
      probedAt: Date.now(),
      source: 'probe',
    };
    // Don't cache an empty catalogue: an agent that failed to enumerate its
    // providers would otherwise pin "no models" for a full day.
    if (result.models.length) writeCache(id, result, fingerprint);
    return result;
  } finally {
    clearTimeout(timeout);
    client.kill();
  }
}

/** The cached catalogue only, without spawning anything. */
export function cachedAcpModels(id: OrchestratorBackendId): AcpModelProbeResult | null {
  return readCache(id);
}
