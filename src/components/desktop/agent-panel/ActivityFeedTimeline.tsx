'use client';

import { memo, type ReactNode } from 'react';
import { PrStackSummary } from './PrStackSummary';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitCommit,
  GitPullRequest,
  MessageSquare,
  PlayCircle,
  XCircle,
  Zap,
} from '../lucide-shims';
import {
  BlueGlassActionButton,
  BlueGlassHoverCard,
  BlueGlassMetricPill,
  BlueGlassSparklineLane,
} from '../BlueGlassHoverCard';
import {
  activityItemKey,
  mergeRiskLabel,
  severityColor,
  shortRepoLabel,
} from './shared';
import type {
  ActivityItem,
  AgentDetail,
  CIHoverDetail,
  FeedFilter,
  PRHoverDetail,
  RepoTaskLaunchRequest,
} from './types';
import { packetRuntimeModelDisplayLabel } from '@/lib/orchestrator/display';
import type { ActivityPrHoverStatus } from './useActivityPrHoverDetail';
import type { ActivityCiHoverStatus } from './useActivityCiHoverDetail';

const FEED_ICON: Record<string, { icon: ReactNode; bg: string; color: string }> = {
  commit: { icon: <GitCommit size={11} strokeWidth={2} />, bg: 'rgba(34,197,94,0.08)', color: '#22c55e' },
  issue: { icon: <AlertCircle size={11} strokeWidth={2} />, bg: 'rgba(139,92,246,0.08)', color: '#8b5cf6' },
  pr: { icon: <GitPullRequest size={11} strokeWidth={2} />, bg: 'rgba(37,99,235,0.08)', color: '#2563eb' },
  ci_success: { icon: <CheckCircle2 size={11} strokeWidth={2} />, bg: 'rgba(34,197,94,0.08)', color: '#22c55e' },
  ci_failure: { icon: <XCircle size={11} strokeWidth={2} />, bg: 'rgba(239,68,68,0.08)', color: '#ef4444' },
  ci_pending: { icon: <Clock size={11} strokeWidth={2} />, bg: 'rgba(245,158,11,0.08)', color: '#f59e0b' },
  event: { icon: <Zap size={11} strokeWidth={2} />, bg: 'rgba(100,116,139,0.08)', color: '#64748b' },
};

function feedIcon(item: ActivityItem) {
  if (item.kind === 'ci') {
    if (item.conclusion === 'success') return FEED_ICON.ci_success;
    if (item.conclusion === 'failure') return FEED_ICON.ci_failure;
    return FEED_ICON.ci_pending;
  }
  if (item.kind === 'event') {
    const color = severityColor[item.data.severity] ?? '#64748b';
    return { icon: <Zap size={11} strokeWidth={2} />, bg: `${color}10`, color };
  }
  return FEED_ICON[item.kind] ?? FEED_ICON.event;
}

function activityItemTitle(item: ActivityItem) {
  if (item.kind === 'commit') return item.message;
  if (item.kind === 'event') return item.data.title;
  if (item.kind === 'issue') return `#${item.number} ${item.title}`;
  if (item.kind === 'pr') return `#${item.number} ${item.title}`;
  if (item.kind === 'packet') return item.packet.title;
  return item.title;
}

function activityItemEyebrow(item: ActivityItem) {
  if (item.kind === 'commit') return 'Commit';
  if (item.kind === 'pr') return 'Pull Request';
  if (item.kind === 'ci') return 'CI Run';
  if (item.kind === 'issue') return 'Issue';
  if (item.kind === 'packet') return 'Packet';
  if (item.kind === 'event' && item.data.track) return item.data.track;
  return 'Activity';
}

function activityItemSubtitle(item: ActivityItem, agentForEvent: AgentDetail | null) {
  if (item.kind === 'pr') return `${item.author} • ${item.branch}`;
  if (item.kind === 'ci') return `${item.workflow} • ${item.branch}`;
  if (item.kind === 'issue') return `${item.author} opened this in ${shortRepoLabel(item.repo)}`;
  if (item.kind === 'commit') return `${shortRepoLabel(item.repo)} • ${item.hash}`;
  if (item.kind === 'packet') return `${packetRuntimeModelDisplayLabel(item.packet)} • ${item.packet.status}`;
  return agentForEvent ? `${agentForEvent.name} • ${agentForEvent.model}` : item.data.timestamp;
}

