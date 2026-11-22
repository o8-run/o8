import { getSqlite } from '@/lib/db';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { probeBranchMerged } from '@/lib/orchestrator/branch-merge-probe';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  buildOutsideHumanWaitingInbox,
  collapseActiveInboxIncidents,
  listInboxItems,
  resolveInboxItem,
  type SupervisorInboxItem,
  type SupervisorInboxKind,
  type SupervisorInboxResolutionNote,
} from '@/lib/supervisor/inbox';
import { resolveVerificationIncidentsForMergedPacket } from '@/lib/supervisor/merged-incident-resolution';

const PACKET_GONE_TTL_MS = 7 * 24 * 60 * 60_000;

const ACTIVE_INCIDENT_STATUSES = new Set<SupervisorInboxItem['status']>([
  'pending',
  'healing',
  'human_required',
  'escalated',
]);

const TERMINAL_PACKET_INCIDENT_KINDS = new Set<SupervisorInboxKind>([
  'verification_failed',
  'silent_exit_verification_failed',
  'silent_exit_no_work',
  'silent_exit_but_work_present',
]);

interface LivenessProbeSweepResult {
  scanned: number;
  resolved: number;
  stayed: number;
}

interface ProbeContext {
  now: Date;
  nowMs: number;
  packetById: Map<string, OrchestratorPacket>;
}

