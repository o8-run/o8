import { readRegisteredIdleDrafts } from '@/lib/github-broker/idle-drafts';
import { snapshotCacheInvalidation } from '@/lib/snapshot-cache-invalidation';
import type { AgentSummary, EventSeverity } from '@/lib/fleet/types';
import {
  approvalSeverity,
  listApprovals,
  listUnsettledApprovalContinuations,
  toMobileApprovalCard,
} from '@/lib/approvals/store';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { listIdeLlmChatSessions } from '@/lib/runtime/ide-llm-chat-registry';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { isBridgeSessionAlive } from '@/lib/runtime/pty-bridge';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';
import type { MobileControlAction, MobileFleetAction, MobileFleetRuntime, MobileFleetSession, MobileFleetStatus, MobileInboxItem, MobileInboxSnapshot, MobileReviewFocus } from '@/lib/mobile/types';
import { applyInboxUrgency } from '@/lib/mobile/inbox-urgency';
import { applyInboxRefereeChips } from '@/lib/mobile/inbox-referee-chips';
import { invalidateMobileBootstrapBroker } from '@/lib/render/bootstrap';
import { getMobileSessionTranscript } from '@/lib/mobile/history';
import { buildMobileReviewUnits, shouldExposeWorkspaceReviewSnapshot, summarizeMobileReviewUnits } from '@/lib/mobile/review-units';
import {
  isDispatchableRuntime,
  ORCHESTRATOR_RUNTIMES,
} from '@/lib/orchestrator/runtime-capabilities';

function sessionActions(agent: AgentSummary): MobileControlAction[] {
  const runtimeSurface = agent.runtimeSurface;
  const canSteer = agent.runtime === 'chat' ? true : Boolean(runtimeSurface?.capabilities.sendInput);
  const canStop = Boolean(runtimeSurface?.capabilities.interrupt);
  const ownershipNote = agent.runtime === 'chat'
    ? 'This workspace LLM chat mirrors the desktop API chat tab. Mobile can read and send in this lane, but stop/interrupt is not wired here.'
    : agent.runtime === 'codex'
      ? runtimeSurface?.ownership === 'owned'
        ? 'This owned Codex surface can resume between runs and interrupt a live run when one is active.'
        : 'This discovered Codex terminal is only actionable while its live local process is still attached.'
      : 'This Claude Code surface is only actionable while the live local process is still present.';

  return [
    {
      kind: 'inspect',
      label: 'Inspect',
      sessionKey: agent.sessionKey,
      available: true,
    },
    {
      kind: 'steer',
      label: 'Steer',
      sessionKey: agent.sessionKey,
      available: canSteer,
      reasonUnavailable: canSteer ? undefined : ownershipNote,
    },
    {
      kind: 'stop',
      label: 'Stop run',
      sessionKey: agent.sessionKey,
      destructive: true,
      available: canStop,
      reasonUnavailable: canStop ? undefined : ownershipNote,
    },
    {
      kind: 'open_desktop',
      label: 'Desktop ↗',
      href: '/',
      available: true,
    },
  ];
}

function approvalActions(approval: ApprovalRecord): MobileControlAction[] {
  return [
    {
      kind: 'approve',
      label: 'Approve',
      sessionKey: approval.sessionKey,
      available: true,
    },
    {
      kind: 'deny',
      label: 'Deny',
      sessionKey: approval.sessionKey,
      available: true,
    },
    {
      kind: 'inspect',
      label: 'Inspect',
      sessionKey: approval.sessionKey,
      available: true,
    },
  ];
}

function alertSeverity(agent: AgentSummary): EventSeverity {
  if (agent.status === 'huddling') return 'info';
  if (agent.status === 'blocked' || agent.status === 'failed') return 'critical';
  if (agent.alerts > 0 || agent.context.usedPercent >= 70) return 'warning';
  if (agent.isCurrentSession) return 'success';
  return 'info';
}

