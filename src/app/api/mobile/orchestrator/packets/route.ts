export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/orchestrator/packets?repoPath=<absolute repo path> — list the
 * orchestrator packets (dispatched agents) for one repo, projected to a tiny
 * mobile-shaped payload.
 *
 * Feeds the o8-mobile "dispatched agents" pill that sits above the orchestrator
 * chat. The desktop equivalent is the repo-focus Control Room — it reads the
 * same mission state (`/api/orchestrator/state`) and the same lane registry,
 * then filters packets by repo path. This route mirrors that pipeline:
 *
 *   1. syncOrchestratorControlPlaneState() — read + reconcile mission state
 *      (same call /api/orchestrator/state makes).
 *   2. findLaneByPacket() — pull the live lane (sessionKey + worktreePath +
 *      baseBranch) for each packet, same enrichment /api/orchestrator/state
 *      does via enrichMissionWithLanes().
 *   3. Filter to packets whose repo / workspace-target path matches repoPath
 *      (matches repoOwnsCandidate in src/components/desktop/repo-focus/utils.ts).
 *   4. Map each packet → MobileOrchestratorAgent, computing per-worktree diff
 *      stats with the same git logic /api/worktrees/diff-summary uses.
 *
 * Auth is enforced centrally by middleware. Browser pairing supplies the
 * operator token; enrolled native clients use their scoped device token.
 *
 * Returns: { agents: MobileOrchestratorAgent[] }. Empty/missing repoPath, or no
 * matching packets → { agents: [] }. Never throws — failures degrade to [].
 */

import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from '@/lib/providers/child-process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { syncOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findLaneByPacket, getLaneEvents } from '@/lib/lane/registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { Lane } from '@/lib/lane/types';
import type { MobileOrchestratorAgent } from '@/lib/mobile/types';
import { isDispatchableRuntime } from '@/lib/orchestrator/runtime-capabilities';

const execFileAsync = promisify(execFile);

function normalizeRepoPath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/**
 * True when `candidate` is `repoPath` itself or a path nested inside it. Worktree
 * paths live alongside (not inside) the repo, so a packet is matched by EITHER
 * its lane repoPath OR its workspaceTargetPath — same as packetBelongsToRepo in
 * src/components/desktop/repo-focus/utils.ts.
 */
function repoOwnsCandidate(repoPath: string, candidate: string | null | undefined): boolean {
  const repo = normalizeRepoPath(repoPath);
  const target = normalizeRepoPath(candidate);
  return Boolean(repo && target && (target === repo || target.startsWith(`${repo}/`)));
}

/**
 * Packet lifecycle → the 5 mobile statuses. The orchestrator packet model has
 * more states (draft / queued / launching / idle / running / awaiting_review /
 * recovering / failed / blocked / released / archived) than the mobile pill
 * shows, so we collapse them:
 *
 *   draft, queued                 → queued
 *   launching, running, idle,     → running   (launching/recovering are
 *     recovering                              transient "in flight" states)
 *   awaiting_review               → awaiting_review
 *   released                      → merged
 *   archived, failed, blocked     → failed    (archived is not evidence of a
 *                                              merge; recovery details remain
 *                                              attached when work was preserved)
 *
 * releaseState === 'released' wins over status (a released packet may still
 * carry a stale status), matching packetVisualState() in repo-focus/utils.ts.
 */
function isHuddleLabel(value: string | null | undefined): boolean {
  return value === 'huddle' || value === 'huddle_ready';
}

function isHuddlingPacket(packet: OrchestratorPacket, lane: Lane | null): boolean {
  if (lane?.status === 'awaiting_orchestrator' && isHuddleLabel(lane.lastEventLabel)) return true;
  return packet.status === 'blocked' && isHuddleLabel(packet.lastEventLabel ?? packet.lane?.lastEventLabel);
}

function latestHuddlePlan(lane: Lane | null): string | undefined {
  if (!lane) return undefined;
  const events = getLaneEvents(lane.id, 100);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.verb !== 'agent_report' || event.payload.event !== 'huddle') continue;
    const message = event.payload.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function mapPacketStatus(packet: OrchestratorPacket, lane: Lane | null): MobileOrchestratorAgent['status'] {
  if (packet.releaseState === 'released' || packet.status === 'released') return 'merged';
  if (isHuddlingPacket(packet, lane)) return 'huddling';
  switch (packet.status) {
    case 'archived':
    case 'failed':
    case 'blocked':
      return 'failed';
    case 'awaiting_review':
      return 'awaiting_review';
    case 'launching':
    case 'running':
    case 'idle':
    case 'recovering':
      return 'running';
    case 'draft':
    case 'queued':
    default:
      return 'queued';
  }
}

/**
 * Per-worktree diff stats, comparing the dirty tree against the lane's base
 * branch. Mirrors collectDiff() in /api/worktrees/diff-summary — base-branch
 * diff layered with the dirty-tree diff, plus untracked files for the count.
 * Queued packets have no worktree → caller passes null and gets zeros.
 */
