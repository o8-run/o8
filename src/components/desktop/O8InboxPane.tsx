'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import { composeSupervisorInboxCardCopy } from '@/lib/inbox/card-copy';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { useCorrelatedActionLatch } from '@/components/desktop/use-correlated-action-latch';
import { fireInvalidation } from '@/lib/query/use-reactive-query';
import { MaintainerThreadCard } from './o8-panel/MaintainerThreadCard';
import { MaintainerInboxHeader } from './o8-panel/MaintainerInboxHeader';
import { useMaintainerReplyChat } from './o8-panel/MaintainerReplyChat';
import { matchesInboxScope, type InboxLane, type InboxScope, type MaintainerFeed } from '@/lib/inbox/maintainer-types';
import { maintainerReplyQueue } from '@/lib/inbox/maintainer-replies';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { O8ApprovalCards } from './o8-panel/O8ApprovalCards';
import { ArchiveGlyph, ChatGlyph, FileTextGlyph, FolderGlyph, RetryGlyph, StopGlyph } from './o8-inbox-glyphs';

const KIND_LABELS: Record<SupervisorInboxItem['kind'], string> = {
  verification_failed: 'Verification Failed',
  session_lost: 'Session Lost',
  packet_missing: 'Packet Missing',
  bounded_retry_exhausted: 'Retry Exhausted',
  merge_blocked: 'Merge Blocked',
  fetch_unreachable: 'Fetch Unreachable',
  repo_misconfigured: 'Repo Misconfigured',
  launch_agent_crash_loop: 'LaunchAgent Crash Loop',
  packet_no_changes: 'Finished · No Changes',
  worker_quota_exhausted: 'Worker Quota Exhausted',
  silent_exit_verification_failed: 'Silent Exit · Verification Failed',
  silent_exit_no_work: 'Silent Exit · No Work',
  silent_exit_but_work_present: 'Silent Exit · Work Salvaged',
  no_session_binding: 'No Session Binding',
  outside_human_waiting: 'Outside Human Waiting',
  possible_loop: 'Possible Loop · Advisory',
};

const STATUS_LABELS: Record<SupervisorInboxItem['status'], string> = {
  pending: 'Pending',
  healing: 'Healing',
  self_healed: 'Self healed',
  escalated: 'Escalated',
  resolved: 'Resolved',
  human_required: 'Human required',
  dismissed: 'Dismissed',
};

const REFRESH_EVENT = 'o8:inbox-refresh';