function buildSessionLine(agent: AgentSummary, transcriptSnippet?: string) {
  const parts = [agent.currentTask];
  if (transcriptSnippet) parts.push(`Latest: ${transcriptSnippet}`);
  return parts.join(' • ');
}

function mobileSessionPriority(agent: AgentSummary) {
  if (agent.runtime === 'chat' && agent.isCurrentSession) return 99;
  if (agent.runtime === 'chat') return 86;
  const isOwnedCodex = agent.runtime === 'codex' && agent.runtimeSurface?.ownership === 'owned';
  if (agent.isCurrentSession) return 100;
  if (isOwnedCodex && agent.status === 'running') return 96;
  if (isOwnedCodex && agent.status === 'huddling') return 93;
  if (isOwnedCodex && agent.status === 'failed') return 94;
  if (isOwnedCodex && agent.status === 'waiting') return 92;
  if (isOwnedCodex && agent.status === 'reviewing') return 90;
  if (isOwnedCodex) return 88;
  if (agent.approvalStatus === 'pending') return 82;
  if (agent.status === 'running') return 76;
  if (agent.status === 'huddling') return 74;
  if (agent.status === 'blocked') return 72;
  if (agent.status === 'failed') return 70;
  if (agent.status === 'reviewing') return 64;
  if (agent.status === 'waiting') return 56;
  return 40;
}

function shouldExposeMobileSession(agent: AgentSummary) {
  if (agent.runtime === 'chat') {
    return Boolean(agent.isCurrentSession) || Boolean(agent.currentTask.trim());
  }

  return isDispatchableRuntime(agent.runtime);
}

async function stripDeadTerminalSessions(sessions: AgentSummary[]): Promise<AgentSummary[]> {
  return Promise.all(sessions.map(async (session) => {
    const tmuxSession = session.tmuxSession?.trim();
    if (!tmuxSession) return session;

    const alive = await isBridgeSessionAlive(tmuxSession);
    if (alive) return session;

    return {
      ...session,
      tmuxSession: undefined,
      runtimeSurface: session.runtimeSurface
        ? {
            ...session.runtimeSurface,
            capabilities: {
              ...session.runtimeSurface.capabilities,
              attach: false,
              interrupt: false,
              resize: false,
            },
          }
        : undefined,
    };
  }));
}

export function mobileSessionIdentity(agent: AgentSummary) {
  return agent.runtimeSurface?.id?.trim() || agent.sessionKey;
}

function mobileFleetRuntime(runtime: string): MobileFleetRuntime {
  if (isDispatchableRuntime(runtime) || runtime === 'openclaw' || runtime === 'hermes') {
    return runtime;
  }
  return 'unknown';
}

function mobileFleetStatus(agent: AgentSummary, approval?: ApprovalRecord): MobileFleetStatus {
  if (approval || agent.approvalStatus === 'pending') return 'awaiting_review';
  if (agent.status === 'running') return 'running';
  if (agent.status === 'huddling') return 'huddling';
  if (agent.status === 'blocked') return 'blocked';
  if (agent.status === 'failed') return 'failed';
  if (agent.status === 'waiting') return 'queued';
  if (agent.status === 'reviewing') return 'awaiting_review';
  if (agent.status === 'completed') return 'merged';

  const lifecycle = agent.runtimeSurface?.lifecycle;
  if (lifecycle?.availability === 'running') return 'running';
  if (lifecycle?.lastOutcome === 'failed') return 'failed';
  if (lifecycle?.lastOutcome === 'interrupted') return 'paused';
  if (lifecycle?.availability === 'ready-for-resume') return 'stopped';
  return 'idle';
}

function mobileFleetActions(agent: AgentSummary, approval?: ApprovalRecord): MobileFleetAction[] {
  const actions: MobileFleetAction[] = ['inspect'];
  const surface = agent.runtimeSurface;
  const previewUrl = agent.browserSurface?.url ?? surface?.browserSurface?.url;
  if (agent.tmuxSession || surface?.capabilities.attach) actions.push('open_terminal');
  if (previewUrl) actions.push('open_preview');
  if (surface?.capabilities.sendInput) actions.push('resume');
  if (surface?.capabilities.interrupt) actions.push('stop');
  if (approval) actions.push('approve', 'request_changes');
  return Array.from(new Set(actions));
}

