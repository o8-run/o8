import 'server-only';

import path from 'node:path';

import { listMirroredGitHubIssuesByNumber } from '@/lib/github-broker/store';
import { listRecentMissions } from '@/lib/db/missions-store';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  repoGrantMatchesIdentity,
  repoGrantMatchesRequest,
  repoNameFromGrant,
} from '@/lib/broadcast/repo-grants';
import { readRepoPathRegistry } from '@/lib/repos/repo-path-registry';
import {
  listStoredPacketReceipts,
  type StoredPacketReceipt,
} from './packet-receipt';
import type { PacketReceipt } from './types';

const DEFAULT_LIMIT = 25;
export const MAX_TRUTH_QUERY_LIMIT = 100;

export type TruthQuery =
  | {
    kind: 'merged-since';
    repo: string;
    since: string;
    limit?: number;
    cursor?: string | null;
  }
  | {
    kind: 'packet';
    packetId?: string;
    issueNumber?: number;
    limit?: number;
    cursor?: string | null;
  }
  | {
    kind: 'approvals';
    packetId: string;
    limit?: number;
    cursor?: string | null;
  };

export interface TruthAnswer {
  summary: string;
  /** The object parsed once from the stored receipt artifact. */
  receipt: PacketReceipt;
  /** Exact UTF-8 text read from the stored receipt artifact. */
  receiptRaw: string;
  artifactId: string;
}

export interface TruthQueryResult {
  query: TruthQuery;
  answers: TruthAnswer[];
  asOf: string;
  nextCursor: string | null;
}

export interface TruthPacketRecord {
  id: string;
  issueNumber: number | null;
  issueUrl: string | null;
  referenceLabel: string;
  repoPath: string | null;
}

export interface TruthQueryStores {
  listReceipts: (packetId?: string | null) => StoredPacketReceipt[];
  listPackets: () => TruthPacketRecord[];
  listMirroredIssues: (issueNumber: number) => Array<{
    repoFullName: string;
    number: number;
    title: string;
    url: string;
  }>;
  listRegisteredRepos: () => Promise<Array<{ name: string; repoPath: string }>>;
  now: () => Date;
}

export interface ResolveTruthQueryOptions {
  receiptFilter?: (receipt: StoredPacketReceipt) => boolean;
}

export class TruthQueryError extends Error {
  constructor(
    readonly code: 'invalid_query' | 'invalid_cursor' | 'grant_ambiguous',
    message: string,
  ) {
    super(message);
    this.name = 'TruthQueryError';
  }
}

async function listRegisteredTruthRepos(): Promise<Array<{ name: string; repoPath: string }>> {
  const registry = await readRepoPathRegistry();
  if (!registry.ok) throw new Error(registry.message);
  return registry.repos.map((repo) => ({
    name: typeof repo.name === 'string' && repo.name.trim()
      ? repo.name.trim()
      : path.basename(repo.path),
    repoPath: repo.path,
  }));
}

function packetRecord(packet: OrchestratorPacket, repoPath: string | null): TruthPacketRecord {
  return {
    id: packet.id,
    issueNumber: typeof packet.issue?.number === 'number' ? packet.issue.number : null,
    issueUrl: packet.issue?.url?.trim() || null,
    referenceLabel: packet.referenceLabel,
    repoPath,
  };
}

function listStoredPackets(): TruthPacketRecord[] {
  const byId = new Map<string, TruthPacketRecord>();
  for (const mission of listRecentMissions(10_000)) {
    for (const packet of mission.missionState?.packets ?? []) {
      if (!byId.has(packet.id)) byId.set(packet.id, packetRecord(packet, mission.repoPath));
    }
  }
  const current = readOrchestratorControlPlaneState();
  for (const packet of current.packets) {
    if (!byId.has(packet.id)) byId.set(packet.id, packetRecord(packet, current.repoPath ?? null));
  }
  return [...byId.values()];
}

const DEFAULT_STORES: TruthQueryStores = {
  listReceipts: listStoredPacketReceipts,
  listPackets: listStoredPackets,
  listMirroredIssues: listMirroredGitHubIssuesByNumber,
  listRegisteredRepos: listRegisteredTruthRepos,
  now: () => new Date(),
};

interface TruthCursor {
  createdAt: string;
  artifactId: string;
}