async function collectDiffStats(
  worktreePath: string | null,
  baseBranch: string | null,
): Promise<{ filesChanged: number; additions: number; deletions: number }> {
  const empty = { filesChanged: 0, additions: 0, deletions: 0 };
  if (!worktreePath || !existsSync(worktreePath)) return empty;

  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  async function runGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      windowsHide: true,
      cwd: worktreePath as string,
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    return stdout;
  }

  async function consumeNumstat(args: string[]) {
    try {
      const output = await runGit(args);
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const [addStr = '0', delStr = '0', ...rest] = line.split('\t');
        const filePath = rest.join('\t');
        if (!filePath) continue;
        files.add(filePath);
        if (addStr !== '-') additions += Number.parseInt(addStr, 10) || 0;
        if (delStr !== '-') deletions += Number.parseInt(delStr, 10) || 0;
      }
    } catch {
      // ignore individual git failures — degrade to whatever we collected
    }
  }

  if (baseBranch) await consumeNumstat(['diff', '--numstat', `${baseBranch}...HEAD`]);
  await consumeNumstat(['diff', 'HEAD', '--numstat']);

  try {
    const untracked = await runGit(['ls-files', '--others', '--exclude-standard']);
    for (const line of untracked.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  } catch {
    // ignore — untracked count is a nice-to-have
  }

  return { filesChanged: files.size, additions, deletions };
}

function packetRuntime(
  packet: OrchestratorPacket,
  lane: Lane | null,
): MobileOrchestratorAgent['runtime'] {
  const runtime = lane?.runtime ?? packet.runtime;
  return isDispatchableRuntime(runtime) ? runtime : 'unknown';
}

function packetTitle(packet: OrchestratorPacket): string {
  const title = packet.title?.trim() || packet.summary?.trim() || packet.referenceLabel?.trim();
  return title ? title.slice(0, 120) : 'Untitled packet';
}

export async function GET(req: NextRequest) {
  const repoPath = normalizeRepoPath(req.nextUrl.searchParams.get('repoPath'));

  const emptyResponse = NextResponse.json(
    { agents: [] },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );

  if (!repoPath) return emptyResponse;

  try {
    // Pass undefined so the control plane re-reads + reconciles fresh state
    // inside its own mutex — identical to /api/orchestrator/state's GET.
    const mission = await syncOrchestratorControlPlaneState();
    const packets = Array.isArray(mission.packets) ? mission.packets : [];

    // Pair each packet with its live lane up front (one registry lookup per
    // packet), then filter by repo path. The lane's repoPath is the most
    // accurate signal (it points at the actual worktree/repo); workspaceTargetPath
    // is the fallback for queued packets that have no lane yet.
    const paired = packets.map((packet) => ({
      packet,
      lane: findLaneByPacket(packet.id),
    }));

    const matched = paired.filter(({ packet, lane }) => (
      repoOwnsCandidate(repoPath, lane?.repoPath)
      || repoOwnsCandidate(repoPath, lane?.worktreePath)
      || repoOwnsCandidate(repoPath, packet.workspaceTargetPath)
    ));

    const agents = await Promise.all(
      matched.sort((a, b) => a.packet.id.localeCompare(b.packet.id)).map(async ({ packet, lane }) => {
        // Live worktree if the lane has one; queued packets resolve to null
        // → zero diff stats.
        const worktreePath = lane?.worktreePath ?? lane?.repoPath ?? null;
        const baseBranch = lane?.baseBranch ?? null;
        const diff = await collectDiffStats(worktreePath, baseBranch);

        return {
          id: packet.id,
          ...(packet.orchestratorThreadId ? { orchestratorThreadId: packet.orchestratorThreadId } : {}),
          packetStatus: packet.status,
          rejected: packet.review?.approved === false,
          ...(packet.releaseState === 'released' ? { outcome: 'merged' } : {}),
          workerLabel: packetTitle(packet),
          updatedAt: packet.releaseStatePayload?.releasedAt ?? packet.archivedAt ?? packet.lastEventAt ?? packet.lane?.lastEventAt ?? null,
          title: packetTitle(packet),
          runtime: packetRuntime(packet, lane),
          status: mapPacketStatus(packet, lane),
          branch: lane?.branch ?? packet.branchTarget ?? '',
          filesChanged: diff.filesChanged,
          additions: diff.additions,
          deletions: diff.deletions,
          huddlePlan: latestHuddlePlan(lane),
          lastEventLabel: lane?.lastEventLabel ?? packet.lastEventLabel ?? packet.lane?.lastEventLabel ?? null,
          recovery: packet.recovery ?? null,
          // Lane runtime session key only when the lane is live (findLaneByPacket
          // already excludes archived/completed/failed lanes). null otherwise.
          sessionKey: lane?.sessionKey ?? null,
        };
      }),
    );

    return NextResponse.json(
      { agents, updatedAt: mission.updatedAt },
      { headers: { 'Cache-Control': 'private, max-age=5' } },
    );
  } catch {
    console.log('[mobile-orchestrator] packet list failed');
    return emptyResponse;
  }
}