export function toMobileFleetSession(agent: AgentSummary, approval?: ApprovalRecord): MobileFleetSession {
  const surface = agent.runtimeSurface;
  const runtime = mobileFleetRuntime(agent.runtime);
  const runtimeCapability = isDispatchableRuntime(runtime)
    ? ORCHESTRATOR_RUNTIMES[runtime]
    : null;
  const repoPath = surface?.cwd ?? agent.workspace;
  const branch = surface?.reviewContext?.branch ?? surface?.branch ?? agent.branch;
  const previewUrl = agent.browserSurface?.url ?? surface?.browserSurface?.url ?? null;
  return {
    id: mobileSessionIdentity(agent),
    sessionKey: agent.sessionKey,
    runtime,
    runtimeLabel: runtimeCapability?.label ?? agent.runtime,
    runtimeAccent: runtimeCapability?.accentColor ?? '#64748b',
    status: mobileFleetStatus(agent, approval),
    title: agent.surfaceLabel ?? surface?.title ?? agent.name,
    repo: surface?.reviewContext?.repoSlug ?? agent.workspace,
    repoPath,
    branch,
    worktreePath: surface?.cwd ?? null,
    terminalSessionName: agent.tmuxSession ?? null,
    terminalAvailable: Boolean(agent.tmuxSession || surface?.capabilities.attach),
    previewUrl,
    approvalId: approval?.id,
    reviewAuthority: approval ? 'approval_gate' : surface?.capabilities.reviewContext ? 'inspect_only' : null,
    actions: mobileFleetActions(agent, approval),
    lastEventAt: agent.lastEventAt,
    lastActivityAt: agent.lastActivityAt ?? null,
    huddlePlan: agent.huddlePlan,
  };
}