function encodeCursor(value: TruthCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null | undefined): TruthCursor | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.createdAt !== 'string'
      || !Number.isFinite(Date.parse(cursor.createdAt))
      || typeof cursor.artifactId !== 'string'
      || !cursor.artifactId.trim()
    ) return null;
    return { createdAt: cursor.createdAt, artifactId: cursor.artifactId };
  } catch {
    return null;
  }
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRUTH_QUERY_LIMIT) {
    throw new TruthQueryError(
      'invalid_query',
      `limit must be an integer between 1 and ${MAX_TRUTH_QUERY_LIMIT}.`,
    );
  }
  return limit;
}

function assertDate(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TruthQueryError('invalid_query', `${field} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function receiptMatchesRepo(stored: StoredPacketReceipt, repo: string): boolean {
  const normalizedRepo = repo.trim();
  if (path.isAbsolute(normalizedRepo)) {
    return Boolean(stored.artifact.repoPath)
      && path.resolve(stored.artifact.repoPath!) === path.resolve(normalizedRepo);
  }
  const remote = stored.receipt.repo.remote?.trim();
  return stored.receipt.repo.name.trim().toLowerCase() === normalizedRepo.toLowerCase()
    || Boolean(remote && repoGrantMatchesIdentity({
      grant: normalizedRepo,
      repoName: stored.receipt.repo.name,
      repoRemote: remote,
      repoPath: stored.artifact.repoPath,
    }));
}

interface ResolvedRepoGrant {
  grant: string;
  registeredRepoPath: string | null;
}

export interface TruthGrantScope {
  receiptCovered: (stored: StoredPacketReceipt) => boolean;
  coversRequestedRepo: (requestedRepo: string) => boolean;
}

export async function resolveTruthGrantScope(
  repoGrants: readonly string[],
  stores: TruthQueryStores = DEFAULT_STORES,
): Promise<TruthGrantScope> {
  const hasNameGrant = repoGrants.some((grant) => repoNameFromGrant(grant) !== null);
  const registeredRepos = hasNameGrant ? await stores.listRegisteredRepos() : [];
  const resolved: ResolvedRepoGrant[] = repoGrants.map((grant) => {
    const repoName = repoNameFromGrant(grant);
    if (!repoName) return { grant, registeredRepoPath: null };
    const matches = registeredRepos.filter((repo) => repo.name.trim().toLowerCase() === repoName);
    if (matches.length !== 1) {
      throw new TruthQueryError(
        'grant_ambiguous',
        `Repository grant "name:${repoName}" matches ${matches.length} registered repository paths. Name grants require exactly one registered local repository; use a normalized remote or absolute path grant.`,
      );
    }
    return { grant, registeredRepoPath: matches[0]!.repoPath };
  });
  const receiptCovered = (stored: StoredPacketReceipt) => resolved.some((binding) => (
    repoGrantMatchesIdentity({
      grant: binding.grant,
      repoName: stored.receipt.repo.name,
      repoRemote: stored.receipt.repo.remote,
      repoPath: stored.artifact.repoPath,
      registeredRepoPath: binding.registeredRepoPath,
    })
  ));
  return {
    receiptCovered,
    coversRequestedRepo: (requestedRepo) => resolved.some((binding) => repoGrantMatchesRequest({
      grant: binding.grant,
      requestedRepo,
      registeredRepoPath: binding.registeredRepoPath,
    })) || stores.listReceipts().some((stored) => (
      receiptMatchesRepo(stored, requestedRepo) && receiptCovered(stored)
    )),
  };
}

function receiptMatchesMirror(stored: StoredPacketReceipt, repoFullName: string): boolean {
  const remote = stored.receipt.repo.remote?.toLowerCase() ?? '';
  return remote.endsWith(`/${repoFullName.toLowerCase()}`);
}

function packetIdsForIssue(issueNumber: number, stores: TruthQueryStores): Set<string> {
  const packets = stores.listPackets();
  const direct = packets.filter((packet) => packet.issueNumber === issueNumber);
  if (direct.length > 0) return new Set(direct.map((packet) => packet.id));

  const mirrors = stores.listMirroredIssues(issueNumber);
  const receiptsByPacket = new Map<string, StoredPacketReceipt[]>();
  return new Set(packets.filter((packet) => mirrors.some((mirror) => {
    if (packet.issueUrl && packet.issueUrl === mirror.url) return true;
    if (packet.referenceLabel.trim() !== `#${issueNumber}`) return false;
    const receipts = receiptsByPacket.get(packet.id) ?? stores.listReceipts(packet.id);
    receiptsByPacket.set(packet.id, receipts);
    return receipts.some((receipt) => receiptMatchesMirror(receipt, mirror.repoFullName));
  })).map((packet) => packet.id));
}

