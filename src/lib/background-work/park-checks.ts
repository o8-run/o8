import 'server-only';

import { readConnectAttachSetting } from '@/lib/connect/attach-settings';
import { getSqlite } from '@/lib/db';
import { hasOutstandingReview, laneBlockingIdle } from '@/lib/lane/outstanding-review';
import { sessions as residentOrchestratorSessions } from '@/lib/lane/orchestrator-resident-process';
import { warmReplLiveProcs } from '@/lib/claude-code/warm-repl-pool';
import { hasPairedMobileDevice } from '@/lib/mobile/device-registry';
import { relayConnectorRunning } from '@/lib/mobile/relay-connector';

import { parkAfterMs, type ParkCheck } from './park-report';

/**
 * Live child processes Node holds a handle to (pipes or not). Each dies or
 * loses its peer when Node stops. Detached children Node has let go of do not
 * count: they survive Node.
 */
function childProcessesHeld(): number {
  return process.getActiveResourcesInfo().filter((type) => type === 'ProcessWrap').length;
}

/** The checks that read the database, settings and module state. ws-server adds its own. */
export function sharedParkChecks(): Record<string, ParkCheck> {
  return {
    lane: () => laneBlockingIdle(),
    review: () => (hasOutstandingReview() ? 'lane in review' : null),
    warmOrchestrator: () => ([...residentOrchestratorSessions.values()]
      .some((session) => session.status !== 'dead' && session.proc) ? 'warm orchestrator process' : null),
    warmPool: () => (warmReplLiveProcs() > 0 ? 'warm pool slot' : null),
    children: () => (childProcessesHeld() > 0 ? 'child process held by Node' : null),
    automationDue: () => (getSqlite().prepare(
      "SELECT 1 FROM automations WHERE enabled = 1 AND trigger_kind = 'cron' AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 1",
    ).get(Date.now() + parkAfterMs()) ? 'automation due soon' : null),
    automationWatch: () => (getSqlite().prepare(
      "SELECT 1 FROM automations WHERE enabled = 1 AND trigger_kind = 'watch' LIMIT 1",
    ).get() ? 'watch automation on' : null),
    cloudJob: () => (getSqlite().prepare(
      "SELECT 1 FROM cloud_jobs WHERE status IN ('pending', 'leased') LIMIT 1",
    ).get() ? 'cloud job waiting' : null),
    machineAttach: () => (readConnectAttachSetting().enabled ? 'machine attach on' : null),
    phone: () => (relayConnectorRunning() ? 'phone relay on' : hasPairedMobileDevice() ? 'phone paired' : null),
  };
}
