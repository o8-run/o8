import { retireUnstartedSession } from './retire-unstarted';
import { signalBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { timestampMillis } from '@/lib/util/relative-age';
import { assertOwnedSessionProcessIdentity } from './process-identity';

import {
  archiveOwnedSessionDir,
} from './archive';
import {
  OWNED_STALE_WINDOW_MS,
  canSignalOwnedRun,
  isOwnedRunAlive,
  metadataPath,
  nowIso,
  pathExists,
  forceKillTreeWindows,
  isPidAlive,
  relativeAge,
  shortHome,
} from './helpers';
import {
  buildCurrentTask,
  buildRuntimeSurface,
  deriveOwnedStatus,
  formatChildExit,
  latestRun,
  type OwnedLifecycleContext,
} from './lifecycle';
import type { OwnedRunController } from './run-controller';
import type { OwnedSessionIo } from './session-io';
import type {
  OwnedFleetAdditions,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
} from './types';
import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  SquadSummary,
} from '@/lib/fleet/types';

export function createFleetComputer({
  adapter,
  root,
  surfacePrefix,
  runtimeId,
  squadId,
  squadName,
  lifecycleContext,
  io,
  runController,
  withSurfaceLock,
  invalidateFleetCache,
}: {
  adapter: OwnedRuntimeAdapter;
  root: string;
  surfacePrefix: string;
  runtimeId: string;
  squadId: string;
  squadName: string;
  lifecycleContext: OwnedLifecycleContext;
  io: OwnedSessionIo;
  runController: OwnedRunController;
  withSurfaceLock: <T>(surfaceId: string, fn: () => Promise<T>) => Promise<T>;
  invalidateFleetCache: () => void;
}) {
  async function computeFleetAdditions(): Promise<OwnedFleetAdditions> {
    const sessionDirs = await io.listSessionDirs();
    if (!sessionDirs.length) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
        ownedThreadIds: [],
      };
    }

    const settled = await Promise.all(
      sessionDirs.map(async (sessionDir): Promise<OwnedSessionRecord | null> => {
        try {
          const filePath = metadataPath(sessionDir);
          if (!(await pathExists(filePath))) return null;
          const session = await io.loadSession(sessionDir);
          if (session.detachedAt) return null;
          return withSurfaceLock(session.surfaceId, async () => {
            // Stop, resume or exit recording may have changed the run while
            // this inventory read waited. Never write that stale snapshot back.
            const current = await io.loadSession(sessionDir);
            if (current.detachedAt) return null;
            await runController.refreshSession(current, true);
            if (await retireUnstartedSession(runtimeId, root, sessionDir, current, io)) return null;
            return current;
          });
        } catch {
          return null;
        }
      }),
    );
    const allSessions: OwnedSessionRecord[] = settled.filter(
      (session): session is OwnedSessionRecord => session !== null,
    );

    const now = Date.now();
    const sessions = allSessions.filter((session) => {
      if (session.activeRun || session.capacityWait) return true;
      const latest = latestRun(session);
      const lastActivityStr = latest?.finishedAt ?? latest?.startedAt ?? session.updatedAt;
      const ageMs = Math.max(0, now - new Date(lastActivityStr).getTime());
      return ageMs < OWNED_STALE_WINDOW_MS;
    });

    const agents: AgentSummary[] = sessions
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => {
        const running = Boolean(session.activeRun);
        const status = deriveOwnedStatus(lifecycleContext, session);
        const runtimeSurface = buildRuntimeSurface(lifecycleContext, session, running);
        const lifecycle = runtimeSurface.lifecycle;
        const lastRun = latestRun(session);
        const activityTimestamp = lastRun?.finishedAt ?? lastRun?.startedAt ?? session.createdAt;
        const lifecycleLabel = lifecycle?.availability === 'running'
          ? 'owned active'
          : lifecycle?.lastOutcome === 'failed'
            ? 'owned failed'
            : lifecycle?.lastOutcome === 'interrupted'
              ? 'owned interrupted'
              : lifecycle?.availability === 'awaiting-thread'
                ? 'owned warming'
                : 'owned ready';
        return {
          id: session.surfaceId,
          name: session.title,
          squadId,
          runtime: runtimeId,
          model: session.model?.trim() || `${runtimeId} owned`,
          status,
          currentTask: buildCurrentTask(lifecycleContext, session, running),
          workspace: shortHome(session.repoPath),
          branch: session.branch ?? 'detached',
          sessionKey: session.surfaceId,
          approvalStatus: 'none',
          lastEventAt: relativeAge(activityTimestamp),
          lastActivityAt: timestampMillis(activityTimestamp),
          context: {
            usedPercent: 0,
            trend: running ? 'rising' : 'stable',
          },
          alerts: lifecycle?.lastOutcome === 'failed' ? 1 : 0,
          sessionId: session.threadId ?? session.surfaceId,
          identityId: session.identity?.id,
          sessionKind: 'owned-runtime',
          surfaceLabel: `${adapter.squadShortName} terminal • ${lifecycleLabel}`,
          runtimeSurface,
          tmuxSession: session.activeRun?.tmuxSession ?? lastRun?.tmuxSession,
        } satisfies AgentSummary;
      });

    const squad: SquadSummary | null = agents.length
      ? {
          id: squadId,
          name: squadName,
          status: agents.some((agent) => agent.status === 'running') ? 'healthy' : 'watching',
          throughputLabel: `${agents.length} IDE-owned surface${agents.length === 1 ? '' : 's'}`,
          blockers: 0,
          alerts: 0,
          liveSessions: agents.length,
          members: agents.map((agent) => agent.id),
        }
      : null;

    const sessionBySurfaceId = new Map(sessions.map((session) => [session.surfaceId, session]));
    const events: EventItem[] = agents.slice(0, 4).map((agent) => {
      const eventSession = sessionBySurfaceId.get(agent.id);
      const eventLastRun = eventSession ? latestRun(eventSession) : undefined;
      return {
        id: `evt-${agent.id}`,
        agentId: agent.id,
        squadId: agent.squadId,
        severity: agent.status === 'running' ? 'info' : agent.status === 'failed' ? 'critical' : agent.status === 'waiting' ? 'warning' : 'success',
        title: `${agent.name} • ${agent.surfaceLabel}`,
        detail: `${agent.currentTask}${agent.runtimeSurface?.lifecycle?.lastOutcome ? ` • last ${agent.runtimeSurface.lifecycle.lastOutcome}` : ''}${formatChildExit(eventLastRun?.childExit)}${agent.runtimeSurface?.reviewContext?.repoSlug ? ` • ${agent.runtimeSurface.reviewContext.repoSlug}` : ''}`,
        timestamp: agent.lastEventAt,
      };
    });

    const artifacts: ReviewArtifact[] = agents.slice(0, 3).map((agent) => ({
      kind: 'run_log',
      title: `${agent.name} owned tail`,
      state: agent.runtimeSurface?.lifecycle?.lastOutcome === 'failed' ? 'new' : 'reviewing',
      agentId: agent.id,
      detail: agent.runtimeSurface?.lifecycle?.lastOutcome
        ? `Readable JSON tail recovered from an IDE-owned ${adapter.squadShortName} exec/resume run. Last outcome: ${agent.runtimeSurface.lifecycle.lastOutcome}.`
        : `Readable JSON tail recovered from an IDE-owned ${adapter.squadShortName} exec/resume run.`,
    }));

    return {
      agents,
      squads: squad ? [squad] : [],
      events,
      artifacts,
      sourceLabel: `Owned ${adapter.squadShortName} launch registry`,
      note: agents.length
        ? `IDE-owned ${adapter.squadShortName} surfaces can now launch, resume between runs, and interrupt active runs. Discovered ${adapter.squadShortName} terminals remain watch-only.`
        : undefined,
      ownedThreadIds: agents.map((agent) => agent.sessionId ?? '').filter((value) => value && !value.startsWith(surfacePrefix)),
    };
  }

  function sessionLastActivityMs(session: OwnedSessionRecord): number {
    const latest = latestRun(session);
    const candidates = [latest?.finishedAt, latest?.startedAt, session.updatedAt]
      .map((value) => (value ? new Date(value).getTime() : Number.NaN))
      .filter((value) => Number.isFinite(value));
    return candidates.length > 0 ? Math.max(...candidates) : 0;
  }

  // Bounded so an un-stoppable worker cannot hold a session open forever.
  const MAX_STOP_ATTEMPTS = 3;

  async function markActiveRunOrphaned(session: OwnedSessionRecord, reason: string) {
    let activeRun = session.activeRun;
    if (!activeRun) return false;
    if (activeRun.spawnState === 'prepared') {
      await runController.reconcilePreparedRuns(session);
      activeRun = session.activeRun;
      if (activeRun?.spawnState === 'prepared') {
        console.warn(
          `[owned-store] Keeping unresolved prepared ${runtimeId} session ${session.surfaceId}; marker liveness is live or unknown.`,
        );
        return false;
      }
      return true;
    }
    // Orphan sweeps also load raw legacy records. Never archive or signal an
    // unidentified packet survivor, even when it has no current lane owner.
    await assertOwnedSessionProcessIdentity(session, runtimeId);
    const costLine = await runController.readCostLine(activeRun);
    const orphanedAt = nowIso();
    let stopFailed = false;
    let gaveUpOnLiveProcess = false;
    const inIsolatedTestContext = Boolean(process.env.O8_TEST_DATA_DIR_PINNED);
    if (!inIsolatedTestContext && await isOwnedRunAlive(activeRun)) {
      try {
        if (activeRun.tmuxSession) {
          await signalBridgeTerminalSession(activeRun.tmuxSession, 'SIGINT');
        } else {
          if (await canSignalOwnedRun(activeRun, adapter.binaryName)) {
            if (process.platform === 'win32') {
              // A failed kill must NOT return early here: the orphan record and
              // saveSession below are the only trace this session ever existed,
              // and the caller archives the directory regardless of what we
              // return. Bailing out produced an unkillable worker with no
              // record at all — worse than the bug it replaced. Instead, flag
              // it, keep the pid, and let the caller skip archiving.
              if (!await forceKillTreeWindows(activeRun.pid) && isPidAlive(activeRun.pid)) {
                // Retry a bounded number of times, then let it go. Holding the
                // session forever keeps it reported as a live run and blocks
                // resume permanently — trading a lost session for an immortal
                // one. After the bound we archive with the failure recorded, so
                // the operator sees WHY rather than nothing.
                const attempts = (activeRun.stopAttempts ?? 0) + 1;
                session.activeRun = { ...activeRun, stopAttempts: attempts };
                if (attempts < MAX_STOP_ATTEMPTS) {
                  stopFailed = true;
                  console.error(
                    `[owned-store] Could not stop ${runtimeId} pid ${activeRun.pid} (attempt ${attempts}/${MAX_STOP_ATTEMPTS}); keeping the session to retry.`,
                  );
                } else {
                  gaveUpOnLiveProcess = true;
                  console.error(
                    `[owned-store] Giving up on ${runtimeId} pid ${activeRun.pid} after ${attempts} attempts; archiving with the failure recorded.`,
                  );
                }
              }
            } else {
              process.kill(-(activeRun.processGroupId ?? activeRun.pid), 'SIGINT');
            }
          } else {
            return false;
          }
        }
      } catch (error) {
        console.warn(`[owned-store] Failed to interrupt orphaned ${runtimeId} session ${session.surfaceId}:`, error instanceof Error ? error.message : error);
      }
    }
    const stopAttempts = session.activeRun?.stopAttempts ?? 0;
    const recordedReason = gaveUpOnLiveProcess
      ? `${reason} ABANDONED: pid ${activeRun.pid} could not be stopped after ${stopAttempts} attempts and may still be running.`
      : stopAttempts > 0
        ? `${reason} The worker could not be stopped after ${stopAttempts} attempt(s) (pid ${activeRun.pid}).`
        : reason;
    session.orphanedAt = orphanedAt;
    session.orphanedReason = recordedReason;
    session.orphanedCostLine = costLine;
    session.latestSummary = costLine ? `${recordedReason} Cost: ${costLine}` : recordedReason;
    // Hold on to the pid when the stop failed — it is the only handle anything
    // has on a process that is still running.
    session.activeRun = stopFailed ? session.activeRun : undefined;
    session.recentRuns = session.recentRuns.map((run) =>
      run.id === activeRun.id
        ? stopFailed || gaveUpOnLiveProcess
          // Never stamp a clean 'interrupted' + finishedAt on a process we know
          // is still running — that is the false confirmation this whole thread
          // has been removing, and archiving it here makes the claim permanent.
          ? { ...run, interruptRequestedAt: orphanedAt }
          : { ...run, outcome: 'interrupted', interruptRequestedAt: orphanedAt, finishedAt: run.finishedAt ?? orphanedAt }
        : run,
    );
    await io.saveSession(session);
    console.warn(`[owned-store] Orphaned ${runtimeId} session ${session.surfaceId}: ${recordedReason}${costLine ? ` cost=${costLine}` : ''}`);
    return !stopFailed;
  }

  async function sweepOrphanedSessions(
    activeSurfaceIds: Set<string>,
    maxAgeMs: number,
    chatOwnedSurfaceIds: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    let archived = 0;
    for (const sessionDir of await io.listSessionDirs()) {
      try {
        if (!(await pathExists(metadataPath(sessionDir)))) continue;
        const session = await io.loadSession(sessionDir);
        if (session.detachedAt) continue;
        if (activeSurfaceIds.has(session.surfaceId)) continue;
        if (Date.now() - sessionLastActivityMs(session) < maxAgeMs) continue;
        const didArchive = await withSurfaceLock(session.surfaceId, async () => {
          if (!(await pathExists(metadataPath(sessionDir)))) return false;
          const current = await io.loadSession(sessionDir);
          if (current.detachedAt) return false;
          if (activeSurfaceIds.has(current.surfaceId)) return false;
          if (Date.now() - sessionLastActivityMs(current) < maxAgeMs) return false;
          if (current.activeRun) {
            // A chat's shared-checkout worker has no lane, but its live run belongs to that chat.
            if (chatOwnedSurfaceIds.has(current.surfaceId)) return false;
            const stopped = await markActiveRunOrphaned(current, `No lane referenced this owned ${runtimeId} session within ${Math.round(maxAgeMs / 1000)}s of launch.`);
            // Archiving renames the directory out of the scanned root, so a
            // session archived while its worker is still alive can never be
            // seen — or retried — again. Leave it in place instead.
            if (!stopped) return false;
          }
          const result = await archiveOwnedSessionDir(root, current);
          return result.archived;
        });
        if (didArchive) archived += 1;
      } catch {
        // best-effort per dir; never block startup
      }
    }
    if (archived > 0) invalidateFleetCache();
    return archived;
  }

  return {
    computeFleetAdditions,
    sweepOrphanedSessions,
  };
}
