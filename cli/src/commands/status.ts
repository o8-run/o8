/**
 * `o8 status` — top-level snapshot: running packets, active lanes, recent
 * merges, pending approvals.
 *
 * Strict no-new-endpoints: pulls from /api/lanes (active=true + active=false)
 * and /api/panel/approvals. Packet workers use /api/lanes?view=live for a
 * read-only occupancy view. Recent merges are completed lanes ordered by updatedAt desc.
 */

import { apiFetch } from '../api.js';
import { resolveConfig } from '../config.js';
import { approvalAge } from '../../../src/lib/orchestrator/status-age.js';
import { runtimeConnectionRows, connectionDetail, connectionLabel } from '../../../src/lib/runtimes/shared/connection-evidence.js';
import type { TerminalWorktreeStorage } from '../../../src/lib/lane/terminal-worktree-storage.js';
import {
  color,
  printHumanHeading,
  printJson,
  type OutputMode,
} from '../output.js';

const LISTED_OPERATOR_DEFAULTS = [
  { key: 'composerEnterQueues', setting: 'chat.enter_queues' },
  { key: 'textGenerationTitleModel', setting: 'text_generation.title_model' },
] as const;

/** Reports each listed default with where its value came from. */
function operatorDefaultRows(data: unknown) {
  const { values, sources } = (data ?? {}) as {
    values?: Record<string, unknown>;
    sources?: Record<string, unknown>;
  };
  return LISTED_OPERATOR_DEFAULTS.flatMap(({ key, setting }) => {
    const value = values?.[key];
    if (value === undefined) return [];
    return [{ key, setting, value, source: String(sources?.[key] ?? 'default') }];
  });
}

interface Lane {
  id: string;
  label: string;
  status: string;
  runtime: string;
  branch: string;
  baseBranch: string;
  repoPath: string;
  worktreePath: string | null;
  packetId: string | null;
  sessionKey?: string | null;
  updatedAt: string;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  lastTranscriptAt?: string | null;
  transcriptFault?: { code?: string; stalledForMs?: number | null } | null;
}

interface Approval {
  id: string;
  status: string;
  kind?: string;
  summary?: string;
  packetId?: string | null;
  laneId?: string | null;
  createdAt?: string | number;
}

interface StatusSession {
  sessionKey: string;
  status: string;
  summary: string;
  nextActions?: Array<{ endpoint: string; action: string; surfaceId: string; requiredInputs: string[] }>;
}

interface MissionStatusPacket {
  id: string;
  title?: string;
  status?: string;
  blockedReason?: string | null;
  terminalReason?: { code: string; cause: string | null } | null;
  storageAdmission?: {
    state?: string;
    reason?: string;
    recordedAt?: number;
    estimateBytes?: number;
    physicalAvailableBytes?: number | null;
    requiredReserveBytes?: number | null;
  } | null;
}

interface TerminalReasonRow {
  packetId: string | null;
  status?: string;
  terminalReason: { code: string; cause: string | null };
}

interface MissionStatusResponse {
  ok: boolean;
  result?: { packets?: MissionStatusPacket[] };
}

interface ShippedDarkFlagStatus {
  tomlKey: string;
  landedRelease: string | null;
  darkForReleases: number | null;
  /** Absent on older servers; an unclassified flag stays a promotion candidate. */
  lifecycle?: 'promotion-candidate' | 'deliberate-default-off' | 'promoted';
  lifecycleRationale?: string | null;
  needsAttention?: boolean;
}

interface PanelStatusResponse {
  shippedDarkAudit?: {
    status?: string;
    checkedAt?: string;
    currentRelease?: string | null;
    thresholdReleases?: number;
    checkedFlagCount?: number;
    attentionFlagCount?: number;
    flags?: ShippedDarkFlagStatus[];
  };
}

/** How a dark flag reads to the operator: warning, deliberate, or still young. */
function dispositionLabel(flag: ShippedDarkFlagStatus, isWarning: boolean): string {
  if (isWarning) return 'awaiting promotion review';
  if (flag.lifecycle === 'deliberate-default-off') {
    return `by design${flag.lifecycleRationale ? `: ${flag.lifecycleRationale}` : ''}`;
  }
  if (flag.lifecycle === 'promoted') return 'promoted';
  return 'awaiting promotion review (under threshold)';
}

function releaseAgeLabel(value: number | null): string {
  if (value === null) return 'release age unknown';
  return value === 1 ? '1 release' : `${value} releases`;
}

