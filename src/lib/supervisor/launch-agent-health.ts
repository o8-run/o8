import { execFile } from '@/lib/providers/child-process';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  LAUNCH_AGENT_HEALTHY_UPTIME_MS,
  launchAgentFailureCount,
  OPERATOR_MCP_LAUNCH_AGENT_LABEL,
  readLaunchAgentCounters,
  readLaunchAgentStarts,
  type LaunchAgentCounterFile,
} from '@/lib/mcp/launch-agent-crash-counter';
import { enqueueInboxItem, listRecordedInboxItems, resolveInboxItem, type SupervisorInboxItem } from '@/lib/supervisor/inbox';

const ALERT_AFTER_FAILURES = 3;
const lastSurfacedStarts = new Map<string, number>();
const MAX_OBSERVATION_GAP_MS = 2 * 60_000;
const activeStatuses = new Set(['pending', 'healing', 'human_required', 'escalated']);
type Incident = Pick<SupervisorInboxItem, 'id' | 'status' | 'payload'>;
interface Observation {
  pid: number;
  runs: number;
  sinceMs: number;
  lastObservedMs: number;
  latestStartAtMs: number | null;
  initialStartsMs: number[];
}
// Restarting the supervisor deliberately requires a fresh observation interval.
const observations = new Map<string, Observation>();
let checkInFlight: Promise<LaunchAgentCrashLoopAlert[]> | null = null;

async function runningProcess(label: string): Promise<{ pid: number; runs: number } | null> {
  if (process.platform !== 'darwin' || !process.getuid || !/^[a-zA-Z0-9._-]+$/.test(label)) return null;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile('launchctl', ['print', `gui/${process.getuid!()}/${label}`], {
        encoding: 'utf8', timeout: 2_000, maxBuffer: 128 * 1024,
      }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
    });
    // Only the root service's fields count, never those of a nested resource.
    if (!/^\tstate = running\s*$/m.test(output)) return null;
    const pid = Number(/^\tpid = (\d+)\s*$/m.exec(output)?.[1]);
    const runs = Number(/^\truns = (\d+)\s*$/m.exec(output)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(runs) && runs > 0 ? { pid, runs } : null;
  } catch {
    return null;
  }
}

function recoveredThroughMs(item: Incident): number {
  if (item.status !== 'resolved') return 0;
  const resolution = item.payload.autoResolution;
  if (!resolution || typeof resolution !== 'object' || !('event' in resolution)
    || resolution.event !== 'launch_agent_recovered' || !('evidence' in resolution)) return 0;
  const evidence = resolution.evidence;
  if (!evidence || typeof evidence !== 'object' || !('observedThroughMs' in evidence)) return 0;
  return typeof evidence.observedThroughMs === 'number' ? evidence.observedThroughMs : 0;
}

async function reconcileRecovery(counters: LaunchAgentCounterFile[], incidents: Incident[], nowMs: number): Promise<void> {
  const activeLabels = new Set(incidents.filter((item) => activeStatuses.has(item.status)).map((item) => item.payload.label));
  for (const label of observations.keys()) if (!activeLabels.has(label)) observations.delete(label);
  for (const label of activeLabels) {
    if (typeof label !== 'string') continue;
    const knownCounter = counters.find((entry) => entry.label === label);
    const current = knownCounter ? await runningProcess(label) : null;
    // A process may restart while launchctl is answering. Recheck the history
    // before using the observation to resolve a persisted incident.
    const counter = current ? readLaunchAgentCounters(getDataDir(), nowMs).find((entry) => entry.label === label) : null;
    if (!counter || !current) {
      observations.delete(label);
      continue;
    }
    const latestStartAtMs = counter.startsMs.length ? Math.max(...counter.startsMs) : null;
    const previous = observations.get(label);
    if (!previous || previous.pid !== current.pid || previous.runs !== current.runs
      || nowMs < previous.lastObservedMs || nowMs - previous.lastObservedMs > MAX_OBSERVATION_GAP_MS
      || (latestStartAtMs !== null && latestStartAtMs !== previous.latestStartAtMs)) {
      observations.set(label, { ...current, sinceMs: nowMs, lastObservedMs: nowMs, latestStartAtMs, initialStartsMs: counter.startsMs });
      continue;
    }
    previous.lastObservedMs = nowMs;
    if (nowMs - previous.sinceMs < LAUNCH_AGENT_HEALTHY_UPTIME_MS) continue;
    const resolvedAt = new Date(nowMs).toISOString();
    // Operator decisions made while the probe was pending take precedence.
    for (const item of listRecordedInboxItems({ includeAllProjects: true })) {
      if (item.kind !== 'launch_agent_crash_loop' || item.payload.label !== label || !activeStatuses.has(item.status)) continue;
      resolveInboxItem(item.id, null, {
        note: `Auto-resolved: ${label} stayed running for five minutes with no new recorded starts. Checked at ${resolvedAt}.`,
        packetId: null, laneId: null, event: 'launch_agent_recovered', probeKind: 'launchctl_print', resolvedAt,
        evidence: {
          pid: current.pid, runs: current.runs, observedFromMs: previous.sinceMs, observedThroughMs: nowMs,
          healthyWindowMs: LAUNCH_AGENT_HEALTHY_UPTIME_MS, maxObservationGapMs: MAX_OBSERVATION_GAP_MS,
          latestStartAtMs: previous.latestStartAtMs, initialStartsMs: previous.initialStartsMs, recentStartsMs: counter.startsMs,
        },
      });
    }
    observations.delete(label);
  }
}

