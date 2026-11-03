'use client';

import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  IconChat,
  IconPencil,
  IconStar,
  IconTrash,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  mobileFontFamily,
  mobileScrollFadeStyle,
  truncateText,
  type ChatHistoryRecord,
  type MobilePalette,
  getModelOption,
} from './mobile-approvals-shared';
import {
  MobileGlassPanel,
  MobilePillButton,
  MobileSurfaceRoot,
  MobileThreadListRoot,
  mobileSafeBottom,
} from './mobile-shell-primitives';
import { FilterPillRow, type FilterPillOption } from '@/components/mobile/shared/FilterPillRow';
import { PullToRefresh } from '@/components/mobile/PullToRefresh';
import { SwipeActions } from '@/components/mobile/SwipeActions';
import { triggerHaptic } from '@/lib/mobile/haptic';

type ChatFilter = 'all' | 'active' | 'idle' | 'errored';

const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

interface DayBucket {
  key: 'today' | 'yesterday' | 'week' | 'earlier';
  label: string;
  rows: ChatHistoryRecord[];
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function bucketChats(rows: ChatHistoryRecord[]): DayBucket[] {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  const today: ChatHistoryRecord[] = [];
  const yesterday: ChatHistoryRecord[] = [];
  const week: ChatHistoryRecord[] = [];
  const earlier: ChatHistoryRecord[] = [];

  rows.forEach((row) => {
    const ts = new Date(row.updatedAt).getTime();
    if (Number.isNaN(ts)) {
      earlier.push(row);
      return;
    }
    if (ts >= todayStart) today.push(row);
    else if (ts >= yesterdayStart) yesterday.push(row);
    else if (ts >= weekStart) week.push(row);
    else earlier.push(row);
  });

  const buckets: DayBucket[] = [];
  if (today.length) buckets.push({ key: 'today', label: 'Today', rows: today });
  if (yesterday.length) buckets.push({ key: 'yesterday', label: 'Yesterday', rows: yesterday });
  if (week.length) buckets.push({ key: 'week', label: 'This week', rows: week });
  if (earlier.length) buckets.push({ key: 'earlier', label: 'Earlier', rows: earlier });
  return buckets;
}

interface ContextMenuState {
  tabId: string;
  title: string;
  starred?: boolean;
  x: number;
  y: number;
}

function chatTimeAgo(dateStr: string): string {
  const timestamp = new Date(dateStr).getTime();
  if (Number.isNaN(timestamp)) return 'Unknown';

  const ms = Date.now() - timestamp;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ChatContextMenu({
  menu,
  onClose,
  onAction,
  palette,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  onAction: (action: 'star' | 'rename' | 'delete', tabId: string) => void;
  palette: MobilePalette;
}) {
  const items: Array<{ action: 'star' | 'rename' | 'delete'; label: string; color?: string; icon: ReactNode }> = [
    {
      action: 'star',
      label: menu.starred ? 'Unstar' : 'Star',
      icon: <IconStar fill={palette.iconFill} />,
    },
    {
      action: 'rename',
      label: 'Rename',
      icon: <IconPencil fill={palette.iconFill} />,
    },
    {
      action: 'delete',
      label: 'Delete',
      color: palette.danger,
      icon: <IconTrash fill={palette.iconFill} />,
    },
  ];

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
      <div
        style={{
          position: 'fixed',
          left: Math.min(menu.x, typeof window !== 'undefined' ? window.innerWidth - 208 : 208),
          top: Math.min(menu.y, typeof window !== 'undefined' ? window.innerHeight - 220 : 420),
          zIndex: 1001,
          width: 192,
        }}
      >
        <MobileGlassPanel palette={palette} style={{ padding: '6px 0', background: palette.menuBackground }}>
          {items.map((item) => (
            <button
              key={item.action}
              type="button"
              onClick={() => {
                onAction(item.action, menu.tabId);
                onClose();
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                border: 'none',
                backgroundColor: 'transparent',
                color: item.color ?? palette.rootText,
                fontSize: 15,
                fontWeight: 500,
                letterSpacing: MOBILE_BODY_TRACKING,
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: mobileFontFamily(),
              }}
            >
              <span style={{ opacity: item.color ? 1 : 0.88 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </MobileGlassPanel>
      </div>
    </>
  );
}

export function ChatListView({
  conversations,
  loading,
  onSelect,
  onNewChat,
  onRefresh,
  palette,
}: {
  conversations: ChatHistoryRecord[];
  loading: boolean;
  onSelect: (tabId: string) => void;
  onNewChat: () => void;
  onRefresh: () => Promise<void> | void;
  palette: MobilePalette;
}) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settling = useRef(new Set<string>());
  const [settlingIds, setSettlingIds] = useState<ReadonlySet<string>>(new Set());
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settleStatus, setSettleStatus] = useState('');

  const handleSettle = useCallback(async (tabId: string) => {
    if (settling.current.has(tabId)) return;
    settling.current.add(tabId);
    setSettlingIds(new Set(settling.current));
    setSettleError(null);
    setSettleStatus('Settling conversation...');
    try {
      const response = await fetch('/api/v2/chat-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId, inboxAction: 'settle' }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === 'string' ? body.error : 'Unable to settle conversation. Try again.');
      }
      setSettleStatus('Conversation settled.');
      await onRefresh();
    } catch (error) {
      setSettleStatus('');
      setSettleError(error instanceof Error ? error.message : 'Unable to settle conversation. Try again.');
    } finally {
      settling.current.delete(tabId);
      setSettlingIds(new Set(settling.current));
    }
  }, [onRefresh]);

  const counts = useMemo(() => {
    const now = Date.now();
    let active = 0;
    let idle = 0;
    conversations.forEach((conversation) => {
      const ts = new Date(conversation.updatedAt).getTime();
      if (Number.isNaN(ts)) {
        idle += 1;
        return;
      }
      if (now - ts < ACTIVE_THRESHOLD_MS) active += 1;
      else idle += 1;
    });
    return { all: conversations.length, active, idle, errored: 0 };
  }, [conversations]);

  const filtered = useMemo(() => {
    if (filter === 'all') return conversations;
    if (filter === 'errored') return [];
    const now = Date.now();
    return conversations.filter((conversation) => {
      const ts = new Date(conversation.updatedAt).getTime();
      if (Number.isNaN(ts)) return filter === 'idle';
      const recent = now - ts < ACTIVE_THRESHOLD_MS;
      return filter === 'active' ? recent : !recent;
    });
  }, [conversations, filter]);

  const buckets = useMemo(() => bucketChats(filtered), [filtered]);

  const filterOptions: ReadonlyArray<FilterPillOption<ChatFilter>> = useMemo(() => [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'active', label: 'Active', count: counts.active },
    { value: 'idle', label: 'Idle', count: counts.idle },
    { value: 'errored', label: 'Errored', count: counts.errored },
  ], [counts]);

  const handleLongPressStart = useCallback((
    tabId: string,
    title: string,
    starred: boolean,
    event: React.TouchEvent | React.MouseEvent,
  ) => {
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;

    longPressTimer.current = setTimeout(() => {
      setContextMenu({ tabId, title, starred, x: clientX, y: clientY });
    }, 500);
  }, []);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleContextAction = useCallback(async (action: 'star' | 'rename' | 'delete', tabId: string) => {
    if (action === 'delete') {
      await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`, { method: 'DELETE' });
      onRefresh();
      return;
    }

    if (action === 'star') {
      const existing = conversations.find((conversation) => conversation.tabId === tabId);
      await fetch('/api/v2/chat-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId, starred: !existing?.starred }),
      });
      onRefresh();
      return;
    }

    const conversation = conversations.find((item) => item.tabId === tabId);
    setRenaming(tabId);
    setRenameValue(conversation?.title ?? '');
  }, [conversations, onRefresh]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renaming || !renameValue.trim()) {
      setRenaming(null);
      return;
    }

    await fetch('/api/v2/chat-history', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: renaming, title: renameValue.trim() }),
    });

    setRenaming(null);
    onRefresh();
  }, [onRefresh, renameValue, renaming]);

  return (
    <MobileSurfaceRoot>
      {contextMenu ? (
        <ChatContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onAction={(action, tabId) => {
            void handleContextAction(action, tabId);
          }}
          palette={palette}
        />
      ) : null}

      <FilterPillRow
        options={filterOptions}
        value={filter}
        onChange={setFilter}
        palette={palette}
        style={{ marginLeft: -16, marginRight: -16 }}
      />

      {settleError ? (
        <div role="alert" style={{ color: palette.danger, fontSize: 13, marginBottom: 8 }}>
          {settleError}
        </div>
      ) : null}
      <div role="status" style={{ color: palette.subduedText, fontSize: 13 }}>
        {settleStatus}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingBottom: mobileSafeBottom(96),
          // Contain overscroll so pull-to-refresh fires only from the top of
          // this list, not the page chrome above it.
          overscrollBehavior: 'contain',
          // Top fades behind the filter pill row above; bottom fades behind
          // the floating "new chat" FAB so transcripts don't cleanly cut off
          // underneath either chrome strip.
          ...mobileScrollFadeStyle({ top: 16, bottom: 80 }),
        } as CSSProperties}
      >
       <PullToRefresh onRefresh={onRefresh}>
        {loading ? (
          <MobileGlassPanel palette={palette} style={{ padding: '28px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: palette.subduedText }}>
              Loading conversations...
            </div>
          </MobileGlassPanel>
        ) : conversations.length === 0 ? (
          <MobileGlassPanel
            palette={palette}
            style={{
              padding: '44px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <IconChat fill={palette.iconFill} style={{ opacity: 0.3 }} />
            <div style={{ fontSize: 20, fontWeight: 800, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING, marginTop: 16, marginBottom: 6 }}>
              No conversations yet
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, letterSpacing: MOBILE_BODY_TRACKING, color: palette.subduedText, maxWidth: 280, marginBottom: 18 }}>
              Start a new chat and it will appear here once the first exchange is saved.
            </div>
            <MobilePillButton onClick={onNewChat} palette={palette} tone="accent">
              Start new chat
            </MobilePillButton>
          </MobileGlassPanel>
        ) : filtered.length === 0 ? (
          <MobileGlassPanel
            palette={palette}
            style={{
              padding: '32px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 14, color: palette.subduedText }}>
              No conversations match this filter.
            </div>
          </MobileGlassPanel>
        ) : (
          buckets.map((bucket) => (
            <div key={bucket.key} style={{ marginBottom: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: palette.subduedText,
                  paddingLeft: 16,
                  paddingRight: 16,
                  marginTop: 12,
                  marginBottom: 6,
                  fontFamily: mobileFontFamily(),
                }}
              >
                {bucket.label}
              </div>
              <MobileThreadListRoot style={{ gap: 0 }}>
                {bucket.rows.map((conversation) => {

              if (renaming === conversation.tabId) {
                return (
                  <MobileGlassPanel key={conversation.tabId} palette={palette} style={{ padding: 16 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: palette.rootText, marginBottom: 10 }}>
                      Rename conversation
                    </div>
                    <div style={{ display: 'grid', gap: 10 }}>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            void handleRenameSubmit();
                          }
                          if (event.key === 'Escape') {
                            setRenaming(null);
                          }
                        }}
                        style={{
                          height: 44,
                          borderRadius: MOBILE_CARD_RADIUS,
                          border: `1px solid ${palette.inputBorder}`,
                          backgroundColor: palette.inputBackground,
                          color: palette.rootText,
                          fontSize: 14,
                          letterSpacing: MOBILE_BODY_TRACKING,
                          paddingLeft: 12,
                          paddingRight: 12,
                          outline: 'none',
                          fontFamily: mobileFontFamily(),
                        }}
                      />
                      <div style={{ display: 'flex', gap: 10 }}>
                        <MobilePillButton onClick={() => setRenaming(null)} palette={palette} style={{ flex: 1 }}>
                          Cancel
                        </MobilePillButton>
                        <MobilePillButton
                          onClick={() => {
                            void handleRenameSubmit();
                          }}
                          palette={palette}
                          tone="accent"
                          style={{ flex: 1 }}
                        >
                          Save
                        </MobilePillButton>
                      </div>
                    </div>
                  </MobileGlassPanel>
                );
              }

              return (
                <SwipeActions
                  key={conversation.tabId}
                  palette={palette}
                  onLeftSwipe={() => { void handleSettle(conversation.tabId); }}
                  onRightSwipe={() => { void handleSettle(conversation.tabId); }}
                  leftLabel="Settle"
                  rightLabel="Settle"
                  leftConfirmLabel="Confirm settle"
                  rightConfirmLabel="Confirm settle"
                  leftColor={palette.success}
                  disabled={loading || settlingIds.has(conversation.tabId) || contextMenu !== null}
                  confirmationPlacement="below"
                  style={{ minWidth: 0, borderRadius: 0 }}
                >
                <button
                  type="button"
                  disabled={settlingIds.has(conversation.tabId)}
                  aria-busy={settlingIds.has(conversation.tabId)}
                  onClick={() => {
                    if (!contextMenu) onSelect(conversation.tabId);
                  }}
                  onMouseDown={(event) => handleLongPressStart(conversation.tabId, conversation.title, conversation.starred ?? false, event)}
                  onMouseUp={handleLongPressEnd}
                  onMouseLeave={handleLongPressEnd}
                  onMouseMove={handleLongPressEnd}
                  onTouchStart={(event) => handleLongPressStart(conversation.tabId, conversation.title, conversation.starred ?? false, event)}
                  onTouchEnd={handleLongPressEnd}
                  onTouchMove={handleLongPressEnd}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      tabId: conversation.tabId,
                      title: conversation.title,
                      starred: conversation.starred,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  style={{
                    width: '100%',
                    height: 56,
                    paddingLeft: 14,
                    paddingRight: 14,
                    border: 'none',
                    borderBottom: `1px solid ${palette.cardBorder}`,
                    background: palette.panelBackground,
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: mobileFontFamily(),
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    opacity: settlingIds.has(conversation.tabId) ? 0.5 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: palette.rootText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {conversation.starred ? (
                        <IconStar fill={palette.warning} size={12} style={{ marginRight: 6, verticalAlign: -1 } as React.CSSProperties} />
                      ) : null}
                      {conversation.title || 'Untitled'}
                    </div>
                    <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 2 }}>
                      {chatTimeAgo(conversation.updatedAt)}
                      {conversation.model ? (
                        <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: palette.subduedText }}>
                            {getModelOption(conversation.model)?.label ?? truncateText(conversation.model, 24)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                </button>
                </SwipeActions>
              );
                })}
              </MobileThreadListRoot>
            </div>
          ))
        )}
       </PullToRefresh>
      </div>

      <button
        type="button"
        onClick={() => {
          triggerHaptic('tap');
          onNewChat();
        }}
        aria-label="Start new chat"
        style={{
          position: 'fixed',
          right: 20,
          bottom: `calc(env(safe-area-inset-bottom, 0px) + 24px)`,
          width: 56,
          height: 56,
          minWidth: 56,
          minHeight: 56,
          borderRadius: 999,
          border: 'none',
          background: '#e07a3a',
          color: '#ffffff',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 12px 28px rgba(224, 122, 58, 0.42), 0 4px 10px rgba(0, 0, 0, 0.18)',
          zIndex: 10,
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
          padding: 0,
        }}
      >
        <svg width="26" height="26" viewBox="0 0 256 256" aria-hidden="true">
          <path
            d="M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128ZM84,116a12,12,0,1,0,12,12A12,12,0,0,0,84,116Zm88,0a12,12,0,1,0,12,12A12,12,0,0,0,172,116Zm60,12A104,104,0,0,1,79.12,219.82L45.07,231.17a16,16,0,0,1-20.24-20.24l11.35-34.05A104,104,0,1,1,232,128Zm-16,0A88,88,0,1,0,51.81,172.06a8,8,0,0,1,.66,6.54L40,216,77.4,203.53a7.85,7.85,0,0,1,2.53-.42,8,8,0,0,1,4,1.08A88,88,0,0,0,216,128Z"
            fill="#ffffff"
          />
        </svg>
      </button>
    </MobileSurfaceRoot>
  );
}