// Review and input waits stay in activeLanes, but no worker is executing there.
const RUNNING_STATUSES = new Set([
  'running',
  'launching',
  'merging',
]);

export async function runStatus(mode: OutputMode): Promise<number> {
  const cfg = resolveConfig();

  if (cfg.source?.token === 'worker') {
    const response = await apiFetch<{ lanes: Array<Pick<Lane, 'id' | 'packetId' | 'status' | 'worktreePath'>> }>(
      cfg, '/api/lanes', { query: { view: 'live' } },
    );
    if (!response.data) throw new Error('Live lane status is unavailable.');
    const activeLanes = response.data.lanes;
    if (mode.human) {
      printHumanHeading('o8 status');
      for (const lane of activeLanes) {
        process.stdout.write(`  ${lane.status} ${lane.id} ${lane.packetId ?? '-'} ${lane.worktreePath ?? '-'}\n`);
      }
      if (activeLanes.length === 0) process.stdout.write('  No active lanes.\n');
    } else {
      printJson({ schema: 'o8/cli/worker-status/v1', activeLanes });
    }
    return 0;
  }

  const [activeRes, allRes, approvalsRes, missionRes, panelStatusRes, operatorRes] = await Promise.all([
    apiFetch<{ lanes: Lane[] }>(cfg, '/api/lanes', { query: { active: 'true' } }),
    apiFetch<{ lanes: Lane[]; terminalStorage?: TerminalWorktreeStorage }>(cfg, '/api/lanes', {
      query: { active: 'false', storage: 'terminal' },
    }),
    apiFetch<{ approvals: Approval[] }>(cfg, '/api/panel/approvals', { query: { status: 'pending' } }),
    apiFetch<MissionStatusResponse>(cfg, '/api/orchestrator/status', { allowNotFound: true }),
    apiFetch<PanelStatusResponse>(cfg, '/api/panel/status', { allowNotFound: true }),
    apiFetch<{ agents?: StatusSession[]; terminalReasons?: TerminalReasonRow[]; terminalReasonsTruncated?: boolean }>(cfg, '/api/operator/status', { allowNotFound: true }),
  ]);

  const staleSessions = (operatorRes?.data?.agents ?? []).filter((session) => session.status === 'stale');
  const staleKeys = new Set(staleSessions.map((session) => session.sessionKey));
  const activeLanes = (activeRes.data?.lanes ?? []).map((lane) => (
    lane.sessionKey && staleKeys.has(lane.sessionKey) ? { ...lane, status: 'stale' } : lane
  ));
  const connectionResponse = await Promise.resolve(apiFetch(cfg, '/api/panel/operator-defaults', { timeoutMs: 15_000 }))
    .catch(() => null);
  const runtimeConnections = runtimeConnectionRows(connectionResponse?.data);
  const operatorDefaults = operatorDefaultRows(connectionResponse?.data);
  const allLanes = allRes.data?.lanes ?? [];
  const terminalStorage = allRes.data?.terminalStorage ?? null;
  const approvals = approvalsRes.data?.approvals ?? [];
  const storageHolds = (missionRes.data?.result?.packets ?? [])
    .filter((packet) => packet.storageAdmission?.state === 'held')
    .map((packet) => ({
      packetId: packet.id,
      title: packet.title ?? '',
      status: packet.status ?? 'queued',
      reason: packet.blockedReason ?? packet.storageAdmission?.reason ?? 'Storage admission held dispatch.',
      recordedAt: packet.storageAdmission?.recordedAt ?? null,
      estimateBytes: packet.storageAdmission?.estimateBytes ?? null,
      physicalAvailableBytes: packet.storageAdmission?.physicalAvailableBytes ?? null,
      requiredReserveBytes: packet.storageAdmission?.requiredReserveBytes ?? null,
    }));
  const terminalReasons = operatorRes?.data?.terminalReasons ?? (missionRes.data?.result?.packets ?? []).flatMap((packet) => packet.terminalReason
    ? [{ packetId: packet.id, status: packet.status, terminalReason: packet.terminalReason }] : []);
  const shippedDarkAudit = panelStatusRes.data?.shippedDarkAudit ?? null;
  // Deliberate default-off flags stay in `shippedDarkAudit` for the operator to
  // read; only unreviewed promotion candidates age into a warning.
  const shippedDarkFlags = shippedDarkAudit?.flags ?? [];
  const shippedDarkWarnings = shippedDarkFlags
    .filter((flag) => (
      // The v2 server already decided this; only older payloads need the
      // lifecycle + age recomputation below.
      typeof flag.needsAttention === 'boolean'
        ? flag.needsAttention
        : (flag.lifecycle ?? 'promotion-candidate') === 'promotion-candidate'
          && typeof flag.darkForReleases === 'number'
          && typeof shippedDarkAudit?.thresholdReleases === 'number'
          && flag.darkForReleases >= shippedDarkAudit.thresholdReleases
    ));
  const shippedDarkByDesign = shippedDarkFlags
    .filter((flag) => flag.lifecycle === 'deliberate-default-off');

  const running = activeLanes.filter((l) => RUNNING_STATUSES.has(l.status));
  // Review packets remain active but are not always included in an upstream
  // running summary. Read the full lane set so a packet that needs an operator
  // decision cannot disappear behind a zero-count status snapshot.
  const awaitingReview = allLanes.filter((l) => l.status === 'reviewing');
  const recentMerges = allLanes
    .filter((l) => l.status === 'completed')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 10);

  // Bound the lane arrays so a worktree storm can't flood an agent piping
  // `o8 status` JSON in. counts.* still report the true totals.
  const LANE_CAP = 50;
  const payload = {
    schema: 'o8/cli/status/v1',
    runtimeConnections,
    operatorDefaults,
    staleSessions: staleSessions.slice(0, LANE_CAP),
    staleSessionsTruncated: staleSessions.length > LANE_CAP,
    counts: {
      runningPackets: running.length,
      awaitingReview: awaitingReview.length,
      activeLanes: activeLanes.length,
      recentMerges: recentMerges.length,
      pendingApprovals: approvals.length,
      storageHolds: storageHolds.length,
      shippedDarkWarnings: shippedDarkWarnings.length,
      staleSessions: staleSessions.length,
    },
    activeLanesTruncated: activeLanes.length > LANE_CAP,
    awaitingReviewTruncated: awaitingReview.length > LANE_CAP,
    runningPackets: running.slice(0, LANE_CAP).map(summarizeLane),
    awaitingReview: awaitingReview.slice(0, LANE_CAP).map(summarizeLane),
    activeLanes: activeLanes.slice(0, LANE_CAP).map(summarizeLane),
    recentMerges: recentMerges.map(summarizeLane),
    pendingApprovals: approvals.map((a) => ({
      id: a.id,
      status: a.status,
      kind: a.kind ?? null,
      summary: a.summary ?? null,
      packetId: a.packetId ?? null,
      laneId: a.laneId ?? null,
      createdAt: a.createdAt ?? null,
      ...approvalAge(a.createdAt),
    })),
    storageHolds,
    terminalReasons,
    terminalReasonsTruncated: operatorRes?.data?.terminalReasonsTruncated === true,
    terminalStorage,
    shippedDarkAudit,
    shippedDarkWarnings,
    shippedDarkByDesign,
  };

  if (mode.human) {
    printHumanHeading(`o8 status (${cfg.apiBase})`);
    printHumanHeading('runtime connections');
    for (const runtime of runtimeConnections.runtimes) {
      const evidence = runtime.connection;
      process.stdout.write(`  ${runtime.label}: ${evidence ? connectionLabel(evidence) : 'Connection unknown'}\n`);
      if (evidence) process.stdout.write(`    ${connectionDetail(evidence)} Checked ${evidence.checkedAt ? new Date(evidence.checkedAt).toISOString() : 'time not reported'}. Account identity not reported; external tools not inspected.\n`);
    }
    if (runtimeConnections.status === 'unavailable') process.stdout.write('  Connection evidence unavailable.\n');
    if (operatorDefaults.length > 0) {
      printHumanHeading('operator defaults');
      for (const row of operatorDefaults) {
        process.stdout.write(`  ${row.setting}: ${row.value === '' ? '(unset)' : String(row.value)} (${row.source})\n`);
      }
    }
    process.stdout.write(
        `  running ${color(String(running.length), 'green')}` +
        `   review ${color(String(awaitingReview.length), 'yellow')}` +
        `   active ${activeLanes.length}` +
        `   merges ${recentMerges.length}` +
        `   approvals ${color(String(approvals.length), 'yellow')}` +
        `   storage holds ${color(String(storageHolds.length), 'yellow')}` +
        `   dark flags ${color(String(shippedDarkWarnings.length), 'yellow')}\n`,
    );
    if (running.length > 0) {
      printHumanHeading('running');
      for (const l of running) process.stdout.write(formatLaneLine(l));
    }
    if (awaitingReview.length > 0) {
      printHumanHeading('awaiting review');
      for (const l of awaitingReview) process.stdout.write(formatLaneLine(l));
    }
    if (staleSessions.length > 0) {
      printHumanHeading('stale sessions');
      for (const session of staleSessions) {
        process.stdout.write(`  stale ${session.sessionKey}  ${session.summary}\n`);
        for (const action of session.nextActions ?? []) {
          process.stdout.write(`    Recover: POST ${action.endpoint} action=${action.action} surfaceId=${action.surfaceId}; supply ${action.requiredInputs.join(', ')}\n`);
        }
      }
    }
    if (recentMerges.length > 0) {
      printHumanHeading('recent merges');
      for (const l of recentMerges) process.stdout.write(formatLaneLine(l));
    }
    if (approvals.length > 0) {
      printHumanHeading('pending approvals');
      for (const a of approvals) {
        const age = approvalAge(a.createdAt);
        process.stdout.write(
          `  ${a.id.padEnd(28)} ${a.kind ?? '?'}  ${a.summary ?? ''}  age ${age.age}${age.overdue ? ' [overdue]' : ''}\n`,
        );
      }
    }
    if (terminalReasons.length > 0) {
      printHumanHeading('packet terminal reasons');
      for (const item of terminalReasons) {
        process.stdout.write(`  ${item.packetId}  ${item.terminalReason.code}${item.terminalReason.cause ? `: ${item.terminalReason.cause}` : ''}\n`);
      }
    }
    printHumanHeading('terminal checkout storage');
    if (terminalStorage) {
      const size = terminalStorage.allocatedBytes === null
        ? `allocated bytes unknown (${terminalStorage.observedAllocatedBytes} observed; ${terminalStorage.unknownCheckouts} unknown checkouts)`
        : `${terminalStorage.allocatedBytes} allocated bytes`;
      process.stdout.write(`  ${terminalStorage.checkoutCount} retained checkouts, ${size}\n`);
      for (const checkout of terminalStorage.checkouts) {
        process.stdout.write(`  ${checkout.packetId}  ${checkout.detail ?? checkout.reason ?? 'Retirement pending; no refusal recorded.'}\n`);
      }
      if (terminalStorage.checkoutsTruncated) process.stdout.write('  Showing the first 50 retained checkouts. Totals include all checkouts.\n');
    } else process.stdout.write('  Storage accounting unavailable.\n');
    if (storageHolds.length > 0) {
      printHumanHeading('storage holds');
      for (const hold of storageHolds) {
        process.stdout.write(`  ${hold.status.padEnd(15)} ${hold.packetId.padEnd(28)} ${hold.reason}\n`);
      }
    }
    if (shippedDarkFlags.length > 0) {
      printHumanHeading('shipped but dark');
      for (const flag of shippedDarkFlags) {
        const age = releaseAgeLabel(flag.darkForReleases);
        process.stdout.write(
          `  ${flag.tomlKey.padEnd(42)} ${age}  landed ${flag.landedRelease ?? 'unknown'}  ${dispositionLabel(flag, shippedDarkWarnings.includes(flag))}\n`,
        );
      }
    }
  } else {
    printJson(payload);
  }

  return 0;
}

function summarizeLane(l: Lane) {
  return {
    id: l.id,
    packetId: l.packetId,
    status: l.status,
    runtime: l.runtime,
    label: l.label,
    branch: l.branch,
    baseBranch: l.baseBranch,
    repoPath: l.repoPath,
    worktreePath: l.worktreePath,
    updatedAt: l.updatedAt,
    lastEventAt: l.lastEventAt,
    lastEventLabel: l.lastEventLabel,
    lastTranscriptAt: l.lastTranscriptAt ?? null,
    transcriptFault: l.transcriptFault ?? null,
  };
}

function formatLaneLine(l: Lane): string {
  const status = l.status.padEnd(15);
  const id = (l.packetId ?? l.id).padEnd(28);
  const fault = l.transcriptFault?.code === 'transcript_stalled' ? '  [transcript stalled]' : '';
  return `  ${status} ${id} ${l.label}${fault}\n`;
}