export interface LaunchAgentCrashLoopAlert {
  label: string;
  failureCount: number;
}

function surfaceCounter(label: string, startsMs: number[], nowMs: number, incidents: Incident[]): LaunchAgentCrashLoopAlert | null {
  const failureCount = launchAgentFailureCount(startsMs, nowMs);
  if (failureCount < ALERT_AFTER_FAILURES) {
    lastSurfacedStarts.delete(label);
    return null;
  }
  const latestStartAtMs = Math.max(...startsMs);
  if (latestStartAtMs <= (lastSurfacedStarts.get(label) ?? 0)
    || incidents.some((item) => item.payload.label === label && recoveredThroughMs(item) >= latestStartAtMs)) {
    return null;
  }
  const dataDir = getDataDir();
  incidents.push(enqueueInboxItem({
    repoPath: dataDir,
    packetId: null,
    kind: 'launch_agent_crash_loop',
    status: 'human_required',
    payload: {
      label,
      failureCount,
      startsMs,
      windowMinutes: 60,
      summary: `${label} failed ${failureCount} times in the last hour`,
    },
  }));
  lastSurfacedStarts.set(label, latestStartAtMs);
  return { label, failureCount };
}

async function checkLaunchAgentCrashLoops(nowMs: number): Promise<LaunchAgentCrashLoopAlert[]> {
  const counters = readLaunchAgentCounters(getDataDir(), nowMs);
  const incidents: Incident[] = listRecordedInboxItems({ includeAllProjects: true }).filter((item) => item.kind === 'launch_agent_crash_loop');
  const labels = new Set(counters.map((counter) => counter.label));
  for (const label of lastSurfacedStarts.keys()) {
    if (!labels.has(label)) lastSurfacedStarts.delete(label);
  }
  const alerts = counters
    .map((counter) => surfaceCounter(counter.label, counter.startsMs, nowMs, incidents))
    .filter((alert): alert is LaunchAgentCrashLoopAlert => alert !== null);
  await reconcileRecovery(counters, incidents, nowMs);
  return alerts;
}

export function surfaceLaunchAgentCrashLoops(nowMs = Date.now()): Promise<LaunchAgentCrashLoopAlert[]> {
  // Timer ticks must not overlap a slow probe or advance its observation twice.
  if (!checkInFlight) checkInFlight = checkLaunchAgentCrashLoops(nowMs).finally(() => { checkInFlight = null; });
  return checkInFlight;
}

export function surfaceLaunchAgentCrashLoop(nowMs = Date.now()): number {
  const dataDir = getDataDir();
  return surfaceCounter(
    OPERATOR_MCP_LAUNCH_AGENT_LABEL,
    readLaunchAgentStarts(dataDir, nowMs),
    nowMs,
    listRecordedInboxItems({ includeAllProjects: true }).filter((item) => item.kind === 'launch_agent_crash_loop'),
  )?.failureCount ?? 0;
}