interface ActivityFeedTimelineProps {
  grouped: Array<{ label: string; items: ActivityItem[] }>;
  filteredLength: number;
  filter: FeedFilter;
  repoLabel: string;
  items: ActivityItem[];
  agents: AgentDetail[];
  hoveredItemKey: string | null;
  hoveredItemRect: DOMRect | null;
  prHoverDetails: Record<string, PRHoverDetail>;
  prHoverStatus: ActivityPrHoverStatus;
  ciHoverDetails: Record<string, CIHoverDetail>;
  ciHoverStatus: ActivityCiHoverStatus;
  commitStack: Array<Extract<ActivityItem, { kind: 'commit' }>>;
  onOpenHoverCard: (key: string, rect: DOMRect) => void;
  onUpdateHoveredRect: (rect: DOMRect) => void;
  onScheduleHoverClose: () => void;
  onCancelHoverClose: () => void;
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onLaunchTask?: (request: RepoTaskLaunchRequest) => void;
}

export const ActivityFeedTimeline = memo(function ActivityFeedTimeline({
  grouped,
  filteredLength,
  filter,
  repoLabel,
  items,
  agents,
  hoveredItemKey,
  hoveredItemRect,
  prHoverDetails,
  prHoverStatus,
  ciHoverDetails,
  ciHoverStatus,
  commitStack,
  onOpenHoverCard,
  onUpdateHoveredRect,
  onScheduleHoverClose,
  onCancelHoverClose,
  onSelectSession,
  onSelectIssue,
  onSelectCommit,
  onSelectPR,
  onReviewPR,
  onLaunchTask,
}: ActivityFeedTimelineProps) {
  if (filteredLength === 0) {
    return (
      <div
        style={{
          padding: '16px 14px',
          fontSize: 14,
          fontWeight: 400,
          color: 'var(--t-text-muted)',
          textAlign: 'center',
          lineHeight: '19px',
          letterSpacing: 0,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {`${filter === 'all' ? 'Activity' : filter.charAt(0).toUpperCase() + filter.slice(1)} activity will appear here as ${repoLabel} work lands.`}
      </div>
    );
  }

  return (
    <>
      {grouped.map((group) => (
        <div key={group.label}>
          <div
            style={{
              padding: '6px 14px 3px',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              position: 'relative',
              zIndex: 1,
            }}
          >
            {group.label}
          </div>
          {group.items.map((item) => {
            const icon = feedIcon(item);
            const key = activityItemKey(item);
            const clickable = (item.kind === 'commit' && !!onSelectCommit) || item.kind === 'issue' || item.kind === 'ci';
            const agentForEvent = item.kind === 'event'
              ? agents.find((agent) => agent.id === item.data.agentId) ?? null
              : null;
            const prDetail = item.kind === 'pr' ? prHoverDetails[key] ?? null : null;
            const ciDetail = item.kind === 'ci' ? ciHoverDetails[key] ?? null : null;
            const mergeRisk = item.kind === 'pr' ? mergeRiskLabel(prDetail) : null;
            const handleClick = () => {
              if (item.kind === 'commit') {
                onSelectCommit?.(item.hash, item.repo ? { repo: item.repo } : undefined);
                return;
              }
              if (item.kind === 'issue' && onSelectIssue) {
                onSelectIssue(item.number, item.repo);
                return;
              }
              if (item.kind === 'issue') {
                openExternalUrl(`https://github.com/${item.repo}/issues/${item.number}`);
                return;
              }
              if (item.kind === 'ci') {
                openExternalUrl(`https://github.com/${item.repo}/actions/runs/${item.id}`);
              }
            };

            return (
              <div
                key={key}
                onClick={clickable ? handleClick : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '7px 14px',
                  position: 'relative',
                  cursor: clickable ? 'pointer' : 'default',
                  transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(event) => {
                  onOpenHoverCard(key, (event.currentTarget as HTMLDivElement).getBoundingClientRect());
                  if (clickable) {
                    (event.currentTarget as HTMLDivElement).style.background = 'rgba(37,99,235,0.04)';
                  }
                }}
                onMouseMove={(event) => {
                  if (hoveredItemKey === key) {
                    onUpdateHoveredRect((event.currentTarget as HTMLDivElement).getBoundingClientRect());
                  }
                }}
                onMouseLeave={(event) => {
                  onScheduleHoverClose();
                  if (clickable) {
                    (event.currentTarget as HTMLDivElement).style.background = 'transparent';
                  }
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: icon.bg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 1,
                    color: icon.color,
                  }}
                >
                  {icon.icon}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      color: 'var(--t-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      lineHeight: '19px',
                      fontWeight: 400,
                    }}
                  >
                    {activityItemTitle(item)}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 1,
                      fontSize: 12,
                      fontWeight: 400,
                      color: 'var(--t-text-muted)',
                      fontFamily: 'var(--font-sans-system)',
                      lineHeight: '16px',
                    }}
                  >
                    {item.kind === 'commit' ? (
                      <>
                        <span style={{ color: 'var(--t-text-secondary)' }}>{item.hash}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.age}</span>
                      </>
                    ) : item.kind === 'pr' ? (
                      <>
                        <span style={{ color: '#22c55e' }}>+{item.additions}</span>
                        <span style={{ color: '#ef4444' }}>-{item.deletions}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.branch}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.age}</span>
                      </>
                    ) : item.kind === 'ci' ? (
                      <>
                        <span>{item.workflow}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.branch}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span
                          style={{
                            color: item.conclusion === 'success' ? '#22c55e' : item.conclusion === 'failure' ? '#ef4444' : '#f59e0b',
                            fontWeight: 400,
                          }}
                        >
                          {item.conclusion || item.status}
                        </span>
                      </>
                    ) : item.kind === 'issue' ? (
                      <>
                        {item.labels.slice(0, 2).map((label) => (
                          <span
                            key={label.name}
                            style={{
                              padding: '0 4px',
                              borderRadius: 4,
                              background: `#${label.color}18`,
                              color: `#${label.color}`,
                              fontSize: 11,
                              fontWeight: 600,
                              fontFamily: 'var(--font-sans-system)',
                            }}
                          >
                            {label.name}
                          </span>
                        ))}
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.age}</span>
                      </>
                    ) : item.kind === 'event' ? (
                      <>
                        {item.data.subLabel ? (
                          <>
                            <span>{item.data.subLabel}</span>
                            <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                          </>
                        ) : null}
                        <span>{item.data.timestamp}</span>
                      </>
                    ) : (
                      <span>{packetRuntimeModelDisplayLabel(item.packet)}</span>
                    )}
                  </div>
                </div>

                {item.kind === 'pr' && item.state ? (
                  <span
                    style={{
                      padding: '1px 6px',
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      flexShrink: 0,
                      marginTop: 2,
                      background: item.state === 'merged' ? 'rgba(139,92,246,0.1)' : item.state === 'open' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                      color: item.state === 'merged' ? '#8b5cf6' : item.state === 'open' ? '#22c55e' : '#ef4444',
                      textTransform: 'uppercase',
                      fontFamily: 'var(--font-sans-system)',
                    }}
                  >
                    {item.state}
                  </span>
                ) : null}
                {item.kind === 'issue' ? (
                  <button
                    type="button"
                    title={`Launch agent on #${item.number}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onLaunchTask?.({ kind: 'issue', repo: item.repo, number: item.number, title: item.title, body: item.body });
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--t-text-muted)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      padding: 0,
                      transition: 'color 120ms, background 120ms',
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.color = '#2563eb';
                      event.currentTarget.style.background = 'rgba(37,99,235,0.08)';
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.color = 'var(--t-text-muted)';
                      event.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <PlayCircle size={13} strokeWidth={2} />
                  </button>
                ) : null}
                {item.kind === 'issue' && item.state ? (
                  <span
                    style={{
                      padding: '1px 6px',
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      flexShrink: 0,
                      marginTop: 2,
                      background: item.state === 'open' ? 'rgba(34,197,94,0.1)' : 'rgba(139,92,246,0.1)',
                      color: item.state === 'open' ? '#22c55e' : '#8b5cf6',
                      textTransform: 'uppercase',
                      fontFamily: 'var(--font-sans-system)',
                    }}
                  >
                    {item.state}
                  </span>
                ) : null}

                {hoveredItemKey === key ? (
                  <BlueGlassHoverCard
                    eyebrow={activityItemEyebrow(item)}
                    title={activityItemTitle(item)}
                    subtitle={activityItemSubtitle(item, agentForEvent)}
                    anchorRect={hoveredItemRect}
                    interactive
                    onMouseEnter={onCancelHoverClose}
                    onMouseLeave={onScheduleHoverClose}
                    footer={item.kind === 'pr' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="State" value={mergeRisk?.label ?? 'reviewing'} color={mergeRisk?.color ?? '#64748b'} />
                          <BlueGlassMetricPill label="Checks" value={`${item.checkSummary?.failed ?? 0} fail · ${item.checkSummary?.pending ?? 0} pending`} color={item.checkSummary?.failed ? '#dc2626' : item.checkSummary?.pending ? '#d97706' : '#1d4ed8'} />
                          <BlueGlassMetricPill label="Files" value={String(item.changedFiles)} color="var(--t-text)" />
                        </div>
                        {prDetail?.stack ? <PrStackSummary observation={prDetail.stack} prNumber={item.number} retained={Boolean(prHoverStatus.error)}
                          onSelect={onSelectPR ? number => onSelectPR(number, item.repo) : undefined} /> : null}
                        <div role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                          {prHoverStatus.isFetching ? (prDetail ? 'Refreshing PR details…' : 'Loading PR details…') : null}
                          {prHoverStatus.error ? `PR details delayed: ${prHoverStatus.error}. ` : null}
                          {prHoverStatus.error && prDetail && prHoverStatus.ageSeconds !== null
                            ? `Showing last known details (${prHoverStatus.ageSeconds}s old). ` : null}
                          <button type="button" onClick={() => { void prHoverStatus.retry(); }} style={{
                            border: 0, padding: 0, background: 'transparent', color: 'var(--t-accent)', cursor: 'pointer', font: 'inherit',
                          }}>Retry PR details</button>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {onLaunchTask ? (
                            <BlueGlassActionButton
                              icon={<PlayCircle size={12} strokeWidth={2} />}
                              label="Launch review"
                              onClick={() => onLaunchTask({ kind: 'pr', repo: item.repo, number: item.number, title: item.title, branch: item.branch })}
                            />
                          ) : null}
                          {onReviewPR ? (
                            <BlueGlassActionButton
                              icon={<GitPullRequest size={12} strokeWidth={2} />}
                              label="Review"
                              onClick={() => onReviewPR(item.number, item.repo)}
                            />
                          ) : null}
                          {onSelectPR ? (
                            <BlueGlassActionButton
                              icon={<ArrowRight size={12} strokeWidth={2} />}
                              label="Open full PR"
                              onClick={() => onSelectPR(item.number, item.repo)}
                            />
                          ) : null}
                          <BlueGlassActionButton
                            icon={<ExternalLink size={12} strokeWidth={2} />}
                            label="Open on GitHub"
                            onClick={() => openExternalUrl(`https://github.com/${item.repo}/pull/${item.number}`)}
                          />
                        </div>
                      </>
                    ) : item.kind === 'ci' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="Result" value={item.conclusion || item.status} color={item.conclusion === 'success' ? '#16a34a' : item.conclusion === 'failure' ? '#dc2626' : '#d97706'} />
                          <BlueGlassMetricPill label="Age" value={item.age} color="var(--t-text)" />
                        </div>
                        <div role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                          {ciHoverStatus.isFetching ? (ciDetail ? 'Refreshing CI details…' : 'Loading CI details…') : null}
                          {ciHoverStatus.error ? `CI details delayed: ${ciHoverStatus.error}. ` : null}
                          {ciHoverStatus.error && ciDetail && ciHoverStatus.ageSeconds !== null
                            ? `Showing last known details (${ciHoverStatus.ageSeconds}s old). ` : null}
                          <button type="button" onClick={() => { void ciHoverStatus.retry(); }} style={{
                            border: 0, padding: 0, background: 'transparent', color: 'var(--t-accent)', cursor: 'pointer', font: 'inherit',
                          }}>Retry CI details</button>
                        </div>
                        <BlueGlassActionButton
                          icon={<ExternalLink size={12} strokeWidth={2} />}
                          label="Open Run"
                          onClick={() => openExternalUrl(`https://github.com/${item.repo}/actions/runs/${item.id}`)}
                        />
                      </>
                    ) : item.kind === 'commit' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="Hash" value={item.hash} color="#1d4ed8" />
                          <BlueGlassMetricPill label="Age" value={item.age} color="var(--t-text)" />
                        </div>
                        {onSelectCommit ? (
                          <BlueGlassActionButton
                            icon={<GitCommit size={12} strokeWidth={2} />}
                            label="Open in Changes"
                            onClick={() => onSelectCommit(item.hash, item.repo ? { repo: item.repo } : undefined)}
                          />
                        ) : null}
                      </>
                    ) : item.kind === 'issue' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="Comments" value={String(item.comments)} color="#1d4ed8" />
                          <BlueGlassMetricPill label="Owner" value={item.assignees[0] ?? 'unassigned'} color={item.assignees[0] ? 'var(--t-text)' : '#d97706'} />
                          <BlueGlassMetricPill label="Age" value={item.age} color="var(--t-text)" />
                        </div>
                        <BlueGlassActionButton
                          icon={<PlayCircle size={12} strokeWidth={2} />}
                          label="Launch agent"
                          onClick={() => onLaunchTask?.({ kind: 'issue', repo: item.repo, number: item.number, title: item.title, body: item.body })}
                        />
                        <BlueGlassActionButton
                          icon={<ExternalLink size={12} strokeWidth={2} />}
                          label="Open Issue"
                          onClick={() => openExternalUrl(`https://github.com/${item.repo}/issues/${item.number}`)}
                        />
                      </>
                    ) : item.kind === 'event' ? (
                      <>
                        <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{item.data.severity}</div>
                        {agentForEvent?.sessionKey && onSelectSession ? (
                          <BlueGlassActionButton
                            icon={<MessageSquare size={12} strokeWidth={2} />}
                            label="Steer agent"
                            onClick={() => onSelectSession(agentForEvent.sessionKey)}
                          />
                        ) : null}
                      </>
                    ) : null}
                  >
                    {item.kind === 'event' ? (
                      <>
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
                          {item.data.detail}
                        </div>
                        <BlueGlassSparklineLane
                          segments={items
                            .filter((candidate): candidate is Extract<ActivityItem, { kind: 'event' }> => candidate.kind === 'event' && candidate.data.agentId === item.data.agentId)
                            .slice(0, 4)
                            .map((candidate, index) => ({
                              label: `${index + 1}`,
                              value: Math.max(1, 4 - index),
                              color: severityColor[candidate.data.severity] ?? '#64748b',
                            }))}
                        />
                        <div style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#1d4ed8' }}>
                          Next move: steer the active runtime lane if this event changes priority.
                        </div>
                      </>
                    ) : item.kind === 'issue' ? (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {item.labels.slice(0, 4).map((label) => (
                            <span
                              key={label.name}
                              style={{
                                padding: '2px 7px',
                                borderRadius: 999,
                                background: `#${label.color}18`,
                                color: `#${label.color}`,
                                fontSize: 11,
                                fontWeight: 600,
                              }}
                            >
                              {label.name}
                            </span>
                          ))}
                        </div>
                        {item.body ? (
                          <div
                            style={{
                              fontSize: 12,
                              lineHeight: 1.55,
                              color: 'var(--t-text-secondary)',
                              padding: '8px 10px',
                              borderRadius: 12,
                              background: 'var(--t-panel-hover)',
                            }}
                          >
                            {item.body.length > 180 ? `${item.body.slice(0, 177).trimEnd()}...` : item.body}
                          </div>
                        ) : (
                          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-muted)' }}>
                            No description yet. The thread context is still mostly in labels, assignment, and comments.
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--t-text-muted)' }}>
                          <span>Assignee: {item.assignees.length ? item.assignees.join(', ') : 'Unassigned'}</span>
                          <span>{item.comments} comment{item.comments === 1 ? '' : 's'}</span>
                        </div>
                        <div style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#1d4ed8' }}>
                          Next move: assign or open the issue before it drifts out of the activity lane.
                        </div>
                      </>
                    ) : item.kind === 'ci' ? (
                      <>
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
                          {item.workflow} on <span style={{ fontFamily: 'var(--font-mono-system)' }}>{item.branch}</span>
                        </div>
                        {ciDetail?.failingJobs?.length ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#dc2626' }}>
                              Failing jobs
                            </div>
                            {ciDetail.failingJobs.map((job) => (
                              <div
                                key={`${job.name}-${job.failingStep ?? 'none'}`}
                                style={{
                                  padding: '6px 8px',
                                  borderRadius: 10,
                                  background: 'var(--t-panel-hover)',
                                  fontSize: 11,
                                  color: 'var(--t-text-secondary)',
                                }}
                              >
                                <div style={{ fontWeight: 600 }}>{job.name}</div>
                                {job.failingStep ? (
                                  <div style={{ marginTop: 2, color: 'var(--t-text-muted)' }}>
                                    {job.failingStep}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {ciDetail?.summaryLine ? (
                          <div
                            style={{
                              fontSize: 11,
                              lineHeight: 1.5,
                              color: 'var(--t-text-secondary)',
                              padding: '7px 8px',
                              borderRadius: 10,
                              background: 'var(--t-panel-hover)',
                            }}
                          >
                            {ciDetail.summaryLine}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#1d4ed8' }}>
                          Next move: inspect the failing run and decide whether to review or steer the agent.
                        </div>
                      </>
                    ) : item.kind === 'pr' ? (
                      <>
                        <BlueGlassSparklineLane
                          segments={[
                            { label: 'Pass', value: item.checkSummary?.passed ?? 0, color: '#22c55e' },
                            { label: 'Fail', value: item.checkSummary?.failed ?? 0, color: '#ef4444' },
                            { label: 'Pending', value: item.checkSummary?.pending ?? 0, color: '#f59e0b' },
                          ]}
                        />
                        {item.failingChecks && item.failingChecks.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#dc2626' }}>
                              Top failing checks
                            </div>
                            {item.failingChecks.map((check) => (
                              <div
                                key={check}
                            style={{
                              fontSize: 11,
                              lineHeight: 1.45,
                              color: 'var(--t-text-secondary)',
                              padding: '6px 8px',
                              borderRadius: 10,
                              background: 'var(--t-panel-hover)',
                            }}
                          >
                            {check}
                          </div>
                            ))}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
                          Branch <span style={{ fontFamily: 'var(--font-mono-system)' }}>{item.branch}</span> has an active merge path.
                        </div>
                        {prDetail?.files?.length ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#1d4ed8' }}>
                              Changed files
                            </div>
                            {prDetail.files.slice(0, 3).map((file) => (
                              <div
                                key={file.path}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '6px 8px',
                                  borderRadius: 10,
                                  background: 'var(--t-panel-hover)',
                                  fontSize: 11,
                                }}
                              >
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)' }}>
                                  {file.path}
                                </span>
                                <span style={{ color: '#16a34a', fontWeight: 600 }}>+{file.additions}</span>
                                <span style={{ color: '#dc2626', fontWeight: 600 }}>-{file.deletions}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#1d4ed8' }}>
                          Next move: {mergeRisk?.label === 'merge ready'
                            ? 'review and merge while the branch is green.'
                            : mergeRisk?.label === 'conflicts'
                              ? 'resolve merge conflicts before stacking more work.'
                              : mergeRisk?.label === 'ci red'
                                ? 'inspect the failing checks before review.'
                                : 'review the PR before you steer more changes into this branch.'}
                        </div>
                      </>
                    ) : item.kind === 'commit' ? (
                      <>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {commitStack.map((commit) => (
                            <div
                              key={commit.hash}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 10,
                                background: commit.hash === item.hash ? 'var(--t-panel-active)' : 'var(--t-panel-hover)',
                              }}
                            >
                              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono-system)', color: '#1d4ed8', fontWeight: 600 }}>{commit.hash}</span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--t-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {commit.message}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#1d4ed8' }}>
                          Next move: open the commit in canvas and compare it against the active workspace.
                        </div>
                      </>
                    ) : null}
                  </BlueGlassHoverCard>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
});
