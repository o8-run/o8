import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, notInArray } from 'drizzle-orm';
import { expireStaleApprovals, listApprovalsForContext } from '@/lib/approvals/store';
import { getDb, getSqlite, laneEvents, lanes } from '@/lib/db';
import { recordDispatchRule } from '@/lib/dispatch/rules-store';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { reportMissingArchiveEnding, resolveArchiveEnding, type ArchiveEndingOverride } from './archive-ending';
import { publishPacketTailEvent } from './packet-tail';
import { publishLaneLifecycleEvent } from './lifecycle';
import { extractLaneReviewScreenshot } from './review-screenshot';
import { isLaneTerminal, isRefusedTerminalTransition, isWorkerTerminal } from './terminal-states';
import type { Lane, LaneEvent, LaneEventActor, LaneEventVerb, LaneOwnership, LaneRuntime, LaneStatus } from './types';
import { scheduleTerminalLaneCleanup } from './terminal-lane-cleanup';
import { settleWorkspaceManifestOnTerminal } from '@/lib/workspace/manifest/terminal-release';
import { captureLaneStorageCleanup, laneOwnsWorktree, settleLaneStorageOnAssociationLoss, worktreeIsConfirmedAbsent } from './lane-storage-release';
import { getDataDir } from '@/lib/data-dir-migration';
import { resolveLaneCreationBaseCommit } from './creation-base';
import { CODEX_AUTH_RECOVERY_LANE_LABEL } from './current-auth-exit';

export {
  findLanesTouching,
  findLanesTouchingPacketDiff,
  type FindLanesTouchingOptions,
  type LaneTouch,
  type PacketDiffLaneTouches,
} from './touches';

type LaneRow = typeof lanes.$inferSelect;
type LaneEventRow = typeof laneEvents.$inferSelect;

function nowIso() {
  return new Date().toISOString();
}

function generateLaneId(): string {
  return `lane-${randomUUID().slice(0, 12)}`;
}