function summarizeTranscript(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function relativeMobileAge(isoLike: string | null | undefined) {
  if (!isoLike) return 'just now';
  const parsed = new Date(isoLike).getTime();
  if (Number.isNaN(parsed)) return isoLike;
  const delta = Math.max(0, Date.now() - parsed);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))}h ago`;
  return `${Math.max(1, Math.round(delta / day))}d ago`;
}

type InboxCacheLane = 'full' | 'sessions';

const inboxCache = new Map<InboxCacheLane, { snapshot: MobileInboxSnapshot; timestamp: number }>();
const inboxInflight = new Map<InboxCacheLane, { generation: number; promise: Promise<MobileInboxSnapshot> }>();
let inboxGeneration = 0;
const INBOX_CACHE_TTL = 8000;

function limitMobileInboxSessions(snapshot: MobileInboxSnapshot, limit?: number): MobileInboxSnapshot {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return snapshot;
  }
  if (snapshot.sessions.length <= limit) {
    return snapshot;
  }
  const visibleSessionKeys = new Set(snapshot.sessions.slice(0, limit).map((session) => session.sessionKey));
  return {
    ...snapshot,
    sessions: snapshot.sessions.slice(0, limit),
    fleetSessions: (snapshot.fleetSessions ?? []).filter((session) => visibleSessionKeys.has(session.sessionKey)),
  };
}

/**
 * Last step before the phone sees a snapshot: trim sessions to the requested
 * limit, then order the items by the referee's urgency score (#2440). Urgency
 * is applied outside the snapshot cache so a score that lands in the
 * background shows up on the very next poll instead of after the cache TTL.
 * Referee chips (#2439) are attached here for the same reason: the referee
 * stores its facts after the card is created.
 */
function finalizeMobileInboxSnapshot(snapshot: MobileInboxSnapshot, limit?: number): MobileInboxSnapshot {
  return applyInboxUrgency(applyInboxRefereeChips(limitMobileInboxSessions(snapshot, limit)));
}

const sharedInvalidation = snapshotCacheInvalidation('inbox');

export function invalidateInboxCache() {
  clearSnapshotCaches();
  try {
    sharedInvalidation.publish();
  } catch {
    console.warn('[snapshot-cache] Could not publish cache invalidation.');
  }
}

function clearSnapshotCaches() {
  inboxGeneration += 1;
  inboxCache.clear();
  inboxInflight.clear();
  invalidateMobileBootstrapBroker();
}

export async function getMobileInboxSnapshot(options: {
  fresh?: boolean;
  limit?: number;
  includeWorkspaceReview?: boolean;
} = {}): Promise<MobileInboxSnapshot> {
  if (sharedInvalidation.changed()) clearSnapshotCaches();
  const fresh = options.fresh ?? false;
  const includeWorkspaceReview = options.includeWorkspaceReview !== false;
  const cacheLane: InboxCacheLane = includeWorkspaceReview ? 'full' : 'sessions';
  const generation = inboxGeneration;
  const cached = inboxCache.get(cacheLane);
  if (!fresh && cached && Date.now() - cached.timestamp < INBOX_CACHE_TTL) {
    return finalizeMobileInboxSnapshot(cached.snapshot, options.limit);
  }

  const inflight = inboxInflight.get(cacheLane);
  if (!fresh && inflight && inflight.generation === generation) {
    const snapshot = await inflight.promise;
    return finalizeMobileInboxSnapshot(snapshot, options.limit);
  }

  const promise = buildMobileInboxSnapshot({ fresh, includeWorkspaceReview }).then((snapshot) => {
    if (generation === inboxGeneration) {
      inboxCache.set(cacheLane, { snapshot, timestamp: Date.now() });
    }
    return snapshot;
  });
  inboxInflight.set(cacheLane, { generation, promise });
  promise.then(
    () => {
      if (inboxInflight.get(cacheLane)?.promise === promise) inboxInflight.delete(cacheLane);
    },
    () => {
      if (inboxInflight.get(cacheLane)?.promise === promise) inboxInflight.delete(cacheLane);
    },
  );
  const snapshot = await promise;
  return finalizeMobileInboxSnapshot(snapshot, options.limit);
}

async function buildMobileInboxSnapshot(options: {
  fresh?: boolean;
  includeWorkspaceReview?: boolean;
} = {}): Promise<MobileInboxSnapshot> {
  const fresh = options.fresh ?? false;
  const includeWorkspaceReview = options.includeWorkspaceReview !== false;
  const fleet = await getRuntimeInventorySnapshot({ fresh });
  const inventorySessions = fleet.agents
    .filter(shouldExposeMobileSession)
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const priorityDiff = mobileSessionPriority(right.agent) - mobileSessionPriority(left.agent);
      return priorityDiff !== 0 ? priorityDiff : left.index - right.index;
    })
    .map(({ agent }) => agent);

  const sessions: AgentSummary[] = [];
  const seenSessionIds = new Set<string>();
  for (const agent of inventorySessions) {
    if (!shouldExposeMobileSession(agent)) continue;
    const identity = mobileSessionIdentity(agent);
    if (seenSessionIds.has(identity)) continue;
    seenSessionIds.add(identity);
    sessions.push(agent);
  }

  const workspaceChats = listIdeLlmChatSessions();
  for (const chat of workspaceChats) {
    const currentTask = chat.lastMessage ? summarizeTranscript(chat.lastMessage) : 'Start a conversation.';
    const parsedLastActivity = new Date(chat.modifiedAt ?? chat.savedAt ?? Date.now()).getTime();
    const session: AgentSummary = {
      id: chat.sessionKey,
      name: chat.label,
      squadId: 'workspace-chat',
      runtime: 'chat',
      model: chat.model || 'Workspace Chat',
      primaryModel: chat.model || 'Workspace Chat',
      status: chat.isCurrentSession ? 'running' : 'idle',
      currentTask,
      workspace: chat.repoPath || '~',
      branch: 'workspace',
      sessionKey: chat.sessionKey,
      approvalStatus: 'none',
      lastEventAt: relativeMobileAge(chat.modifiedAt ?? chat.savedAt),
      lastActivityAt: Number.isNaN(parsedLastActivity) ? Date.now() : parsedLastActivity,
      context: {
        usedPercent: 0,
        trend: 'stable',
      },
      alerts: 0,
      sessionId: chat.tabId,
      surfaceLabel: chat.label,
      isCurrentSession: chat.isCurrentSession,
      runtimeSurface: {
        id: chat.sessionKey,
        runtime: 'chat',
        kind: 'chat-session',
        ownership: 'owned',
        title: chat.label,
        cwd: chat.repoPath,
        branch: 'workspace',
        sourceLabel: 'Workspace LLM chat tab',
        capabilities: {
          attach: false,
          readTail: true,
          sendInput: true,
          interrupt: false,
          resize: false,
          diffContext: true,
          reviewContext: true,
        },
      },
    };
    if (!shouldExposeMobileSession(session)) continue;
    const identity = mobileSessionIdentity(session);
    if (seenSessionIds.has(identity)) continue;
    seenSessionIds.add(identity);
    sessions.push(session);
  }

  const pendingApprovals = [
    ...listApprovals({ status: 'pending' }),
    ...listUnsettledApprovalContinuations(),
  ];
  const approvalsBySession = new Map<string, ApprovalRecord[]>();
  for (const approval of pendingApprovals) {
    const current = approvalsBySession.get(approval.sessionKey) ?? [];
    approvalsBySession.set(approval.sessionKey, [...current, approval]);
  }
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (!approvalsBySession.has(session.sessionKey) || session.approvalStatus === 'pending') continue;
    sessions[index] = {
      ...session,
      approvalStatus: 'pending',
    };
  }

  const liveCheckedSessions = await stripDeadTerminalSessions(sessions);

  const orderedSessions = liveCheckedSessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const priorityDiff = mobileSessionPriority(right.session) - mobileSessionPriority(left.session);
      return priorityDiff !== 0 ? priorityDiff : left.index - right.index;
    })
    .map(({ session }) => session);

  const fleetSessions = orderedSessions
    .filter((session) => session.runtime !== 'chat')
    .map((session) => toMobileFleetSession(session, approvalsBySession.get(session.sessionKey)?.[0]));

  const primarySession = orderedSessions.find((session) => session.isCurrentSession)
    ?? orderedSessions.find((session) => session.sessionKey === fleet.meta.primarySessionKey)
    ?? orderedSessions.find((session) => session.status === 'running')
    ?? orderedSessions[0];

  const [reviewSnapshot, primaryTranscript] = await Promise.all([
    includeWorkspaceReview
      // Fleet events can request a fresh inbox many times per second. Session
      // truth should follow that signal, but remote PR/issue review already has
      // its own 20-second cache and must not be burst-refetched with the fleet.
      ? getWorkspaceReviewSnapshot({ fresh: false }).catch(() => null)
      : Promise.resolve(null),
    primarySession ? getMobileSessionTranscript(primarySession.sessionKey, 3, fresh).catch(() => []) : Promise.resolve([]),
  ]);

  const primarySnippet = primaryTranscript.length
    ? summarizeTranscript(primaryTranscript[primaryTranscript.length - 1]?.text ?? '')
    : '';

  const staleDrafts = includeWorkspaceReview ? await readRegisteredIdleDrafts().catch(() => ({ drafts: [], sources: [], error: 'Idle drafts could not be loaded.' })) : { drafts: [], sources: [] };
  const items: MobileInboxItem[] = staleDrafts.drafts.map(pr => ({
    id: `idle-draft:${pr.repo}:${pr.number}`, kind: 'review', severity: 'warning', title: `Idle draft #${pr.number}: ${pr.title}`,
    detail: `${pr.ageDays} days idle · checks ${pr.checks ?? 'unknown'} · conflicts with main ${pr.conflictsWithMain === null ? 'unknown' : pr.conflictsWithMain ? 'yes' : 'no'} · Continue / Handoff / Close`,
    metadata: { repo: pr.repo, number: String(pr.number), decisions: pr.decisions.join(', '), expectedHeadSha: pr.decisionSnapshot.expectedHeadSha ?? '', expectedUpdatedAt: pr.decisionSnapshot.expectedUpdatedAt },
    actions: [{ kind: 'open_desktop', label: 'Open draft', href: pr.url, available: true }],
  }));
  const reviewUnits = await buildMobileReviewUnits({
    sessions: orderedSessions,
    pendingApprovals,
    reviewSnapshot,
  });
  const reviewUnitsByApprovalId = new Map(reviewUnits
    .filter((unit) => unit.approvalId)
    .map((unit) => [unit.approvalId as string, unit]));
  const approvals = pendingApprovals.map((approval) => {
    const card = toMobileApprovalCard(approval);
    const unit = reviewUnitsByApprovalId.get(approval.id);
    if (!unit) return card;
    return {
      ...card,
      repo: unit.repo,
      repoPath: unit.repoPath,
      repoSlug: unit.repoSlug,
      branch: unit.branch,
      changedFilePaths: unit.changedFiles.map((file) => file.path),
      filesChanged: unit.fileCount,
      additions: unit.additions,
      deletions: unit.deletions,
      previewUrl: unit.previewUrl,
      terminalSessionName: unit.terminalSessionName,
      approvalId: unit.approvalId,
    };
  });

  if (primarySession) {
    items.push({
      id: `run:${primarySession.sessionKey}`,
      kind: 'run_watch',
      severity: alertSeverity(primarySession),
      title: primarySession.isCurrentSession ? 'This chat is mirrored on mobile' : `${primarySession.name} is the primary mirror`,
      detail: buildSessionLine(primarySession, primarySnippet),
      sessionKey: primarySession.sessionKey,
      timestampLabel: primarySession.lastEventAt,
      actions: sessionActions(primarySession),
    });
  }

  for (const approval of pendingApprovals) {
    items.push({
      id: `approval:${approval.id}`,
      approvalId: approval.id,
      kind: 'approval',
      severity: approvalSeverity(approval.risk),
      title: approval.title,
      detail: approval.command
        ? `${approval.description} • $ ${approval.command}`
        : approval.description,
      metadata: approval.metadata,
      sessionKey: approval.sessionKey,
      timestampLabel: relativeMobileAge(new Date(approval.createdAt).toISOString()),
      actions: approvalActions(approval),
    });
  }

  const reportItems = fleet.events
    .filter((event) => event.track === 'Agent reports' && (event.subLabel === 'blocked' || event.subLabel === 'question' || event.subLabel === 'huddle'))
    .slice(0, 3)
    .map((event): MobileInboxItem => {
      const linkedSession = orderedSessions.find((session) => session.sessionKey === event.agentId);
      const actions: MobileControlAction[] = linkedSession
        ? sessionActions(linkedSession)
        : [{ kind: 'open_desktop', label: 'Desktop ↗', href: '/', available: true }];
      const isHuddle = event.subLabel === 'huddle';
      return {
        id: `agent-report:${event.id}`,
        kind: 'alert',
        severity: isHuddle ? 'info' : event.severity,
        title: `${event.title} • ${isHuddle ? 'Huddling' : event.subLabel === 'question' ? 'Question' : 'Blocked'}`,
        detail: event.detail,
        agentStatus: isHuddle ? 'huddling' : undefined,
        metadata: isHuddle ? { status: 'huddling' } : undefined,
        sessionKey: linkedSession?.sessionKey ?? event.agentId,
        timestampLabel: relativeMobileAge(event.timestamp),
        actions,
      };
    });
  items.push(...reportItems);

  for (const agent of orderedSessions.filter((session) => session.sessionKey !== primarySession?.sessionKey)) {
    if (!['running', 'huddling', 'reviewing', 'blocked', 'failed'].includes(agent.status) && agent.alerts === 0) {
      continue;
    }

    items.push({
      id: `alert:${agent.sessionKey}`,
      kind: 'alert',
      severity: alertSeverity(agent),
      title: `${agent.name} • ${agent.surfaceLabel ?? agent.status}`,
      detail: `${agent.currentTask} • ${agent.lastEventAt}`,
      agentStatus: agent.status === 'huddling' ? 'huddling' : undefined,
      sessionKey: agent.sessionKey,
      timestampLabel: agent.lastEventAt,
      actions: sessionActions(agent),
    });

    if (items.length >= 5) {
      break;
    }
  }

  let review: MobileReviewFocus | undefined;
  const exposedReviewSnapshot = shouldExposeWorkspaceReviewSnapshot(reviewSnapshot) ? reviewSnapshot : null;
  if (exposedReviewSnapshot) {
    const leadPr = exposedReviewSnapshot.pullRequests[0];
    const changedCount = exposedReviewSnapshot.changedFiles.length;
    const issueStackLabel = exposedReviewSnapshot.activeIssues.length
      ? ` • ${exposedReviewSnapshot.activeIssues.map((issue) => `#${issue.number}`).join(' • ')}`
      : '';

    items.push({
      id: `review:${exposedReviewSnapshot.branch}`,
      kind: 'review',
      severity: exposedReviewSnapshot.dirty ? 'warning' : 'info',
      title: leadPr
        ? `Review ready • PR #${leadPr.number}`
        : `Review surface • ${exposedReviewSnapshot.branch}`,
      detail: leadPr
        ? `${leadPr.title} • ${changedCount} changed file${changedCount === 1 ? '' : 's'}${issueStackLabel}`
        : `${exposedReviewSnapshot.branch} • ${changedCount} changed file${changedCount === 1 ? '' : 's'}${issueStackLabel}`,
      timestampLabel: 'desktop review',
      actions: [
        {
          kind: 'open_review',
          label: 'Review stack ↗',
          href: '/#workflow-review-panel',
          available: true,
        },
        {
          kind: 'open_desktop',
          label: leadPr ? 'GitHub PR ↗' : 'Desktop ↗',
          href: leadPr?.url ?? '/',
          available: true,
        },
      ],
    });

    review = {
      repoSlug: exposedReviewSnapshot.repoSlug,
      branch: exposedReviewSnapshot.branch,
      desktopHref: '/#workflow-review-panel',
      pullRequest: leadPr,
      issues: exposedReviewSnapshot.activeIssues,
      changedFiles: exposedReviewSnapshot.changedFiles,
      diffStat: exposedReviewSnapshot.diffStat,
    };
  }

  const alerts = items.filter((item) => item.kind === 'alert' && item.severity !== 'info').length;
  const approvalCount = pendingApprovals.length;
  const { reviewItems, inspectOnlyReviews } = summarizeMobileReviewUnits(reviewUnits);
  const activeRuns = orderedSessions.filter((agent) => ['running', 'huddling', 'reviewing', 'blocked', 'waiting', 'failed'].includes(agent.status)).length;

  return {
    generatedAt: new Date().toISOString(),
    staleDrafts,
    mode: fleet.meta.mode,
    sourceLabel: fleet.meta.sourceLabel,
    primarySessionKey: primarySession?.sessionKey,
    note: fleet.meta.mode === 'live'
      ? 'Mobile reflects every dispatchable local runtime, plus IDE chat and review state.'
      : fleet.meta.note,
    sessions: orderedSessions,
    fleetSessions,
    approvals,
    reviewUnits,
    items,
    summary: {
      alerts,
      approvals: approvalCount,
      reviewItems,
      inspectOnlyReviews,
      activeRuns,
    },
    review,
  };
}
