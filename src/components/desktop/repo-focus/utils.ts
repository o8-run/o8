'use client';

import type { OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { isPacketFailed, isPacketReleased } from '@/lib/orchestrator/packet-state';
import type { RepoFocusPacketState, RepoFocusRepo } from './types';

export const REPO_FOCUS_FONT = 'var(--font-sans-system)';
export const REPO_FOCUS_MONO = 'var(--font-mono, "SF Mono", Menlo, monospace)';

export function normalizeRepoPath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

export function repoOwnsCandidate(repoPath: string, candidate?: string | null): boolean {
  const repo = normalizeRepoPath(repoPath);
  const target = normalizeRepoPath(candidate);
  return Boolean(repo && target && (target === repo || target.startsWith(`${repo}/`)));
}

export function packetBelongsToRepo(packet: OrchestratorPacket, repoPath: string): boolean {
  return repoOwnsCandidate(repoPath, packet.lane?.repoPath ?? packet.workspaceTargetPath);
}

export function packetVisualState(packet: OrchestratorPacket): RepoFocusPacketState {
  if (isPacketReleased(packet)) return 'merged';
  if (isPacketFailed(packet)) return 'failed';
  // A reviewed-and-declined packet is its OWN state — not a fresh "review me"
  // (Q ruling 2026-07-11). A rejection lives on the review verdict, not the
  // status string, so the status can still read 'awaiting_review'/'reviewing'
  // while the verdict is a hard no. Surface it distinctly so the dot stops
  // lying about what's waiting.
  if (packet.review && packet.review.approved === false) return 'rejected';
  if (packet.status === 'awaiting_review') return 'awaiting_review';
  if (packet.status === 'running' || packet.status === 'launching' || packet.status === 'idle' || packet.status === 'recovering') {
    return 'running';
  }
  return 'queued';
}

export function packetStatusLabel(packet: OrchestratorPacket): string {
  const state = packetVisualState(packet);
  return state;
}

export function packetStatusColor(packet: OrchestratorPacket): string {
  switch (packetVisualState(packet)) {
    case 'merged':
      return 'var(--t-success)';
    case 'failed':
      // Bright red (Q ruling 2026-07-16, superseding the 2026-07-12 one-orange
      // lock): a truly failed run must read differently from a declined
      // review. Keep in sync with AgentStatusDot ACCENT + /preview/motion.
      return '#FF3B30';
    case 'rejected':
      return '#F97316';
    case 'awaiting_review':
      // Paused state — neutral grey, the sweep motion carries it (2026-07-11).
      return '#94a3b8';
    case 'running':
      return 'var(--t-accent)';
    default:
      return 'var(--t-text-muted)';
  }
}

export function runtimeFromValue(value?: string | null): OrchestratorRuntime {
  if (value === 'claude-code' || value === 'gemini' || value === 'opencode') return value;
  return 'codex';
}

export function repoSubtitle(repo: RepoFocusRepo): string {
  const remote = repo.remoteUrl ?? '';
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (match?.[1]) return match[1];
  return repo.name.includes('/') ? repo.name : repo.localPath.split('/').filter(Boolean).slice(-2).join('/');
}

export function currentBranch(repo: RepoFocusRepo): string {
  return repo.readiness?.currentBranch ?? repo.defaultBranch ?? 'main';
}

export function formatElapsed(value: string | number | null | undefined): string {
  const time = typeof value === 'number' ? value : Date.parse(value ?? '');
  if (!Number.isFinite(time)) return 'now';
  const delta = Math.max(0, Date.now() - time);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'now';
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  return `${Math.floor(delta / day)}d`;
}

const LIVE_PACKET_STATUSES = new Set([
  'launching',
  'running',
  'recovering',
  'awaiting_review',
  'blocked',
  'failed',
  'idle',
  'queued',
]);

const TERMINAL_PACKET_STATUSES = new Set(['released', 'archived', 'merged']);

/**
 * True when the packet is live work the operator should see in the
 * Control tab. Released / archived / merged packets graduate into
 * archived history and drop out of the live list.
 *
 * Failed packets count as live so the operator notices them.
 */
export function isLivePacket(packet: OrchestratorPacket): boolean {
  const release = (packet.releaseState ?? '').toLowerCase();
  if (TERMINAL_PACKET_STATUSES.has(release)) return false;
  const status = (packet.status ?? '').toLowerCase();
  if (TERMINAL_PACKET_STATUSES.has(status)) return false;
  return LIVE_PACKET_STATUSES.has(status);
}

/** Any released / archived / merged / failed packet — the per-repo
 *  archive of work that's already shipped (or stalled). Lives behind
 *  collapsed history in Control/Mission surfaces, sorted newest-first.
 *  No time cap; the operator should see every concluded packet for the repo. */
export function isConcluded(packet: OrchestratorPacket): boolean {
  const release = (packet.releaseState ?? '').toLowerCase();
  const status = (packet.status ?? '').toLowerCase();
  return TERMINAL_PACKET_STATUSES.has(release)
    || TERMINAL_PACKET_STATUSES.has(status)
    || status === 'failed';
}

/** Sort key — newest event first; missing timestamps sort last. */
export function packetEventTime(packet: OrchestratorPacket): number {
  const at = packet.lane?.lastEventAt ?? packet.lastEventAt;
  const time = typeof at === 'string' ? Date.parse(at) : Number(at);
  return Number.isFinite(time) ? time : 0;
}

/** Time since the last activity, with outcome wording for finished packets. */
export function packetTimeLabel(packet: OrchestratorPacket): string {
  const release = (packet.releaseState ?? '').toLowerCase();
  const status = (packet.status ?? '').toLowerCase();
  const at = packet.lane?.lastEventAt ?? packet.lastEventAt;
  const elapsed = formatElapsed(at);
  const activity = elapsed === 'now' ? 'now' : `${elapsed} ago`;
  const finished = elapsed === 'now' ? 'just now' : activity;
  if (release === 'released' || status === 'released' || status === 'merged') {
    return `merged ${finished}`;
  }
  if (release === 'archived' || status === 'archived') {
    return `archived ${finished}`;
  }
  if (status === 'failed') return `failed ${finished}`;
  return activity;
}

export function missionLabel(missionState: { missionId?: string; prompt?: string } | undefined): string {
  const id = missionState?.missionId?.trim();
  if (id) return id;
  const firstLine = missionState?.prompt?.split('\n').find((line) => line.trim().length > 0)?.trim();
  return firstLine ? firstLine.slice(0, 28) : 'mission';
}
