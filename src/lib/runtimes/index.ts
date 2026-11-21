/**
 * Runtime System — Barrel Export + Auto-Registration
 *
 * Import this module to register all known runtimes.
 * New runtimes: add import + registerRuntime() call below.
 */

export type {
  RuntimeId,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeSessionStatus,
  RuntimeSessionOwnership,
  RuntimeTranscriptEntry,
  TranscriptRole,
  RuntimeChangedFile,
  FileChangeStatus,
  RuntimeActionResult,
  LaunchOptions,
  RuntimeTelemetry,
  RuntimeCapacityCapabilities,
  RuntimeCapacitySource,
  RuntimeCapacityConfidence,
  RuntimeCapacityStatus,
  RuntimeCapacityUnit,
  RuntimeCapacityBucket,
  RuntimeCapacitySnapshot,
  RuntimeIdentityConfigValidation,
  AgentRuntime,
} from './types';

export type { SessionCostData } from './shared/cost-parser-registry';
export { registerCostParser, getCostParser, parseCost } from './shared/cost-parser-registry';

export {
  registerRuntime,
  getRuntime,
  getAllRuntimes,
  getRegisteredRuntimeIds,
  discoverAllSessions,
  routeAction,
} from './registry';

// ── Auto-registration ──
// Import and register all known runtimes.
// To add a new runtime: import it and call registerRuntime().

import { getRemoteRuntimeFlagSync } from '../worker/feature-flags';
import { registerRuntime } from './registry';
import { codexRuntime } from './codex';
import { claudeCodeRuntime } from './claude-code';
import { cloudRuntime } from './cloud-adapter';
import { opencodeRuntime } from './opencode';
import { piRuntime } from './pi';
import { piBuiltinRuntime } from './pi-builtin';
import { hermesRuntime } from './hermes';
import { declarativeWorkerRuntimes, invalidateDeclarativeWorkerFleets } from './declarative-workers';
import { invalidateOwnedCodexFleetCache } from '@/lib/codex/owned';
import { invalidateOwnedClaudeCodeFleetCache } from '@/lib/claude-code/owned';
import { invalidateOwnedOpencodeFleetCache } from '@/lib/opencode/owned';
import { invalidateOwnedPiFleetCache } from '@/lib/pi/owned';
import { invalidateOwnedHermesFleetCache } from '@/lib/hermes/owned';
import './opencode-cost-parser';
import './pi-cost-parser';
import './pi-builtin-cost-parser';
import './hermes-cost-parser';

/**
 * Flush the fleet cache across all owned-session stores. Callers (e.g. the
 * active-workspace switch handler) use this to force the next fleet consumer
 * to rebuild, avoiding the up-to-20s TTL gap.
 */
export function invalidateAllOwnedFleets(): void {
  invalidateOwnedCodexFleetCache();
  invalidateOwnedClaudeCodeFleetCache();
  invalidateOwnedOpencodeFleetCache();
  invalidateOwnedPiFleetCache();
  invalidateOwnedHermesFleetCache();
  invalidateDeclarativeWorkerFleets();
}

registerRuntime(codexRuntime);
registerRuntime(claudeCodeRuntime);
// Wave 2c: OpenCode 2 CLI — multi-provider coding runtime via `opencode2 run
// --format json --model provider/model`. Sessions 'opencode-owned:' with
// 'ses_' prefixed threads. See src/lib/opencode/owned.ts.
registerRuntime(opencodeRuntime);
// Runtime expansion P3: Pi (earendil-works/pi) — `pi --mode rpc` bidirectional
// JSONL with native steer. Sessions 'pi-owned:'. See src/lib/pi/owned.ts.
registerRuntime(piRuntime);
// The Pi SDK bundled with o8 as a packet worker on the managed model route.
// Sessions 'pi-builtin-owned:'. See src/lib/pi-builtin/owned.ts.
registerRuntime(piBuiltinRuntime);
registerRuntime(hermesRuntime);
for (const runtime of declarativeWorkerRuntimes) registerRuntime(runtime);
// #514 — Cloud runtime adapter (self-hosted worker pool).
// Always registered so dispatch UI can target it; actual execution requires
// a worker CLI to connect to /api/cloud/worker-poll with a provisioned key.
registerRuntime(cloudRuntime);

// Remote-customer stays startup-gated for v1. We honor the environment
// override first, then the persisted Workers preference for the next launch.
if (getRemoteRuntimeFlagSync().enabled) {
  // Dynamic import to avoid loading DB-coupled transport code unless enabled.
  const { CustomerWorkerAdapter } = require('./remote/customer-worker-adapter');
  registerRuntime(new CustomerWorkerAdapter());
}
