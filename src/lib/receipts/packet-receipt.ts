import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { listApprovalsForContext } from '@/lib/approvals/store';
import { listReviewCosts, reviewPayer, type ReviewPayer } from '@/lib/lane/review-payer';
import {
  artifactAbsPath,
  artifactRelPath,
  ensureArtifactBucket,
  listArtifacts,
  recordArtifact,
  type ArtifactRecord,
  type ArtifactSource,
} from '@/lib/artifacts/store';
import { getLaneEvents, getLane, findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { canonicalJson } from './canonical';
import {
  buildMergedPacketDisposition,
  PACKET_DISPOSITION_EVENT_CODE,
  parsePacketDisposition,
} from './disposition';
import {
  getReceiptIdentity,
  signReceiptBytes,
} from './receipt-identity';
import {
  readGitRemote,
  readGitTree,
  parsePacketReceipt,
} from './verify-receipt';
import {
  PACKET_RECEIPT_SCHEMA,
  type PacketDisposition,
  type PacketReceipt,
  type PacketReceiptApproval,
  type PacketReceiptReview,
  type UnsignedPacketReceipt,
} from './types';

export interface StoredPacketReceipt {
  artifact: ArtifactRecord;
  receipt: PacketReceipt;
  /** Exact artifact bytes. `receipt` is the result of parsing these bytes once. */
  rawReceiptJson: string;
}

/**
 * `turnPayers` are the payers the turns' own usage rows recorded; they win over a
 * payer inferred from the backend and reported model.
 */
export function collectReviews(events: LaneEvent[], turnPayers: ReadonlyMap<string, ReviewPayer> = new Map()): PacketReceiptReview[] {
  const starts = new Map<string, {
    backend: string;
    startedAt: string;
    outcome: PacketReceiptReview['outcome'];
    finishedAt: string | null;
    model: string | null;
    surface: string | null;
  }>();
  for (const event of events) {
    const turnId = typeof event.payload.reviewTurnId === 'string'
      ? event.payload.reviewTurnId.trim()
      : '';
    if (!turnId) continue;
    if (event.verb === 'review_turn_started') {
      starts.set(turnId, {
        backend: typeof event.payload.backend === 'string' && event.payload.backend.trim()
          ? event.payload.backend.trim()
          : 'unknown',
        startedAt: event.timestamp,
        outcome: 'active',
        finishedAt: null,
        model: null,
        surface: typeof event.payload.surface === 'string' && event.payload.surface.trim()
          ? event.payload.surface.trim()
          : null,
      });
    } else if (event.payload.event === 'review_turn_runtime_receipt') {
      const turn = starts.get(turnId);
      const route = event.payload.runtimeRoute as { model?: unknown } | null | undefined;
      if (turn && typeof route?.model === 'string') turn.model = route.model;
    } else if (event.verb === 'review_turn_finished') {
      const turn = starts.get(turnId);
      const outcome = event.payload.outcome;
      if (turn && ['completed', 'failed', 'quota_discarded'].includes(String(outcome))) {
        turn.outcome = outcome as PacketReceiptReview['outcome'];
        turn.finishedAt = event.timestamp;
      }
    }
  }
  return [...starts.entries()].map(([turnId, turn]) => ({
    turnId,
    backend: turn.backend,
    outcome: turn.outcome,
    at: turn.finishedAt ?? turn.startedAt,
    model: turn.model,
    surface: turn.surface,
    payer: turnPayers.get(turnId) ?? reviewPayer(turn.backend, turn.model).payer,
  }));
}

function collectApprovals(packetId: string, lane: Lane): PacketReceiptApproval[] {
  return listApprovalsForContext({
    packetId,
    laneId: lane.id,
    projectId: lane.projectId,
  })
    .filter((approval) => approval.status === 'approved' || approval.status === 'rejected')
    .map((approval) => ({
      id: approval.id,
      title: approval.title,
      principal: approval.resolution?.actor
        ?? [...approval.audit].reverse().find((event) => event.type === 'approved' || event.type === 'rejected')?.actor
        ?? 'unknown',
      decision: approval.status as PacketReceiptApproval['decision'],
      at: new Date(approval.resolvedAt ?? approval.updatedAt).toISOString(),
    }))
    .sort((left, right) => left.at.localeCompare(right.at));
}

function readDispositionEvent(events: LaneEvent[]): PacketDisposition | null {
  for (const event of [...events].reverse()) {
    if (event.payload.code !== PACKET_DISPOSITION_EVENT_CODE) continue;
    const disposition = parsePacketDisposition(event.payload.disposition);
    if (disposition) return disposition;
  }
  return null;
}

function receiptFromArtifact(artifact: ArtifactRecord): StoredPacketReceipt | null {
  try {
    const rawReceiptJson = readFileSync(artifactAbsPath(artifact.relPath), 'utf8');
    const receipt = parsePacketReceipt(JSON.parse(rawReceiptJson) as unknown);
    return receipt ? { artifact, receipt, rawReceiptJson } : null;
  } catch {
    return null;
  }
}

export function listStoredPacketReceipts(packetId?: string | null): StoredPacketReceipt[] {
  return listArtifacts({ kind: 'receipt', ...(packetId ? { packetId } : {}) })
    .map(receiptFromArtifact)
    .filter((receipt): receipt is StoredPacketReceipt => receipt !== null);
}

async function resolveDisposition(input: {
  packet: OrchestratorPacket;
  lane: Lane;
  repoPath: string;
  expectedMergeCommit?: string | null;
  disposition?: PacketDisposition;
}): Promise<PacketDisposition> {
  if (input.disposition) return input.disposition;
  if (input.packet.releaseState === 'released') {
    const mergeCommit = input.packet.releaseStatePayload?.mergeCommit?.trim() ?? '';
    if (!mergeCommit) throw new Error(`Packet ${input.packet.id} has no persisted merge commit.`);
    const tree = await readGitTree(input.repoPath, mergeCommit);
    if (!tree) throw new Error(`Unable to resolve tree for merge commit ${mergeCommit}.`);
    return buildMergedPacketDisposition({
      releaseStatePayload: input.packet.releaseStatePayload,
      tree,
      expectedMergeCommit: input.expectedMergeCommit,
    });
  }
  const recorded = readDispositionEvent(getLaneEvents(input.lane.id, 10_000));
  if (!recorded) {
    throw new Error(`Packet ${input.packet.id} has no persisted closed disposition.`);
  }
  return recorded;
}

function signReceipt(unsigned: UnsignedPacketReceipt): PacketReceipt {
  const identity = getReceiptIdentity();
  return {
    ...unsigned,
    signature: signReceiptBytes(
      new TextEncoder().encode(canonicalJson(unsigned)),
      identity.secretKey,
    ),
  };
}

async function buildPacketReceipt(input: {
  packet: OrchestratorPacket;
  lane: Lane;
  repoPath: string;
  disposition: PacketDisposition;
}): Promise<PacketReceipt> {
  const identity = getReceiptIdentity();
  const createdAt = new Date().toISOString();
  const remote = await readGitRemote(input.repoPath);
  return signReceipt({
    schema: PACKET_RECEIPT_SCHEMA,
    receiptId: `receipt-${randomUUID()}`,
    packetId: input.packet.id,
    packetTitle: input.packet.title,
    laneId: input.lane.id,
    repo: {
      name: path.basename(path.resolve(input.repoPath)) || 'repository',
      ...(remote ? { remote } : {}),
      baseBranch: input.lane.baseBranch,
    },
    disposition: input.disposition,
    ...(input.disposition.kind === 'pr_opened' ? { task: { branch: input.disposition.branch,
      commit: input.disposition.commit, prNumber: input.disposition.prNumber, verification: input.disposition.verification } } : {}),
    reviews: collectReviews(getLaneEvents(input.lane.id, 10_000),
      new Map(listReviewCosts([input.packet.id]).map((turn) => [turn.reviewTurnId, turn.payer]))),
    approvals: collectApprovals(input.packet.id, input.lane),
    runtime: input.packet.runtime,
    model: input.packet.model ?? input.lane.model ?? null,
    createdAt,
    keyId: identity.keyId,
  });
}

function storePacketReceipt(
  receipt: PacketReceipt,
  lane: Lane,
  source: ArtifactSource,
): StoredPacketReceipt {
  ensureArtifactBucket(receipt.packetId);
  const relPath = artifactRelPath(receipt.packetId, receipt.receiptId, 'json');
  const serialized = `${canonicalJson(receipt)}\n`;
  writeFileSync(artifactAbsPath(relPath), serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const artifact = recordArtifact({
    id: receipt.receiptId,
    kind: 'receipt',
    source,
    relPath,
    laneId: lane.id,
    packetId: receipt.packetId,
    repoPath: lane.repoPath,
    label: 'Signed packet receipt',
    mimeType: 'application/json',
    bytes: Buffer.byteLength(serialized),
  });
  if (!artifact) throw new Error(`Unable to record receipt artifact ${receipt.receiptId}.`);
  return { artifact, receipt, rawReceiptJson: serialized };
}

export async function createPacketReceiptForClosedPacket(input: {
  packetId: string;
  laneId?: string | null;
  repoPath?: string | null;
  expectedMergeCommit?: string | null;
  disposition?: PacketDisposition;
  source?: ArtifactSource;
}): Promise<StoredPacketReceipt> {
  const existing = listStoredPacketReceipts(input.packetId).at(-1);
  if (existing) return existing;

  // This read is deliberately inside receipt creation. Merge callers invoke
  // this function only after markPacketReleased's locked write completes, so
  // release evidence comes from the persisted packet and is never re-derived.
  const state = readOrchestratorControlPlaneState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) throw new Error(`Packet ${input.packetId} was not found.`);
  const lane = (input.laneId ? getLane(input.laneId) : null) ?? findLatestLaneByPacket(input.packetId);
  if (!lane) throw new Error(`No lane was found for packet ${input.packetId}.`);
  const repoPath = input.repoPath?.trim() || lane.repoPath;
  const disposition = await resolveDisposition({
    packet,
    lane,
    repoPath,
    expectedMergeCommit: input.expectedMergeCommit,
    disposition: input.disposition,
  });
  if (disposition.kind === 'merged' && packet.releaseState !== 'released') {
    throw new Error(`Packet ${input.packetId} is not released.`);
  }
  if (disposition.kind === 'discarded' && packet.status !== 'archived') {
    throw new Error(`Packet ${input.packetId} is not closed unmerged.`);
  }
  const receipt = await buildPacketReceipt({ packet, lane, repoPath, disposition });
  return storePacketReceipt(receipt, lane, input.source ?? 'review-boundary');
}