function generateEventId(): string {
  return `evt-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

// session_lost grace period: reconciliation runs frequently and session
// discovery has transient blind spots (runtime adapter restart, polling race,
// slow gateway). Without a grace period a healthy agent can flip to
// session_lost within seconds even though its process is still writing files
// in the worktree. Require the key to be missing for this many ms before we
// fire session_lost.
const SESSION_LOST_GRACE_MS = 90_000;
const sessionMissingSince = new Map<string, number>();
const REVIEW_SCREENSHOT_DIR = join(
  getDataDir(),
  'review-screenshots',
);
let reviewScreenshotClient: O8WebviewClient | null = null;

function isWorktreeCleanupTerminalStatus(status: LaneStatus) { return status === 'completed' || status === 'archived'; }

function getLaneDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[lane-registry] SQLite database is unavailable');
  }
  return db;
}

function mapLaneRow(row: LaneRow | undefined): Lane | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    repoPath: row.repoPath,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    runtime: row.runtime as LaneRuntime, model: row.model,
    sessionKey: row.sessionKey,
    packetId: row.packetId, prNumber: row.prNumber,
    status: row.status as LaneStatus, outcome: row.outcome as Lane['outcome'], outcomeNote: row.outcomeNote,
    ownership: row.ownership as LaneOwnership,
    writerToken: row.writerToken,
    lastHeartbeatAt: row.lastHeartbeatAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastEventAt: row.lastEventAt,
    lastEventLabel: row.lastEventLabel,
  };
}

function parseEventPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid payloads should not break lane reads.
  }
  return {};
}

function getReviewScreenshotClient() {
  reviewScreenshotClient ??= new O8WebviewClient();
  return reviewScreenshotClient;
}

function mapLaneEventRow(row: LaneEventRow): LaneEvent {
  return {
    id: row.id,
    laneId: row.laneId,
    verb: row.verb as LaneEventVerb,
    actor: row.actor as LaneEventActor,
    payload: parseEventPayload(row.payloadJson),
    timestamp: row.timestamp,
  };
}

export function appendEvent(
  laneId: string,
  verb: LaneEventVerb,
  actor: LaneEventActor,
  payload: Record<string, unknown> = {},
): LaneEvent {
  const event: LaneEvent = {
    id: generateEventId(),
    laneId,
    verb,
    actor,
    payload,
    timestamp: nowIso(),
  };

  getLaneDb().insert(laneEvents).values({
    id: event.id,
    laneId: event.laneId,
    verb: event.verb,
    actor: event.actor,
    payloadJson: JSON.stringify(event.payload),
    timestamp: event.timestamp,
  }).run();

  publishPacketTailEvent(event);
  return event;
}

function updateLaneRecord(
  laneId: string,
  updates: Partial<typeof lanes.$inferInsert>,
) {
  if (Object.keys(updates).length === 0) {
    return;
  }
  getLaneDb().update(lanes).set(updates).where(eq(lanes.id, laneId)).run();
}

function updateLaneEventPayload(
  eventId: string,
  updates: Record<string, unknown>,
) {
  if (Object.keys(updates).length === 0) {
    return;
  }

  const row = getLaneDb()
    .select()
    .from(laneEvents)
    .where(eq(laneEvents.id, eventId))
    .get();

  if (!row) {
    return;
  }

  const nextPayload = {
    ...parseEventPayload(row.payloadJson),
    ...updates,
  };

  getLaneDb()
    .update(laneEvents)
    .set({ payloadJson: JSON.stringify(nextPayload) })
    .where(eq(laneEvents.id, eventId))
    .run();
}

async function captureReviewBoundaryScreenshot(
  laneId: string,
  eventId: string,
) {
  try {
    const screenshot = await getReviewScreenshotClient().screenshot();
    // Accept any image/* — the webview MCP returns image/jpeg by default.
    // The on-disk extension follows the mime so the operator's review pane
    // can open it in any viewer.
    if (!screenshot.mimeType || !screenshot.mimeType.startsWith('image/')) {
      throw new Error(`Expected an image mime from o8 screenshot capture, received ${screenshot.mimeType ?? '(none)'}`);
    }
    const fileExt = screenshot.mimeType === 'image/jpeg' ? 'jpg'
      : screenshot.mimeType === 'image/webp' ? 'webp'
      : screenshot.mimeType === 'image/gif' ? 'gif'
      : 'png';

    const capturedAt = nowIso();
    const screenshotPath = join(REVIEW_SCREENSHOT_DIR, `${laneId}.${fileExt}`);
    const screenshotBuffer = Buffer.from(screenshot.imageBase64, 'base64');
    const payload: Record<string, unknown> = {
      reviewScreenshotMimeType: screenshot.mimeType,
      reviewScreenshotWidth: screenshot.width,
      reviewScreenshotHeight: screenshot.height,
      reviewScreenshotCapturedAt: capturedAt,
    };

    try {
      await mkdir(REVIEW_SCREENSHOT_DIR, { recursive: true });
      await writeFile(screenshotPath, screenshotBuffer);
      payload.reviewScreenshotPath = screenshotPath;
    } catch (writeError) {
      console.warn(`[lane-registry] Failed to write review screenshot file for lane ${laneId}; storing base64 in the event payload instead.`, writeError);
      payload.reviewScreenshotBase64 = screenshot.imageBase64;
    }

    updateLaneEventPayload(eventId, payload);
  } catch (error) {
    console.error(`[lane-registry] Failed to capture review screenshot for lane ${laneId}:`, error);
  }
}

function getFilteredLaneList(
  whereClause?: ReturnType<typeof and>,
): Lane[] {
  const rows = whereClause
    ? getLaneDb()
      .select()
      .from(lanes)
      .where(whereClause)
      .orderBy(asc(lanes.createdAt))
      .all()
    : getLaneDb()
      .select()
      .from(lanes)
      .orderBy(asc(lanes.createdAt))
      .all();

  return rows
    .map((row) => mapLaneRow(row)!)
    .filter((lane): lane is Lane => lane !== null);
}

export function createLane(opts: {
  repoPath: string;
  projectId?: string | null;
  branch: string;
  baseBranch?: string;
  runtime: LaneRuntime;
  label?: string;
  packetId?: string;
  ownership?: LaneOwnership;
  sessionKey?: string;
  worktreePath?: string;
  actor?: LaneEventActor;
  baseCommit?: string;
}): Lane {
  const db = getSqlite();
  const id = generateLaneId();
  const now = nowIso();
  const projectId = opts.projectId?.trim() || getActiveProjectScopeForRepoSync(opts.repoPath).projectId;
  const lane: Lane = {
    id,
    projectId,
    label: opts.label || `${opts.runtime} — ${opts.branch}`,
    repoPath: opts.repoPath,
    worktreePath: opts.worktreePath ?? null,
    branch: opts.branch,
    baseBranch: opts.baseBranch ?? 'main',
    runtime: opts.runtime, model: null,
    sessionKey: opts.sessionKey ?? null,
    packetId: opts.packetId ?? null, prNumber: null,
    status: 'idle', outcome: null, outcomeNote: null,
    ownership: opts.ownership ?? 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
    lastEventAt: null,
    lastEventLabel: null,
  };
  db.transaction(() => {
    getLaneDb().insert(lanes).values(lane).run();
    appendEvent(id, 'open_lane', opts.actor ?? 'system', {
      projectId,
      repoPath: opts.repoPath,
      branch: opts.branch,
      baseBranch: lane.baseBranch,
      baseCommit: resolveLaneCreationBaseCommit({ ...lane, baseCommit: opts.baseCommit }), baseCommitPinned: opts.baseCommit !== undefined,
      runtime: opts.runtime,
      packetId: opts.packetId ?? null,
      sessionKey: opts.sessionKey ?? null,
    });
    publishLaneLifecycleEvent(lane, null, now);
  })();

  console.log(`[lane-registry] Created lane ${id} for ${opts.repoPath} @ ${opts.branch}`);
  return lane;
}

export function getLane(laneId: string): Lane | null {
  const row = getLaneDb().select().from(lanes).where(eq(lanes.id, laneId)).get();
  return mapLaneRow(row);
}

export function listLanes(packetIds?: ReadonlySet<string>): Lane[] {
  if (packetIds?.size === 0) return [];
  return getFilteredLaneList(packetIds ? inArray(lanes.packetId, [...packetIds]) : undefined);
}

export function listActiveLanes(): Lane[] {
  return getFilteredLaneList(and(
    ne(lanes.status, 'archived'),
    ne(lanes.status, 'completed'),
  ));
}

export function listActiveLanesWithSessions(): Lane[] {
  return getFilteredLaneList(and(
    ne(lanes.status, 'archived'),
    ne(lanes.status, 'completed'),
    ne(lanes.status, 'failed'),
    isNotNull(lanes.sessionKey),
  ));
}

export function findLaneBySession(sessionKey: string): Lane | null {
  const row = getLaneDb()
    .select()
    .from(lanes)
    .where(and(
      eq(lanes.sessionKey, sessionKey),
      notInArray(lanes.status, ['archived', 'completed', 'failed']),
    ))
    .get();
  return mapLaneRow(row);
}

export function findLaneByPacket(packetId: string): Lane | null {
  const row = getLaneDb()
    .select()
    .from(lanes)
    .where(and(
      eq(lanes.packetId, packetId),
      notInArray(lanes.status, ['archived', 'completed', 'failed']),
    ))
    .get();
  return mapLaneRow(row);
}

/**
 * Like findLaneByPacket but does NOT filter by lane status. Returns the most-
 * recently-created lane for the packet — including terminal lanes (archived,
 * completed, failed). Governance READ paths (merge preview, merge dispatch,
 * review state, packet diff) must use this so a botched merge that dropped the
 * lane to a terminal state doesn't render the packet invisible to the
 * orchestrator. See #1106.
 *
 * Supervisor / reaper / agent-report callers that DEPEND on the terminal-row
 * skip continue to use findLaneByPacket — do not change those.
 */
export function findLatestLaneByPacket(packetId: string): Lane | null {
  const row = getLaneDb()
    .select()
    .from(lanes)
    .where(eq(lanes.packetId, packetId))
    .orderBy(desc(lanes.createdAt))
    .get();
  return mapLaneRow(row);
}

export function findLaneByRepoAndBranch(repoPath: string, branch: string): Lane | null {
  const row = getLaneDb()
    .select()
    .from(lanes)
    .where(and(
      eq(lanes.repoPath, repoPath),
      eq(lanes.branch, branch),
      notInArray(lanes.status, ['archived', 'completed', 'failed']),
    ))
    .get();
  return mapLaneRow(row);
}

export function updateLane(
  laneId: string,
  updates: Partial<Pick<Lane, 'status' | 'outcome' | 'outcomeNote' | 'model' | 'sessionKey' | 'worktreePath' | 'writerToken' | 'label' | 'lastHeartbeatAt' | 'lastEventAt' | 'lastEventLabel' | 'packetId' | 'prNumber' | 'branch'>>,
  actor: LaneEventActor = 'system', eventPayload: Record<string, unknown> = {},
): Lane | null {
  const db = getSqlite();
  let updatedLane: Lane | null = null;
  let previousStatus: LaneStatus | null = null;
  let statusChanged = false;
  let statusChangeEventId: string | null = null;
  let lifecycleTimestamp: string | null = null;
  let laneBeforeTerminalCleanup: (Lane & { storageAdmissionOwnerGeneration?: number }) | null = null;

  db.transaction(() => {
    const lane = getLane(laneId);
    if (!lane) {
      return;
    }

    previousStatus = lane.status;
    const now = nowIso();
    lifecycleTimestamp = now;
    const changes: Record<string, unknown> = {};
    const nextValues: Partial<typeof lanes.$inferInsert> = {};
    const updatableKeys: Array<keyof typeof updates> = [
      'status', 'outcome', 'outcomeNote', 'model',
      'sessionKey',
      'worktreePath',
      'writerToken',
      'label',
      'lastHeartbeatAt',
      'lastEventAt',
      'lastEventLabel',
      'packetId', 'prNumber', 'branch',
    ];

    for (const key of updatableKeys) {
      const value = updates[key];
      if (value === undefined || lane[key as keyof Lane] === value) continue;
      if (key === 'label' && actor !== 'user') { // #529 label is load-bearing
        console.warn(`[lane-registry] Reject label overwrite on ${laneId} from ${actor}; kept "${lane.label}"`);
        continue;
      }
      (nextValues as Record<string, unknown>)[key] = value;
      changes[key] = value;
    }

    if (Object.keys(changes).length === 0) {
      updatedLane = lane;
      return;
    }

    nextValues.updatedAt = now;
    statusChanged = nextValues.status !== undefined;
    settleLaneStorageOnAssociationLoss(lane, changes);
    if (
      statusChanged
      && typeof nextValues.status === 'string'
      && isWorktreeCleanupTerminalStatus(nextValues.status as LaneStatus)
    ) {
      laneBeforeTerminalCleanup = captureLaneStorageCleanup(lane);
    }
    updateLaneRecord(laneId, nextValues);

    if (statusChanged) {
      statusChangeEventId = appendEvent(laneId, 'status_change', actor, { status: changes.status, ...eventPayload }).id;
    } else {
      appendEvent(laneId, 'update', actor, { ...changes, ...eventPayload });
    }

    updatedLane = getLane(laneId);
  })();

  const nextLane: Lane | null = updatedLane;
  if (nextLane === null) {
    return null;
  }
  const resolvedLane = nextLane as Lane;

  if (statusChanged && previousStatus) {
    publishLaneLifecycleEvent(resolvedLane, previousStatus, lifecycleTimestamp ?? nowIso());
  }

  if (statusChanged && isLaneTerminal(resolvedLane.status)) settleWorkspaceManifestOnTerminal(resolvedLane);

  if (
    statusChanged
    && previousStatus !== 'reviewing'
    && resolvedLane.status === 'reviewing'
    && statusChangeEventId
  ) {
    void captureReviewBoundaryScreenshot(resolvedLane.id, statusChangeEventId);
  }

  const terminalCleanupLane = laneBeforeTerminalCleanup as Lane | null;
  if (
    statusChanged
    && terminalCleanupLane
    && isWorktreeCleanupTerminalStatus(resolvedLane.status)
  ) {
    scheduleTerminalLaneCleanup(terminalCleanupLane);
  }

  return resolvedLane;
}

// Terminal-state guard lives in terminal-states.ts (pure module, unit-tested).
const SILENT_EXIT_EVENT_PREFIX = 'silent_exit_';

export function derivePacketType(lane: Pick<Lane, 'label'>) {
  return lane.label.trim().split(/\s+/)[0]?.toLowerCase() || 'unknown';
}

function recordMergedLaneDispatchRules(lane: Lane) {
  try {
    const latestReview = listApprovalsForContext({ laneId: lane.id })
      .flatMap((approval) => approval.audit.filter((event) => event.type === 'orchestrator_review'))
      .sort((left, right) => right.timestamp - left.timestamp)[0];
    const reviewSummary = latestReview?.note?.trim();
    if (!reviewSummary) return;
    const findings = extractReviewFindings(reviewSummary);
    const patterns = extractReviewPatterns(reviewSummary, findings);
    for (const ruleText of [...findings.map((finding) => finding.description), ...patterns]) {
      recordDispatchRule({
        repoPath: lane.repoPath,
        packetType: derivePacketType(lane),
        ruleText,
        source: 'review',
      });
    }
  } catch (error) {
    console.error('[dispatch-rules] record failed:', error);
  }
}

export function setLaneStatus(
  laneId: string,
  status: LaneStatus,
  actor: LaneEventActor = 'system',
  eventLabel?: string, eventPayload: { reason?: string } = {},
): Lane | null {
  const existing = getLane(laneId);
  if (existing && isRefusedTerminalTransition(existing.status, status)) {
    console.warn(
      `[lane-registry] Refusing to transition lane ${laneId} from terminal state ${existing.status} → ${status} (event=${eventLabel ?? status}, actor=${actor}).`,
    );
    return existing;
  }

  const now = nowIso();
  const lane = updateLane(
    laneId,
    { status, lastEventAt: now, lastEventLabel: eventLabel ?? status },
    actor, { ...eventPayload, eventLabel: eventLabel ?? status },
  );

  if (
    lane
    && existing?.status !== 'completed'
    && lane.status === 'completed'
    && (eventLabel === 'merged' || eventLabel === 'merged_pushed')
  ) {
    recordMergedLaneDispatchRules(lane);
  }

  return lane;
}

export function attachSession(
  laneId: string,
  sessionKey: string,
  actor: LaneEventActor = 'system',
  eventPayload: Record<string, unknown> = {},
): Lane | null {
  const lane = getLane(laneId);
  if (!lane) return null;
  const now = nowIso();
  getSqlite().transaction(() => {
    updateLaneRecord(laneId, { sessionKey, updatedAt: now, lastEventAt: now, lastEventLabel: 'session_attached' });
    appendEvent(laneId, 'attach_session', actor, { ...eventPayload, sessionKey });
  })();
  return getLane(laneId);
}

export function detachSession(
  laneId: string,
  actor: LaneEventActor = 'system',
): Lane | null {
  const lane = getLane(laneId);
  if (!lane) return null;

  updateLaneRecord(laneId, {
    sessionKey: null,
    updatedAt: nowIso(),
  });

  appendEvent(laneId, 'detach_session', actor, { previousSessionKey: lane.sessionKey });
  return getLane(laneId);
}

export function getLaneEvents(laneId: string, limit = 50): LaneEvent[] {
  return getLaneDb()
    .select()
    .from(laneEvents)
    .where(eq(laneEvents.laneId, laneId))
    .orderBy(desc(laneEvents.timestamp))
    .limit(limit)
    .all()
    .map(mapLaneEventRow)
    .reverse();
}

/**
 * Count lane events of a given verb that occurred AFTER the most recent
 * `launching_session` status_change for this lane. Used by the post-rebase
 * typecheck escalation (#1108) so a packet that gets reset_packet'd and
 * dispatched again doesn't inherit retry counters from the prior session.
 *
 * Returns 0 when the lane has no launch boundary yet (events still count
 * from the lane creation timestamp in that case via the `since` floor).
 */
export function countLaneEventsByVerbSinceLastLaunch(
  laneId: string,
  verb: LaneEventVerb,
): number {
  // `launching_session` is the label set on status transitions to 'launching'
  // (see commands.ts launch_session handler) and is the closest event-stream
  // marker for "fresh session boundary on this lane". We treat the most
  // recent occurrence as the scope floor.
  const launchEvent = getLaneDb()
    .select()
    .from(laneEvents)
    .where(and(
      eq(laneEvents.laneId, laneId),
      eq(laneEvents.verb, 'status_change'),
    ))
    .orderBy(desc(laneEvents.timestamp))
    .all()
    .find((row) => parseEventPayload(row.payloadJson).status === 'launching');

  const sinceFloor = launchEvent?.timestamp;
  const rows = getLaneDb()
    .select()
    .from(laneEvents)
    .where(sinceFloor
      ? and(
        eq(laneEvents.laneId, laneId),
        eq(laneEvents.verb, verb),
        gt(laneEvents.timestamp, sinceFloor),
      )
      : and(
        eq(laneEvents.laneId, laneId),
        eq(laneEvents.verb, verb),
      ))
    .all();
  return rows.length;
}

export function getAllEvents(limit = 200): LaneEvent[] {
  return getLaneDb()
    .select()
    .from(laneEvents)
    .orderBy(desc(laneEvents.timestamp))
    .limit(limit)
    .all()
    .map(mapLaneEventRow)
    .reverse();
}

export function getLatestLaneReviewScreenshot(laneId: string, limit = 50) {
  const events = getLaneEvents(laneId, limit);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const screenshot = extractLaneReviewScreenshot(events[index]?.payload);
    if (screenshot) {
      return screenshot;
    }
  }

  return null;
}

export interface ReviewTransitionEntry {
  laneId: string;
  worktreePath: string;
}

export function reconcileLanesWithSessions(
  activeSessions: Array<{ sessionKey: string; runtimeId: string; cwd: string; branch?: string; status: string }>,
): ReviewTransitionEntry[] {
  const db = getSqlite();
  const pendingReviewCommits: ReviewTransitionEntry[] = [];

  db.transaction(() => {
    expireStaleApprovals();
    const currentLanes = listLanes();
    const sessionByKey = new Map(activeSessions.map((session) => [session.sessionKey, session]));
    const laneBySession = new Map(
      currentLanes
        .filter((lane) => lane.sessionKey)
        .map((lane) => [lane.sessionKey!, lane.id] as const),
    );

    for (const lane of currentLanes) {
      // #1282 — once a lane reaches an authoritative "work done / merge in
      // progress" status, session liveness must NOT downgrade it. A Codex
      // worker that finished but keeps emitting transcript would otherwise flip
      // `reviewing` back to `running` below (the lane reads as hung, the
      // reviewable packet never surfaces, and wait_for_mission_ready never
      // wakes). The lane status is the truth here; the session is a heuristic.
      // (`awaiting_orchestrator` — incl. the Huddle alignment turn — keeps its
      // own continue below so the warm session survives for steer_packet.)
      if (lane.runtime === 'cloud' || isWorkerTerminal(lane.status) || lane.status === 'merging') continue;

      if (lane.sessionKey) {
        const session = sessionByKey.get(lane.sessionKey);
        if (!session) {
          // Grace period: transient discovery blind spots should not fire
          // session_lost. Record when the key was first seen missing and only
          // act after SESSION_LOST_GRACE_MS has elapsed. If the key reappears
          // on a later tick the timer is cleared below.
          const firstMissingAt = sessionMissingSince.get(lane.sessionKey) ?? Date.now();
          sessionMissingSince.set(lane.sessionKey, firstMissingAt);
          const missingFor = Date.now() - firstMissingAt;
          if (missingFor < SESSION_LOST_GRACE_MS) {
            // Still within grace window — leave lane alone this tick.
            continue;
          }

          console.log('[session-lifecycle] session_lost detected', {
            laneId: lane.id,
            sessionKey: lane.sessionKey,
            status: lane.status,
            missingMs: missingFor,
          });
          sessionMissingSince.delete(lane.sessionKey);
          const nextValues: Partial<typeof lanes.$inferInsert> = {
            sessionKey: null,
            updatedAt: nowIso(),
          };
          let lifecycleTimestamp: string | null = null;

          if (lane.status === 'running' || lane.status === 'launching') {
            const now = nowIso();
            nextValues.status = 'paused';
            nextValues.lastEventAt = now;
            nextValues.lastEventLabel = 'session_lost';
            lifecycleTimestamp = now;
            appendEvent(lane.id, 'session_lost', 'system', { lostSessionKey: lane.sessionKey });
          }

          updateLaneRecord(lane.id, nextValues);
          if (nextValues.status) {
            const updatedLane = getLane(lane.id);
            if (updatedLane) {
              publishLaneLifecycleEvent(updatedLane, lane.status, lifecycleTimestamp ?? nowIso());
            }
          }
          laneBySession.delete(lane.sessionKey);
          continue;
        }

        // Session came back (or never went missing) — clear any pending grace timer.
        sessionMissingSince.delete(lane.sessionKey);
        // A lane parked for a human decision (awaiting_orchestrator, or the layer-5
        // awaiting_human give-up #1513) stays parked while its session lingers.
        if (lane.status === 'awaiting_orchestrator' || lane.status === 'awaiting_human') {
          continue;
        }
        if (
          lane.status === 'awaiting_input'
          && (lane.lastEventLabel?.startsWith(SILENT_EXIT_EVENT_PREFIX) || lane.lastEventLabel === CODEX_AUTH_RECOVERY_LANE_LABEL)
        ) {
          continue;
        }

        const nextValues: Partial<typeof lanes.$inferInsert> = {};
        let lifecycleTimestamp: string | null = null;
        if (session.status === 'running' && lane.status !== 'running') {
          const now = nowIso();
          nextValues.status = 'running';
          nextValues.lastEventAt = now;
          nextValues.lastEventLabel = 'session_running';
          lifecycleTimestamp = now;
        } else if (session.status === 'waiting' && lane.status === 'running') {
          const now = nowIso();
          nextValues.status = 'awaiting_input';
          nextValues.lastEventAt = now;
          nextValues.lastEventLabel = 'awaiting_input';
          lifecycleTimestamp = now;
        } else if (session.status === 'reviewing') {
          // A lane already in `reviewing` was skipped by the authoritative-status
          // guard above (#1282), so this only promotes a still-active lane whose
          // session just reported done — never a redundant self-write.
          const now = nowIso();
          nextValues.status = 'reviewing';
          nextValues.lastEventAt = now;
          nextValues.lastEventLabel = 'review_ready';
          lifecycleTimestamp = now;
          // #454 — Collect lanes transitioning to reviewing so the caller can
          // auto-commit any dirty worktrees after this synchronous transaction.
          const commitCwd = lane.worktreePath ?? lane.repoPath;
          if (commitCwd) {
            pendingReviewCommits.push({ laneId: lane.id, worktreePath: commitCwd });
          }
        }

        // #8 / #467 — Safety net: if a lane has been 'running' for 2+ hours with no
        // event update AND the session is not in the active sessions list, the agent
        // is likely silently dead. Only trigger when the session is actually gone —
        // a healthy agent working for hours is fine as long as the session exists.
        if (
          Object.keys(nextValues).length === 0
          && lane.status === 'running'
          && lane.lastEventAt
          && !session // session NOT in active sessions list
        ) {
          const staleMs = Date.now() - new Date(lane.lastEventAt).getTime();
          if (staleMs > 2 * 60 * 60 * 1000) {
            const now = nowIso();
            console.log(`[session-lifecycle] Stale running lane detected: ${lane.id} — no session + no activity for ${Math.round(staleMs / 60000)}m`);
            nextValues.status = 'paused';
            nextValues.lastEventAt = now;
            nextValues.lastEventLabel = 'session_stale';
            lifecycleTimestamp = now;
          }
        }

        if (Object.keys(nextValues).length > 0) {
          nextValues.updatedAt = nowIso();
          updateLaneRecord(lane.id, nextValues);
          if (nextValues.status) {
            const updatedLane = getLane(lane.id);
            if (updatedLane) {
              publishLaneLifecycleEvent(updatedLane, lane.status, lifecycleTimestamp ?? nowIso());
            }
          }
        }
        continue;
      }

      if (lane.status === 'idle' || lane.status === 'paused') {
        const match = activeSessions.find(
          (session) =>
            session.runtimeId === lane.runtime &&
            (session.cwd === lane.repoPath || session.cwd === lane.worktreePath) &&
            session.branch === lane.branch &&
            !laneBySession.has(session.sessionKey),
        );

        if (match) {
          console.log('[session-lifecycle] session reconnected', {
            laneId: lane.id,
            newSessionKey: match.sessionKey,
          });
          const now = nowIso();
          const nextStatus: LaneStatus = match.status === 'running' ? 'running' : 'paused';
          updateLaneRecord(lane.id, {
            sessionKey: match.sessionKey,
            ownership: 'attached',
            status: nextStatus,
            updatedAt: now,
            lastEventAt: now,
            lastEventLabel: 'session_discovered',
          });

          appendEvent(lane.id, 'attach_session', 'system', {
            sessionKey: match.sessionKey,
            discoveredFrom: 'reconciliation',
          });
          if (nextStatus !== lane.status) {
            const updatedLane = getLane(lane.id);
            if (updatedLane) {
              publishLaneLifecycleEvent(updatedLane, lane.status, now);
            }
          }
          laneBySession.set(match.sessionKey, lane.id);
        }
      }
    }
  })();

  return pendingReviewCommits;
}

export function archiveLane(laneId: string, actor: LaneEventActor = 'user', endingOverride?: ArchiveEndingOverride): Lane | null {
  const lane = getLane(laneId);
  if (!lane) {
    return null;
  }
  const ending = resolveArchiveEnding(lane, getLaneEvents(lane.id, 100), endingOverride);
  if (ending.contractViolation) reportMissingArchiveEnding(lane);
  // A failed cleanup keeps its live path retryable; proven absence clears the stale path.
  const updated = updateLane(laneId, {
    status: 'archived',
    ...ending.updates,
    ...(laneOwnsWorktree(lane) && !worktreeIsConfirmedAbsent(lane.worktreePath) ? {} : { worktreePath: null }),
    writerToken: null,
    lastEventAt: nowIso(),
    lastEventLabel: 'archived',
  }, actor);

  return updated;
}

export function deleteLane(laneId: string): Lane | null {
  const lane = getLane(laneId);
  if (!lane) {
    return null;
  }
  if (!worktreeIsConfirmedAbsent(lane.worktreePath)) throw new Error(`Refusing to delete lane ${laneId} before checkout removal is confirmed.`);

  getSqlite().transaction(() => {
    settleLaneStorageOnAssociationLoss(lane, { packetId: '' });
    getSqlite()
      .prepare('DELETE FROM worker_events WHERE worker_run_id IN (SELECT id FROM worker_runs WHERE lane_id = ?)')
      .run(laneId);
    getSqlite().prepare('DELETE FROM worker_runs WHERE lane_id = ?').run(laneId);
    getSqlite().prepare('DELETE FROM lane_events WHERE lane_id = ?').run(laneId);
    getSqlite().prepare('DELETE FROM lanes WHERE id = ?').run(laneId);
  })();

  return lane;
}

export function archiveCompletedLanes(): number {
  const completedLanes = listLanes().filter((lane) => lane.status === 'completed');
  for (const lane of completedLanes) {
    archiveLane(lane.id, 'system');
    appendEvent(lane.id, 'auto_archive', 'system', {});
  }
  return completedLanes.length;
}