function mergedSummary(receipt: PacketReceipt): string {
  if (receipt.disposition.kind === 'merged') {
    return `Packet ${receipt.packetId} (${receipt.packetTitle}) merged as ${receipt.disposition.mergeCommit} at ${receipt.disposition.releasedAt}.`;
  }
  if (receipt.disposition.kind === 'pr_opened') return `Packet ${receipt.packetId} (${receipt.packetTitle}) opened pull request #${receipt.disposition.prNumber} from ${receipt.disposition.branch} at ${receipt.disposition.commit}.`;
  return `Packet ${receipt.packetId} (${receipt.packetTitle}) was discarded as ${receipt.disposition.disposition} at ${receipt.disposition.closedAt}: ${receipt.disposition.reason}`;
}

function approvalSummary(receipt: PacketReceipt): string {
  if (receipt.approvals.length === 0) {
    return `Packet ${receipt.packetId} has no recorded approval decisions.`;
  }
  const decisions = receipt.approvals.map((approval) => (
    `${approval.principal} ${approval.decision} "${approval.title}" at ${approval.at}`
  ));
  return `Packet ${receipt.packetId} approval decisions: ${decisions.join('; ')}.`;
}

function compareStored(left: StoredPacketReceipt, right: StoredPacketReceipt): number {
  return left.artifact.createdAt.localeCompare(right.artifact.createdAt)
    || left.artifact.id.localeCompare(right.artifact.id);
}

function afterCursor(stored: StoredPacketReceipt, cursor: TruthCursor | null): boolean {
  if (!cursor) return true;
  return stored.artifact.createdAt > cursor.createdAt
    || (
      stored.artifact.createdAt === cursor.createdAt
      && stored.artifact.id > cursor.artifactId
    );
}

export function resolveTruthQuery(
  query: TruthQuery,
  options: ResolveTruthQueryOptions = {},
  stores: TruthQueryStores = DEFAULT_STORES,
): TruthQueryResult {
  const limit = normalizeLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  if (query.cursor?.trim() && !cursor) {
    throw new TruthQueryError('invalid_cursor', 'cursor is invalid.');
  }

  let candidates: StoredPacketReceipt[];
  let summary: (receipt: PacketReceipt) => string = mergedSummary;
  if (query.kind === 'merged-since') {
    const repo = query.repo.trim();
    if (!repo) throw new TruthQueryError('invalid_query', 'repo is required.');
    const since = assertDate(query.since, 'since');
    candidates = stores.listReceipts().filter((stored) => (
      stored.receipt.disposition.kind === 'merged'
      && Date.parse(stored.receipt.disposition.releasedAt) >= Date.parse(since)
      && receiptMatchesRepo(stored, repo)
    ));
  } else if (query.kind === 'packet') {
    const packetId = query.packetId?.trim() ?? '';
    const issueNumber = query.issueNumber;
    if ((!packetId && issueNumber === undefined) || (packetId && issueNumber !== undefined)) {
      throw new TruthQueryError('invalid_query', 'packet queries require exactly one of packetId or issueNumber.');
    }
    if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber < 1)) {
      throw new TruthQueryError('invalid_query', 'issueNumber must be a positive integer.');
    }
    if (packetId) {
      candidates = stores.listReceipts(packetId);
    } else {
      const packetIds = packetIdsForIssue(issueNumber!, stores);
      candidates = stores.listReceipts().filter((stored) => packetIds.has(stored.receipt.packetId));
    }
  } else {
    const packetId = query.packetId.trim();
    if (!packetId) throw new TruthQueryError('invalid_query', 'packetId is required.');
    candidates = stores.listReceipts(packetId);
    summary = approvalSummary;
  }

  const filtered = candidates
    .filter((stored) => options.receiptFilter?.(stored) ?? true)
    .sort(compareStored)
    .filter((stored) => afterCursor(stored, cursor));
  const page = filtered.slice(0, limit + 1);
  const hasMore = page.length > limit;
  if (hasMore) page.pop();
  const last = page.at(-1);
  return {
    query,
    answers: page.map((stored) => ({
      summary: summary(stored.receipt),
      receipt: stored.receipt,
      receiptRaw: stored.rawReceiptJson,
      artifactId: stored.artifact.id,
    })),
    asOf: stores.now().toISOString(),
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.artifact.createdAt, artifactId: last.artifact.id })
      : null,
  };
}
