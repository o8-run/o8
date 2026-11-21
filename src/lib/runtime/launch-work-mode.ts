/**
 * The durable work mode a launch must run under.
 *
 * Extracted from `runtime/actions.ts` so the launch chokepoint keeps this
 * authorization decision in one small, directly testable place (and so
 * `actions.ts` stays under the 800-line ceiling).
 */

import { resolvePacketWorkMode } from '@/lib/orchestrator/packet-launch-context';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';

// Bundled Pi enforces read-only by offering only `read_file` (#3258).
const READ_ONLY_RUNTIME_IDS = new Set(['codex', 'claude-code', 'pi-builtin']);

export function runtimeSupportsReadOnlyWorkMode(runtime: string): boolean {
  return READ_ONLY_RUNTIME_IDS.has(runtime);
}

/** Either the resolved work mode, or a refusal. Never a silent widening. */
export type LaunchWorkModeResolution =
  | { ok: true; workMode?: WorkerWorkMode }
  | { ok: false; reason: string; retryable: boolean };

function enforceRuntimeSupport(
  runtime: string,
  workMode: WorkerWorkMode | undefined,
): LaunchWorkModeResolution {
  if (workMode !== 'read-only' || runtimeSupportsReadOnlyWorkMode(runtime)) {
    return { ok: true, workMode };
  }
  return {
    ok: false,
    retryable: false,
    reason: `Dispatch refused: runtime ${runtime} cannot enforce read-only worker execution. `
      + 'Use codex, claude-code or pi-builtin.',
  };
}

/**
 * Resolve the work mode a launch must run under. Read from the PERSISTED
 * packet launch context rather than the caller's payload: dispatch, retry,
 * rerun, and quota-fallback all funnel through `launchRuntimeSurface`, and only
 * one of them threads a launch context. Resolving here means a read-only packet
 * stays read-only on every relaunch, including `reset_packet` -> dispatch.
 *
 * FAIL-CLOSED. A packet launch whose durable state cannot be read — the lookup
 * throws, or the packet is not in durable state at all — is REFUSED, not
 * defaulted to write access. Falling back to the caller's payload was the
 * widening hole: a read-only packet whose control-plane read failed would have
 * launched with full write permissions, which is exactly the governance promise
 * this feature exists to keep.
 *
 * Two cases are deliberately NOT refusals, because neither is an unresolved
 * mode: a scratch launch (no packetId — there is no durable packet to consult),
 * and a packet that IS recorded but carries no launch context. `launchContext`
 * is optional metadata that most write packets never set, so refusing those
 * would brick normal dispatch while proving nothing about read-only.
 */
export function resolveLaunchWorkMode(payload: {
  runtime: string;
  packetId?: string;
  workMode?: WorkerWorkMode;
}): LaunchWorkModeResolution {
  const runtime = payload.runtime;
  if (payload.workMode === 'read-only') return enforceRuntimeSupport(runtime, 'read-only');
  const packetId = payload.packetId?.trim();
  if (!packetId) return enforceRuntimeSupport(runtime, payload.workMode);
  let resolved: ReturnType<typeof resolvePacketWorkMode>;
  try {
    resolved = resolvePacketWorkMode(packetId);
  } catch (error) {
    console.error(`[runtime-launch] Unable to resolve work mode for packet ${packetId}:`, error);
    return {
      ok: false,
      retryable: true,
      reason: `Dispatch refused: packet ${packetId} durable state could not be read, so its work `
        + `mode is unknown — ${(error as Error).message}. Refusing rather than launching with `
        + 'write access.',
    };
  }
  if (!resolved.found) {
    return {
      ok: false,
      retryable: true,
      reason: `Dispatch refused: packet ${packetId} was not found in durable state, so its work `
        + 'mode is unknown. Refusing rather than launching with write access.',
    };
  }
  return enforceRuntimeSupport(runtime, resolved.workMode ?? payload.workMode);
}