interface RuntimeTranscriptEntry {
  id: string;
  role: string;
  text?: string;
  type?: string;
  timestampLabel?: string;
  toolName?: string;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function repoLabel(repoPath: string) {
  const parts = repoPath.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : repoPath;
}

function shortPath(pathValue: string | null) {
  if (!pathValue) return 'Unavailable';
  const parts = pathValue.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : pathValue;
}

export function O8InboxPane({ active = true, repoPath = null, repos = [] }: { active?: boolean; repoPath?: string | null; repos?: RepoRegistryEntry[] }) {
  const replyChat = useMaintainerReplyChat(active);
  const [items, setItems] = useState<SupervisorInboxItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvalLoading, setApprovalLoading] = useState(true);
  const [lane, setLane] = useState<InboxLane>('replies');
  const [scope, setScope] = useState<InboxScope>(repos.length ? 'project' : 'all');
  const [maintainer, setMaintainer] = useState<MaintainerFeed | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [maintainerError, setMaintainerError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [expandedTranscriptById, setExpandedTranscriptById] = useState<Record<string, RuntimeTranscriptEntry[]>>({});
  const [actionNoteById, setActionNoteById] = useState<Record<string, string>>({});
  const [approvalNoteById, setApprovalNoteById] = useState<Record<string, string>>({});
  const [busyApproval, setBusyApproval] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const { busy: busyIncidentId, begin: beginIncidentAction, settle: settleIncidentAction } = useCorrelatedActionLatch<string>();
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshTrailingRef = useRef(false);
  const effectiveScope = scope === 'repo' && !repoPath || scope === 'project' && !repos.length ? 'all' : scope;
  const scopedPaths = effectiveScope === 'repo' ? [repoPath!] : effectiveScope === 'project' ? repos.map((repo) => repo.localPath) : [];
  const queryString = new URLSearchParams([['includeDismissed', '1'], ['scope', 'all'], ['includeMaintainer', '1'], ...scopedPaths.map((path): [string, string] => ['maintainerRepoPath', path])]).toString();
  const queryRef = useRef(queryString); queryRef.current = queryString;
  const activeRef = useRef(active); activeRef.current = active;

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshTrailingRef.current = true;
      return refreshInFlightRef.current;
    }
    setRefreshing(true);
    const request = (async () => {
      do {
        refreshTrailingRef.current = false;
        const requestedQuery = queryRef.current;
        const [inboxResult, approvalsResult] = await Promise.allSettled([
          fetch(`/api/panel/supervisor-inbox?${requestedQuery}`, { cache: 'no-store' })
            .then(async (response) => {
              if (!response.ok) return null;
              const body = await response.json();
              return Array.isArray(body?.items) ? { items: body.items as SupervisorInboxItem[], maintainer: body.maintainer as MaintainerFeed | undefined, maintainerError: body.maintainerError as string | null } : null;
            }),
          fetch('/api/panel/approvals?status=pending&scope=all', { cache: 'no-store' })
            .then(async (response) => {
              if (!response.ok) return null;
              const body = await response.json();
              return Array.isArray(body?.approvals) ? body.approvals as ApprovalRecord[] : null;
            }),
        ]);

        if (requestedQuery !== queryRef.current) { refreshTrailingRef.current = true; continue; }
        if (inboxResult.status === 'fulfilled' && inboxResult.value) {
          setItems(inboxResult.value.items);
          if (inboxResult.value.maintainer) setMaintainer(inboxResult.value.maintainer);
          setMaintainerError(inboxResult.value.maintainerError ?? null); setRefreshError(null);
        } else setRefreshError('Inbox could not be refreshed. Previous items are still shown.');
        if (approvalsResult.status === 'fulfilled' && approvalsResult.value) { setApprovals(approvalsResult.value); setApprovalError(null); }
        else setApprovalError('Approvals could not be refreshed. Any previous approvals are still shown.');
        setLoading(false);
        setApprovalLoading(false);
      } while (refreshTrailingRef.current && activeRef.current);
    })();
    refreshInFlightRef.current = request;
    try {
      await request;
    } finally {
      if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const handleEvent = (event: Event) => {
      const queryKey = (event as CustomEvent<{ queryKey?: string[] }>).detail?.queryKey;
      if (queryKey && queryKey[0] !== 'approvals') return;
      void refresh();
    };
    window.addEventListener(REFRESH_EVENT, handleEvent);
    window.addEventListener('o8:supervisor-inbox', handleEvent);
    window.addEventListener('o8:inbox', handleEvent);
    window.addEventListener('o8:realtime', handleEvent);
    window.addEventListener('o8:lifecycle-reconcile', handleEvent);
    window.addEventListener('o8:invalidate', handleEvent);
    // Push-not-poll: supervisor + approval WS events (and REFRESH_EVENT) drive
    // live updates, so this timer is only a safety net for a dropped event.
    const interval = window.setInterval(() => { void refresh(); }, 300000);
    return () => {
      window.removeEventListener(REFRESH_EVENT, handleEvent);
      window.removeEventListener('o8:supervisor-inbox', handleEvent);
      window.removeEventListener('o8:inbox', handleEvent);
      window.removeEventListener('o8:realtime', handleEvent);
      window.removeEventListener('o8:lifecycle-reconcile', handleEvent);
      window.removeEventListener('o8:invalidate', handleEvent);
      window.clearInterval(interval);
    };
  }, [active, refresh, queryString]);

  const setActionNote = useCallback((id: string, note: string) => {
    setActionNoteById((current) => ({ ...current, [id]: note }));
    window.setTimeout(() => {
      setActionNoteById((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, 2500);
  }, []);

  const setApprovalNote = useCallback((id: string, note: string) => {
    setApprovalNoteById((current) => ({ ...current, [id]: note }));
    window.setTimeout(() => {
      setApprovalNoteById((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, 3000);
  }, []);

  const resolveApproval = useCallback(async (approval: ApprovalRecord, action: 'approve' | 'reject') => {
    setBusyApproval({ id: approval.id, action });
    setApprovalNote(approval.id, action === 'approve' ? 'Approving...' : 'Rejecting...');
    try {
      const response = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: approval.id }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string; note?: string } | null;
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `Unable to ${action} approval.`);
      }
      setApprovalNote(approval.id, payload?.note ?? (action === 'approve' ? 'Approved.' : 'Rejected.'));
      fireInvalidation('invalidate', ['approvals', 'all']);
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      await refresh();
    } catch (error) {
      setApprovalNote(approval.id, error instanceof Error ? error.message : `Unable to ${action} approval.`);
    } finally {
      setBusyApproval(null);
    }
  }, [refresh, setApprovalNote]);

  const dismiss = useCallback(async (id: string) => {
    const response = await fetch('/api/panel/supervisor-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', id }),
    });
    if (!response.ok) throw new Error('The item could not be dismissed.');
    window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
    refresh();
  }, [refresh]);

  const openTranscript = useCallback(async (item: SupervisorInboxItem) => {
    if (!item.transcriptLink) {
      setActionNote(item.id, 'No transcript for this item.');
      return;
    }
    if (expandedTranscriptById[item.id]) {
      setExpandedTranscriptById((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }
    try {
      const response = await fetch(item.transcriptLink, { cache: 'no-store' });
      if (!response.ok) throw new Error('Transcript unavailable.');
      const body = await response.json() as { transcript?: RuntimeTranscriptEntry[] };
      setExpandedTranscriptById((current) => ({
        ...current,
        [item.id]: Array.isArray(body.transcript) ? body.transcript.slice(-8) : [],
      }));
    } catch {
      setActionNote(item.id, 'Transcript could not be loaded.');
    }
  }, [expandedTranscriptById, setActionNote]);

  const openWorktree = useCallback(async (item: SupervisorInboxItem) => {
    const path = item.worktreePath ?? item.repoPath;
    if (!path) {
      setActionNote(item.id, 'No worktree path for this item.');
      return;
    }
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(path);
        setActionNote(item.id, 'Opened worktree.');
        return;
      }
      await navigator.clipboard?.writeText(path);
      setActionNote(item.id, 'Copied worktree path.');
    } catch {
      setActionNote(item.id, path);
    }
  }, [setActionNote]);

  const addToChat = useCallback((item: SupervisorInboxItem) => {
    const repoName = repoLabel(item.repoPath);
    const details = [
      `${KIND_LABELS[item.kind]} (${STATUS_LABELS[item.status]})`,
      item.packetTitle ? `Task: ${item.packetTitle}` : null,
      item.packetReferenceLabel ? `Packet: ${item.packetReferenceLabel}` : null,
      item.repeatCount > 1 ? `Repeated: ${item.repeatCount} times` : null,
      `Last seen: ${formatTimestamp(item.lastSeenAt)}`,
      `Problem: ${item.errorExcerpt}`,
      item.worktreePath ? `Worktree: ${item.worktreePath}` : null,
    ].filter(Boolean).join('\n');
    window.dispatchEvent(new CustomEvent('o8:resolve-blocker', {
      detail: {
        repoPath: item.repoPath,
        repoName,
        explanation: details,
        statusLabel: KIND_LABELS[item.kind],
      },
    }));
    // Mark escalated — heal-bot auto-resolves once the faulting packet's lane
    // merges. Flips the card out of the "awaiting you" rot into "in flight".
    void fetch('/api/panel/supervisor-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'escalate', id: item.id }),
    }).then(() => {
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      refresh();
    }).catch(() => {});
    setActionNote(item.id, 'Escalated to orchestrator.');
  }, [setActionNote, refresh]);

  // Retry launches fresh after bounded failure; Stop interrupts, holds, and dismisses.
  const retryPacket = useCallback(async (item: SupervisorInboxItem) => {
    if (!item.packetId || !beginIncidentAction(item.id)) return;
    setActionNote(item.id, 'Relaunching a fresh worker...');
    let inProgress = false;
    try {
      const requestBody = JSON.stringify({
        packetId: item.packetId,
        feedback: `Operator retried manually from the Inbox after bounded retries were exhausted. Original failure: ${item.errorExcerpt || 'see lane events.'}`,
        idempotencyKey: crypto.randomUUID(),
      });
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        result?: { note?: string; inProgress?: boolean; status?: string };
        error?: { message?: string } | string;
      }>('/api/orchestrator/rerun-with-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      const errorMessage = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
      if (!response.ok || !payload?.ok) throw new Error(errorMessage ?? 'Retry was rejected.');
      if (actionReceiptIsInProgress(response.status, payload?.result)) {
        inProgress = true;
        setActionNote(item.id, payload?.result?.note ?? 'This retry is already in progress.');
        return;
      }
      await fetch('/api/panel/supervisor-inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'escalate', id: item.id }),
      }).catch(() => {});
      setActionNote(item.id, 'Fresh worker relaunched.');
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      await refresh();
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        inProgress = true;
        setActionNote(item.id, error.message);
      } else {
        setActionNote(item.id, error instanceof Error ? error.message : 'Retry failed.');
      }
    } finally {
      settleIncidentAction(inProgress);
    }
  }, [beginIncidentAction, refresh, setActionNote, settleIncidentAction]);

  const stopPacket = useCallback(async (item: SupervisorInboxItem) => {
    if (!item.packetId || !beginIncidentAction(item.id)) return;
    const acknowledgeMissing = item.payload.recoveryAction === 'acknowledge_missing_worktree';
    setActionNote(item.id, acknowledgeMissing ? 'Acknowledging the missing worktree...' : 'Stopping the packet...');
    let inProgress = false;
    try {
      const endpoint = acknowledgeMissing ? '/api/orchestrator/discard-packet' : '/api/agent-control/action';
      const requestBody = acknowledgeMissing
        ? { packetId: item.packetId, disposition: 'wontfix', acknowledgeMissingWorktree: true, clientMutationId: crypto.randomUUID() }
        : { ref: { kind: 'packet', id: item.packetId }, action: { kind: 'terminate' }, clientMutationId: crypto.randomUUID() };
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        error?: { message?: string } | string;
        result?: { ok?: boolean; note?: string; inProgress?: boolean; status?: string };
      }>(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const errorMessage = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
      if (!response.ok || payload?.ok === false || payload?.result?.ok === false) {
        throw new Error(payload?.result?.note ?? errorMessage ?? 'Packet action was rejected.');
      }
      await fetch('/api/panel/supervisor-inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss', id: item.id }),
      }).catch(() => {});
      setActionNote(item.id, acknowledgeMissing ? 'Missing worktree acknowledged; packet discarded.' : 'Packet stopped and held.');
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      await refresh();
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        inProgress = true;
        setActionNote(item.id, error.message);
      } else {
        setActionNote(item.id, error instanceof Error ? error.message : 'Stop failed.');
      }
    } finally {
      settleIncidentAction(inProgress);
    }
  }, [beginIncidentAction, refresh, setActionNote, settleIncidentAction]);

  // Once multiple incidents become one dossier, Activity owns the operator
  // decision. Keep the immutable source rows available through the API and
  // dossier history without presenting conflicting active cards here.
  const projectPaths = repos.map((repo) => repo.localPath);
  const scoped = (paths: string[]) => matchesInboxScope(paths, effectiveScope, repoPath, projectPaths);
  const incidentItems = items.filter((item) => !item.problemDossierId && scoped(item.kind === 'outside_human_waiting'
    ? maintainer?.sources.find((source) => source.repo === String(item.payload.threadRepo ?? '').toLowerCase())?.repoPaths ?? [item.repoPath]
    : [item.repoPath]));
  const activeItems = incidentItems.filter((item) => ['human_required', 'escalated', 'pending', 'healing'].includes(item.status));
  const replies = maintainerReplyQueue(incidentItems, maintainer?.replies?.filter((item) => scoped(item.repoPaths)) ?? []);
  const agentItems = activeItems.filter((item) => item.kind !== 'outside_human_waiting');
  const history = incidentItems.filter((item) => !activeItems.includes(item));
  // Unscoped approvals remain reachable: the lane names their global count.
  const visibleApprovals = approvals;
  const contributions = maintainer?.contributions.filter((item) => scoped(item.repoPaths)) ?? [];
  const visibleItems = lane === 'replies' ? replies : lane === 'agents' ? agentItems : lane === 'history' ? history : [];
  const sources = maintainer?.sources.filter((source) => scoped(source.repoPaths)) ?? [];
  const timestamps = sources.flatMap((source) => source.lastSuccessfulAt ? [source.lastSuccessfulAt] : []);
  const lastSynced = timestamps.length === sources.length && timestamps.length ? timestamps.sort()[0] : null;
  const freshness = !sources.length ? 'GitHub replies appear after a connected repository syncs.' : !lastSynced ? 'Some repositories have not synced yet.' : `${sources.some((source) => source.stale) ? 'Cached GitHub data' : 'GitHub synced'} · ${formatTimestamp(lastSynced)}`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <MaintainerInboxHeader active={active} lane={lane} onLaneChange={setLane} scope={effectiveScope} onScopeChange={setScope} counts={{ replies: replies.length, contributions: contributions.length, approvals: visibleApprovals.length, agents: agentItems.length, history: history.length }} repoLabel={repoPath ? repoLabel(repoPath) : null} projectAvailable={repos.length > 0} freshness={freshness} onRefresh={() => { void refresh(); }} refreshing={refreshing} />

      <div style={{ flex: 1, minHeight: 0, marginBottom: replyChat.occlusion, scrollbarWidth: 'none', overflowY: 'auto', overscrollBehavior: 'contain', paddingTop: 8, paddingBottom: 12, paddingLeft: 12, paddingRight: 12 }}>
        {lane === 'approvals' && approvalLoading && approvals.length === 0 ? (
          <div style={{ paddingTop: 8, paddingRight: 4, paddingBottom: 8, paddingLeft: 4, color: 'var(--t-text-secondary)', fontSize: 12 }}>Loading approvals...</div>
        ) : null}
        {refreshError ? <div role="alert" style={{ padding: 8, fontSize: 11, lineHeight: 1.4, color: 'var(--t-warning)' }}>{refreshError}</div> : null}
        {maintainerError && (lane === 'replies' || lane === 'contributions') ? <div role="alert" style={{ padding: 8, fontSize: 11, lineHeight: 1.4, color: 'var(--t-warning)' }}>{maintainerError}</div> : null}
        {approvalError && lane === 'approvals' ? <div role="alert" style={{ padding: 8, fontSize: 11, lineHeight: 1.4, color: 'var(--t-warning)' }}>{approvalError}</div> : null}
        {lane === 'approvals' ? <div style={{ marginBottom: 8, color: 'var(--t-text-faint)', fontSize: 11 }}>Approvals across all workspaces</div> : null}
        {lane === 'approvals' ? <O8ApprovalCards
          approvals={visibleApprovals}
          busyApproval={busyApproval}
          noteById={approvalNoteById}
          onResolve={resolveApproval}
        /> : null}
        {lane === 'contributions' ? <>
          {maintainer?.truncated ? <div style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>Showing the 200 most recently updated contributions.</div> : null}
          {contributions.map((item) => <MaintainerThreadCard key={item.id} source={item} onPrepareReply={replyChat.prepare} />)}
        </> : null}
        {lane === 'replies' && maintainer?.repliesTruncated ? <div style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>Showing the 200 oldest unanswered conversations.</div> : null}
        {loading ? <div role="status" style={{ padding: 16, color: 'var(--t-text-muted)', fontSize: 12 }}>Loading inbox…</div> : !refreshError && !(maintainerError && ['replies', 'contributions'].includes(lane)) && !(approvalError && lane === 'approvals') && visibleItems.length === 0 && (lane !== 'approvals' || !visibleApprovals.length) && (lane !== 'contributions' || !contributions.length) ? (
          <div style={{ padding: 16, color: 'var(--t-text-muted)', fontSize: 12, lineHeight: 1.5 }}>
            {lane === 'replies' ? sources.length ? 'No unanswered threads in the cached GitHub conversations.' : 'Connect a GitHub repository to see conversations here.' : lane === 'contributions' ? 'No open contributions or claimed issues in this scope.' : lane === 'approvals' ? 'No pending approvals across your workspaces.' : lane === 'agents' ? 'No active agent issues in this scope.' : 'No resolved or dismissed items yet.'}
          </div>
        ) : (
          visibleItems.map((item) => {
            if (!('payload' in item) || item.kind === 'outside_human_waiting') return <MaintainerThreadCard key={item.id} source={item} onPrepareReply={replyChat.prepare} onDismiss={'payload' in item ? () => dismiss(item.id) : undefined} />;
            const verificationKind = typeof item.payload.verificationKind === 'string'
              ? item.payload.verificationKind
              : null;
            const diffStat = typeof item.payload.diffStat === 'string' ? item.payload.diffStat : null;
            const lastCommit = item.payload.lastCommit && typeof item.payload.lastCommit === 'object'
              ? item.payload.lastCommit as { subject?: string }
              : null;
            const isHumanRequired = item.status === 'human_required';
            const isEscalated = item.status === 'escalated';
            const isSelfHealed = item.status === 'self_healed';
            const isResolved = item.status === 'resolved';
            const acknowledgeMissing = item.payload.recoveryAction === 'acknowledge_missing_worktree';
            const transcriptPreview = expandedTranscriptById[item.id] ?? null;
            const actionNote = actionNoteById[item.id] ?? null;
            const copy = composeSupervisorInboxCardCopy(item);

            return (
              <article
                key={item.id}
                style={{
                  padding: '10px 12px',
                  marginBottom: 6,
                  borderRadius: 8,
                  border: '1px solid var(--t-border)',
                  background: 'var(--t-bg-card)',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 16,
                      paddingLeft: 6,
                      paddingRight: 6,
                      borderRadius: 6,
                      background: isHumanRequired
                        ? 'var(--t-warning-soft)'
                        : isEscalated
                          ? 'var(--t-accent-soft)'
                          : (isSelfHealed || isResolved)
                            ? 'var(--t-accent-soft)'
                            : 'var(--t-border)',
                      color: isHumanRequired
                        ? 'var(--t-warning)'
                        : isEscalated
                          ? 'var(--t-accent)'
                          : (isSelfHealed || isResolved)
                            ? 'var(--t-accent)'
                            : 'var(--t-text-secondary)',
                      fontSize: 9,
                      fontWeight: 300,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {KIND_LABELS[item.kind]}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--t-text-faint)' }}>
                    {STATUS_LABELS[item.status]}
                  </span>
                  {verificationKind ? (
                    <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--t-text-faint)' }}>
                      {verificationKind}
                    </span>
                  ) : null}
                  {item.repeatCount > 1 ? (
                    <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--t-text-faint)' }}>
                      x{item.repeatCount}
                    </span>
                  ) : null}
                  <span style={{ fontSize: 9, fontWeight: 260, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', marginLeft: 'auto' }}>
                    {formatTimestamp(item.lastSeenAt)}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)', marginBottom: 4, lineHeight: 1.25 }}>
                  {copy.headline}
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-faint)', marginBottom: 6 }}>
                  {copy.subline}
                </div>
                {transcriptPreview ? (
                  <div
                    style={{
                      marginBottom: 8,
                      borderRadius: 7,
                      border: '1px solid var(--t-divider-subtle)',
                      background: 'var(--t-bg-subtle)',
                      maxHeight: 170,
                      overflowY: 'auto',
                      padding: '7px 8px',
                    }}
                  >
                    {transcriptPreview.length === 0 ? (
                      <div style={{ fontSize: 10, color: 'var(--t-text-secondary)' }}>No transcript yet.</div>
                    ) : transcriptPreview.map((entry) => (
                      <div key={entry.id} style={{ marginBottom: 7 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>{entry.timestampLabel ?? entry.type ?? 'entry'}</span>
                          <span style={{ fontSize: 9, color: 'var(--t-text-secondary)' }}>{entry.toolName ?? entry.role}</span>
                        </div>
                        <div style={{ fontSize: 10, lineHeight: 1.35, color: 'var(--t-text)', whiteSpace: 'pre-wrap' }}>
                          {(entry.text ?? '').trim() || '(empty)'}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10, color: 'var(--t-text-faint)' }}>
                  <span>{repoLabel(item.repoPath)}</span>
                  <span>{shortPath(item.worktreePath ?? item.repoPath)}</span>
                  {lastCommit?.subject ? <span>{lastCommit.subject}</span> : null}
                  {diffStat ? <span>{diffStat}</span> : null}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <div style={{ minWidth: 0, flex: 1, fontSize: 10, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {actionNote}
                  </div>
                  {isHumanRequired && item.packetId ? (
                    <>
                      <InboxActionButton
                        title="Retry packet (fresh worker)"
                        onClick={() => { void retryPacket(item); }}
                        disabled={busyIncidentId !== null}
                      >
                        <RetryGlyph />
                      </InboxActionButton>
                      <InboxActionButton
                        title={acknowledgeMissing ? 'Acknowledge missing worktree and discard packet' : 'Stop packet'}
                        onClick={() => { void stopPacket(item); }}
                        disabled={busyIncidentId !== null}
                      >
                        {acknowledgeMissing ? <ArchiveGlyph /> : <StopGlyph />}
                      </InboxActionButton>
                    </>
                  ) : null}
                  <>
                      <InboxActionButton
                        title={transcriptPreview ? 'Hide transcript' : 'Preview transcript'}
                        onClick={() => { void openTranscript(item); }}
                        disabled={!item.transcriptLink}
                      >
                        <FileTextGlyph />
                      </InboxActionButton>
                      <InboxActionButton
                        title="Open worktree"
                        onClick={() => { void openWorktree(item); }}
                      >
                        <FolderGlyph />
                      </InboxActionButton>
                      <InboxActionButton
                        title="Add to orchestrator chat"
                        onClick={() => addToChat(item)}
                      >
                        <ChatGlyph />
                      </InboxActionButton>
                  </>
                  {!isSelfHealed && !isResolved ? (
                    <InboxActionButton
                      title="Dismiss"
                      onClick={() => { void dismiss(item.id).catch(() => setActionNote(item.id, 'The item could not be dismissed.')); }}
                    >
                      <ArchiveGlyph />
                    </InboxActionButton>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
      {replyChat.conversation}
    </div>
  );
}

function InboxActionButton({
  title,
  onClick,
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        // Flat per DESIGN.md §06.7 — transparent at rest, var(--t-hover) on
        // hover, no border, no bg-card chunk.
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 7,
        border: 'none',
        background: 'transparent',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: 1,
        flexShrink: 0,
        ['--o8-inbox-action-icon' as string]: disabled ? 'var(--t-text-faint, #94a3b8)' : 'var(--t-text-secondary, #64748b)',
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (!disabled) {
          event.currentTarget.style.background = 'var(--t-hover)';
          event.currentTarget.style.color = 'var(--t-text)';
          event.currentTarget.style.setProperty('--o8-inbox-action-icon', 'var(--t-text, #0f172a)');
        }
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)';
        event.currentTarget.style.setProperty('--o8-inbox-action-icon', disabled ? 'var(--t-text-faint, #94a3b8)' : 'var(--t-text-secondary, #64748b)');
      }}
    >
      {children}
    </button>
  );
}