function payloadString(item: SupervisorInboxItem, key: string): string | null {
  const value = item.payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createdAtMs(item: SupervisorInboxItem): number {
  const parsed = Date.parse(item.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function terminalResolutionNote(input: {
  item: SupervisorInboxItem;
  lane: Lane | null;
  probeKind: string;
  event: string;
  note: string;
  terminalState?: 'released' | 'archived' | 'failed' | 'expired';
  resolvedAt: string;
  evidence: Record<string, unknown>;
}): SupervisorInboxResolutionNote {
  return {
    note: input.note,
    packetId: input.item.packetId,
    laneId: input.lane?.id ?? payloadString(input.item, 'laneId'),
    event: input.event,
    terminalState: input.terminalState,
    probeKind: input.probeKind,
    evidence: {
      inboxItemId: input.item.id,
      inboxKind: input.item.kind,
      checkedAt: input.resolvedAt,
      ...input.evidence,
    },
    resolvedAt: input.resolvedAt,
  };
}

function resolveWithEvidence(input: {
  item: SupervisorInboxItem;
  lane: Lane | null;
  probeKind: string;
  event: string;
  note: string;
  terminalState?: 'released' | 'archived' | 'failed' | 'expired';
  now: Date;
  evidence: Record<string, unknown>;
}): void {
  const resolvedAt = input.now.toISOString();
  resolveInboxItem(
    input.item.id,
    input.lane?.id ?? payloadString(input.item, 'laneId'),
    terminalResolutionNote({
      item: input.item,
      lane: input.lane,
      probeKind: input.probeKind,
      event: input.event,
      note: input.note,
      terminalState: input.terminalState,
      resolvedAt,
      evidence: input.evidence,
    }),
  );
}

async function probeMergeBlocked(item: SupervisorInboxItem, context: ProbeContext): Promise<boolean> {
  if (!item.packetId) return false;
  const packet = context.packetById.get(item.packetId) ?? null;
  const lane = findLatestLaneByPacket(item.packetId);
  const repoPath = lane?.worktreePath ?? packet?.lane?.worktreePath ?? item.worktreePath ?? item.repoPath;
  const branch = lane?.branch ?? packet?.branchTarget ?? payloadString(item, 'branch') ?? 'HEAD';
  const base = lane?.baseBranch ?? payloadString(item, 'baseBranch') ?? 'main';
  const probeBranch = repoPath === item.repoPath ? branch : 'HEAD';
  const probe = await probeBranchMerged({ repoPath, branch: probeBranch, base });
  if (!probe.merged) return false;

  resolveWithEvidence({
    item,
    lane,
    probeKind: 'merge_blocked_ancestry',
    event: 'liveness_probe_sweep',
    note: [
      `Auto-resolved: merge_blocked cleared; branch merged at ${probe.mergeCommit ?? 'unknown'}.`,
      `packetId=${item.packetId}`,
      `laneId=${lane?.id ?? payloadString(item, 'laneId') ?? 'unknown'}`,
      `branch=${branch}`,
      `base=${base}`,
    ].join(' '),
    now: context.now,
    evidence: {
      branch,
      base,
      probedBranch: probeBranch,
      repoPath,
      mergeCommit: probe.mergeCommit,
      ahead: probe.ahead,
    },
  });
  return true;
}

function probePacketMissing(item: SupervisorInboxItem, context: ProbeContext): boolean {
  if (!item.packetId) return false;
  const packet = context.packetById.get(item.packetId) ?? null;
  const lane = findLatestLaneByPacket(item.packetId);
  if (packet) {
    resolveWithEvidence({
      item,
      lane,
      probeKind: 'packet_present',
      event: 'liveness_probe_sweep',
      note: [
        `Auto-resolved: packet_missing cleared; packet present, lane ${lane?.id ?? packet.lane?.laneId ?? 'unknown'}.`,
        `packetId=${item.packetId}`,
      ].join(' '),
      now: context.now,
      evidence: {
        packetStatus: packet.status,
        releaseState: packet.releaseState,
        laneId: lane?.id ?? packet.lane?.laneId ?? null,
      },
    });
    return true;
  }

  const ageMs = context.nowMs - createdAtMs(item);
  if (ageMs < PACKET_GONE_TTL_MS) return false;

  resolveWithEvidence({
    item,
    lane,
    probeKind: 'packet_gone_ttl',
    event: 'liveness_probe_sweep',
    note: [
      'Auto-resolved: packet_missing expired after 7 days; deleted packet is not a live fault.',
      `packetId=${item.packetId}`,
    ].join(' '),
    terminalState: 'expired',
    now: context.now,
    evidence: {
      packetId: item.packetId,
      createdAt: item.createdAt,
      ageMs,
      ttlMs: PACKET_GONE_TTL_MS,
    },
  });
  return true;
}

function probeSessionLost(item: SupervisorInboxItem, context: ProbeContext): boolean {
  if (!item.packetId) return false;
  const lane = findLatestLaneByPacket(item.packetId);
  if (lane?.status !== 'completed') return false;

  resolveWithEvidence({
    item,
    lane,
    probeKind: 'newer_session_completed',
    event: 'liveness_probe_sweep',
    note: [
      'Auto-resolved: session_lost cleared; newer session completed the work.',
      `packetId=${item.packetId}`,
      `laneId=${lane.id}`,
    ].join(' '),
    terminalState: 'released',
    now: context.now,
    evidence: {
      laneId: lane.id,
      laneStatus: lane.status,
      laneCreatedAt: lane.createdAt,
      laneLastEventAt: lane.lastEventAt,
    },
  });
  return true;
}

function probeBoundedRetryExhausted(item: SupervisorInboxItem, context: ProbeContext): boolean {
  if (!item.packetId) return false;
  const lane = findLatestLaneByPacket(item.packetId);
  if (lane?.status !== 'completed') return false;

  resolveWithEvidence({
    item,
    lane,
    probeKind: 'latest_lane_merged',
    event: 'liveness_probe_sweep',
    note: [
      'Auto-resolved: bounded_retry_exhausted cleared; latest lane merged.',
      `packetId=${item.packetId}`,
      `laneId=${lane.id}`,
    ].join(' '),
    terminalState: 'released',
    now: context.now,
    evidence: {
      laneId: lane.id,
      laneStatus: lane.status,
      laneLastEventAt: lane.lastEventAt,
      laneLastEventLabel: lane.lastEventLabel,
    },
  });
  return true;
}

function probeNoSessionBinding(item: SupervisorInboxItem, context: ProbeContext): boolean {
  if (!item.packetId) return false;
  const packet = context.packetById.get(item.packetId) ?? null;
  const lane = findLatestLaneByPacket(item.packetId);
  const sessionKey = lane?.sessionKey ?? packet?.lane?.sessionKey ?? null;
  if (sessionKey) {
    resolveWithEvidence({
      item,
      lane,
      probeKind: 'session_binding_present',
      event: 'liveness_probe_sweep',
      note: [
        'Auto-resolved: no_session_binding cleared; lane has a sessionKey now.',
        `packetId=${item.packetId}`,
        `laneId=${lane?.id ?? packet?.lane?.laneId ?? 'unknown'}`,
      ].join(' '),
      now: context.now,
      evidence: {
        laneId: lane?.id ?? packet?.lane?.laneId ?? null,
        sessionKey,
      },
    });
    return true;
  }

  if (!packet) return false;
  const terminalState = packetTerminalState(packet);
  if (!terminalState) return false;

  resolveWithEvidence({
    item,
    lane,
    probeKind: 'packet_terminal',
    event: 'liveness_probe_sweep',
    note: [
      `Auto-resolved: no_session_binding cleared; packet terminal (${terminalState}).`,
      `packetId=${item.packetId}`,
      `laneId=${lane?.id ?? packet.lane?.laneId ?? 'unknown'}`,
    ].join(' '),
    terminalState,
    now: context.now,
    evidence: {
      packetStatus: packet.status,
      releaseState: packet.releaseState,
      archivedAt: packet.archivedAt,
    },
  });
  return true;
}

function probeTerminalPacketIncident(item: SupervisorInboxItem, context: ProbeContext): boolean {
  if (!item.packetId) return false;
  const packet = context.packetById.get(item.packetId);
  if (!packet) return false;
  const terminalState = packetTerminalState(packet);
  if (terminalState !== 'released' && terminalState !== 'archived') return false;
  return resolveVerificationIncidentsForMergedPacket({
    packetId: item.packetId,
    laneId: findLatestLaneByPacket(item.packetId)?.id ?? packet.lane?.laneId ?? null,
    event: 'liveness_probe_sweep',
    now: context.now,
  }) > 0;
}

async function probeItem(item: SupervisorInboxItem, context: ProbeContext): Promise<boolean> {
  let resolved = false;
  try {
    resolved = await probeItemByKind(item, context);
  } catch (error) {
    // A failing primary probe (missing repo, pruned worktree) must not block
    // the subject-gone fallthrough — those are exactly the cards it exists for.
    console.warn(`[liveness-probes] ${item.kind} probe failed for ${item.id}:`, error instanceof Error ? error.message : error);
    resolved = false;
  }
  if (resolved) return true;
  return expireWhenSubjectGone(item, context);
}

async function probeItemByKind(item: SupervisorInboxItem, context: ProbeContext): Promise<boolean> {
  if (TERMINAL_PACKET_INCIDENT_KINDS.has(item.kind)) {
    return probeTerminalPacketIncident(item, context);
  }

  switch (item.kind) {
    case 'merge_blocked':
      return probeMergeBlocked(item, context);
    case 'packet_missing':
      return probePacketMissing(item, context);
    case 'session_lost':
      return probeSessionLost(item, context);
    case 'bounded_retry_exhausted':
      return probeBoundedRetryExhausted(item, context);
    case 'no_session_binding':
      return probeNoSessionBinding(item, context);
    case 'fetch_unreachable':
    case 'repo_misconfigured':
      return false;
    default:
      return false;
  }
}

// Subject-gone TTL fallthrough: a card can only be fact-checked while its
// subject (the packet) still exists in the control plane. When the packet is
// gone, the probes above can never confirm OR refute the fault — the evidence
// was pruned. Holding such a card human_required forever is the graveyard
// pattern #1266 kills; expiring it after the same 7-day window as
// packet_missing, with an explicit note, is the honest alternative. Kinds with
// their own TTL (packet_missing) or no packet subject are excluded.
function expireWhenSubjectGone(item: SupervisorInboxItem, context: ProbeContext): boolean {
  if (!item.packetId) return false;
  if (item.kind === 'packet_missing' || item.kind === 'fetch_unreachable' || item.kind === 'repo_misconfigured') {
    return false;
  }
  if (context.packetById.has(item.packetId)) return false;
  const ageMs = context.nowMs - createdAtMs(item);
  if (ageMs < PACKET_GONE_TTL_MS) return false;

  const lane = findLatestLaneByPacket(item.packetId);
  resolveWithEvidence({
    item,
    lane,
    probeKind: 'subject_gone_ttl',
    event: 'liveness_probe_sweep',
    note: [
      `Auto-resolved: ${item.kind} expired after 7 days; its packet left the control plane so the fault can no longer be verified.`,
      `packetId=${item.packetId}`,
    ].join(' '),
    terminalState: 'expired',
    now: context.now,
    evidence: {
      packetId: item.packetId,
      kind: item.kind,
      createdAt: item.createdAt,
      ageMs,
      ttlMs: PACKET_GONE_TTL_MS,
    },
  });
  return true;
}

/** What the probes read when the last timed sweep resolved nothing, and when an expiry falls due. */
let lastProbeInputs: string | null = null;
let nextExpiryAt = Infinity;

/**
 * Everything a probe reads, apart from the clock: each open incident with a
 * packet, that packet, and the packet's latest lane. Null when an open
 * merge_blocked incident needs git ancestry, which this does not stamp.
 */
function probeInputs(packetById: Map<string, OrchestratorPacket>): { inputs: string; expiresAt: number } | null {
  const statuses = [...ACTIVE_INCIDENT_STATUSES];
  const rows = getSqlite().prepare(`
    SELECT id, kind, status, packet_id, repo_path, created_at, payload FROM supervisor_inbox
    WHERE packet_id IS NOT NULL AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY id
  `).all(...statuses) as Array<{ id: string; kind: string; packet_id: string; created_at: string }>;
  if (rows.some((row) => row.kind === 'merge_blocked')) return null;
  let expiresAt = Infinity;
  const parts = rows.map((row) => {
    const packet = packetById.get(row.packet_id);
    if (!packet) expiresAt = Math.min(expiresAt, Date.parse(row.created_at) + PACKET_GONE_TTL_MS);
    const lane = findLatestLaneByPacket(row.packet_id);
    return JSON.stringify([row, packet ?? null, lane && [lane.id, lane.status, lane.sessionKey, lane.worktreePath]]);
  });
  return { inputs: parts.join('\n'), expiresAt: Number.isFinite(expiresAt) ? expiresAt : Infinity };
}

export async function runLivenessProbeSweep(input: { now?: Date } = {}): Promise<LivenessProbeSweepResult> {
  const now = input.now ?? new Date();
  const state = readOrchestratorControlPlaneState();
  // The timed sweep skips its probes while nothing they read has changed and
  // no expiry is due. The inbox reconcile it triggers still runs.
  const timed = input.now === undefined;
  const probed = timed ? probeInputs(new Map(state.packets.map((packet) => [packet.id, packet] as const))) : null;
  if (probed && probed.inputs === lastProbeInputs && now.getTime() < nextExpiryAt) {
    buildOutsideHumanWaitingInbox();
    collapseActiveInboxIncidents();
    return { scanned: 0, resolved: 0, stayed: 0 };
  }
  const context: ProbeContext = {
    now,
    nowMs: now.getTime(),
    packetById: new Map(state.packets.map((packet) => [packet.id, packet] as const)),
  };
  const items = listInboxItems({ includeAllProjects: true })
    .filter((item) => ACTIVE_INCIDENT_STATUSES.has(item.status));

  let resolved = 0;
  let failed = false;
  for (const item of items) {
    try {
      if (await probeItem(item, context)) {
        resolved += 1;
      }
    } catch (error) {
      failed = true;
      console.warn(
        `[supervisor-liveness] probe failed for ${item.kind} item ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // A resolution changes the inputs and a failed probe retries: read them again next time.
  lastProbeInputs = resolved === 0 && !failed && probed ? probed.inputs : null;
  nextExpiryAt = probed?.expiresAt ?? Infinity;
  return {
    scanned: items.length,
    resolved,
    stayed: items.length - resolved,
  };
}
