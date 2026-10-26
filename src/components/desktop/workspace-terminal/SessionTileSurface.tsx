'use client';

/**
 * SessionTileSurface — recursive renderer for the orchestrator session tile
 * tree (issue #663). Each leaf hosts either the orchestrator chat (rendered
 * via the `chatSlot` prop) or a SessionTranscriptPane.
 *
 * Mirrors TileContainer's flat-render strategy: walks the tree once per
 * layout change, computes a leaf rect map, then renders every leaf as an
 * absolutely-positioned sibling of the container so React preserves
 * component state across split/resize/close changes.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { projectLiveSessionMeshParticipants } from '@/components/desktop/workspace-terminal/LiveSessionMesh';
import { useSplitResize } from '../hooks/useSplitResize';
import { SESSION_PANE_INSET } from './SessionPaneFrame';
import { ResizeEdge } from '../shell/ResizeEdge';
import { SessionTranscriptPane } from '@/components/desktop/SessionTranscriptPane';
export { projectLiveSessionMeshParticipants };
import { ThreadChatPane } from '@/components/desktop/workspace-terminal/ThreadChatPane';
import {
  collectAllLeaves,
  computeSessionTileLayout,
  type SessionTileLayout,
  type SessionTileLeaf,
  type SessionTileRect,
  type SessionTileSplitFrame,
} from '@/lib/orchestrator/session-tiles';

interface SessionTileSurfaceProps {
  layout: SessionTileLayout;
  focusedSessionKey: string | null;
  chatSlot: ReactNode;
  /** Repo scope inherited by thread panes (drag-to-split). */
  repoPath?: string | null;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onCloseLeaf: (leafId: string) => void;
  onFocusSession: (sessionKey: string) => void;
  /** Compact automatic worker stacks have presentation-only split IDs. */
  disableResizeHandles?: boolean;
  /** Compact worker rows scroll independently while chat remains full-height. */
  workerScrollRows?: number;
  /** Development previews can exercise the real split geometry without launching agents. */
  renderSessionPane?: (leaf: SessionTileLeaf) => ReactNode;
}

const HANDLE_SIZE = 8;
const MORPH_TRANSITION = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';

export function SessionTileSurface({
  layout,
  focusedSessionKey,
  chatSlot,
  repoPath,
  onResizeSplit,
  onCloseLeaf,
  onFocusSession,
  disableResizeHandles = false,
  workerScrollRows = 0,
  renderSessionPane,
}: SessionTileSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedLeaves, setCollapsedLeaves] = useState<ReadonlySet<string>>(() => new Set());
  const { leaves, leafRects, splitFrames } = useMemo(() => {
    const { leafRects, splitFrames } = computeSessionTileLayout(layout.root);
    const leaves = collectAllLeaves(layout.root);
    return { leaves, leafRects, splitFrames };
  }, [layout.root]);
  const collapseCallbacks = useMemo(() => new Map(leaves.map(leaf => [leaf.id, (collapsed: boolean) => {
    setCollapsedLeaves(previous => {
      if (previous.has(leaf.id) === collapsed) return previous;
      const next = new Set(previous);
      if (collapsed) next.add(leaf.id); else next.delete(leaf.id);
      return next;
    });
  }])), [leaves]);
  const workerGroup = useMemo(() => {
    const root = layout.root;
    if (root.type !== 'split' || root.direction !== 'vertical'
      || root.children[0].type !== 'leaf' || root.children[0].kind !== 'chat') return null;
    const workers = collectAllLeaves(root.children[1]);
    return workers.length > 0 && workers.every((leaf) => leaf.kind === 'session' && leaf.sessionSurface === 'mesh')
      ? { chat: root.children[0], workers, ratio: root.ratio }
      : null;
  }, [layout.root]);
  const hasCollapsedWorkers = layout.root.type === 'split' && !layout.root.manualOverride
    && (workerGroup?.workers.some(leaf => collapsedLeaves.has(leaf.id)) ?? false);

  // FLIP morph (motion audit 003): the percentage rect stays the resting
  // layout — untransitioned, so a live terminal never relayouts mid-tween —
  // and a split/merge is played back as a transform-only tween from the old
  // box to the new one. Split-handle drags change ratios only; those snap so
  // the panes track the handle instead of lagging a tween behind it.
  const leafNodesRef = useRef(new Map<string, HTMLDivElement>());
  const prevRectsRef = useRef<Map<string, SessionTileRect> | null>(null);

  useLayoutEffect(() => {
    const prev = prevRectsRef.current;
    prevRectsRef.current = leafRects;
    const container = containerRef.current;
    if (!prev || !container || workerGroup) return;

    const structural = prev.size !== leafRects.size
      || Array.from(leafRects.keys()).some((id) => !prev.has(id));
    if (!structural) return;

    const box = container.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;

    const morphing: HTMLDivElement[] = [];
    leafRects.forEach((rect, id) => {
      const before = prev.get(id);
      const node = leafNodesRef.current.get(id);
      if (!before || !node || rect.width <= 0 || rect.height <= 0) return;
      const dx = (before.left - rect.left) * box.width;
      const dy = (before.top - rect.top) * box.height;
      const sx = before.width / rect.width;
      const sy = before.height / rect.height;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return;
      node.style.transition = 'none';
      node.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      morphing.push(node);
    });
    if (morphing.length === 0) return;

    const frame = requestAnimationFrame(() => {
      for (const node of morphing) {
        node.style.transition = MORPH_TRANSITION;
        node.style.transform = 'none';
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const node of morphing) {
        node.style.transition = '';
        node.style.transform = '';
      }
    };
  }, [leafRects, workerGroup]);

  const makeResizeStart = useSplitResize(containerRef, onResizeSplit);

  const renderLeaf = (leaf: SessionTileLeaf) => {
    const rect = leafRects.get(leaf.id);
    if (!rect) return null;
    const inWorkerGroup = workerGroup !== null && leaf.kind === 'session';
    const stacked = inWorkerGroup && hasCollapsedWorkers;
    const collapsed = stacked && collapsedLeaves.has(leaf.id);
    const left = inWorkerGroup ? (rect.left - workerGroup.ratio) / (1 - workerGroup.ratio) : rect.left;
    const width = inWorkerGroup ? rect.width / (1 - workerGroup.ratio) : rect.width;
    return (
          <div
            key={leaf.id}
            data-session-tile-leaf-id={leaf.id}
            ref={(node) => {
              if (node) leafNodesRef.current.set(leaf.id, node);
              else leafNodesRef.current.delete(leaf.id);
            }}
            style={{
              position: stacked ? 'relative' : 'absolute',
              left: stacked ? 0 : `${left * 100}%`,
              top: stacked ? 0 : `${rect.top * 100}%`,
              width: stacked ? '100%' : `${width * 100}%`,
              height: stacked ? 'auto' : `${rect.height * 100}%`,
              flex: stacked ? collapsed ? '0 0 auto' : '1 0 240px' : undefined,
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              transformOrigin: 'top left',
            }}
          >
            {leaf.kind === 'chat' ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  paddingBottom: leaves.length > 1 ? SESSION_PANE_INSET : 0,
                  '--o8-compose-first-rail-clearance': leaves.some((entry) => entry.kind === 'session') ? '0px' : undefined,
                } as CSSProperties}
              >
                {chatSlot}
              </div>
            ) : leaf.kind === 'thread' && leaf.threadId ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  paddingTop: SESSION_PANE_INSET,
                  paddingRight: SESSION_PANE_INSET,
                  paddingBottom: SESSION_PANE_INSET,
                  paddingLeft: SESSION_PANE_INSET,
                }}
              >
                <ThreadChatPane
                  threadId={leaf.threadId}
                  title={leaf.title ?? 'Chat'}
                  mode={leaf.mode ?? 'orchestrator'}
                  // The dragged thread's ORIGIN repo wins — the rail lists
                  // history across repos, and a pane scoped to the host
                  // tab's repo would mis-attribute its sends/dispatch.
                  repoPath={leaf.repoPath ?? repoPath}
                  onClose={() => onCloseLeaf(leaf.id)}
                />
              </div>
            ) : leaf.kind === 'session' && leaf.sessionKey ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  paddingTop: SESSION_PANE_INSET,
                  paddingRight: SESSION_PANE_INSET,
                  paddingBottom: SESSION_PANE_INSET,
                  paddingLeft: SESSION_PANE_INSET,
                }}
              >
                {renderSessionPane ? renderSessionPane(leaf) : (
                  <SessionTranscriptPane
                    sessionKey={leaf.sessionKey}
                    focused={focusedSessionKey === leaf.sessionKey}
                    onFocus={onFocusSession}
                    onClose={() => onCloseLeaf(leaf.id)}
                    onCollapsedChange={collapseCallbacks.get(leaf.id)}
                  />
                )}
              </div>
            ) : null}
          </div>
    );
  };

  return (
    <div
      ref={containerRef}
      data-session-tile-surface="true"
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        background: 'var(--t-chat-surface-bg, #ffffff)',
      }}
    >
      {workerGroup ? [renderLeaf(workerGroup.chat)] : leaves.map(renderLeaf)}
      {workerGroup ? (
        <div
          data-session-worker-scroll={workerScrollRows > 0 || hasCollapsedWorkers ? 'true' : undefined}
          tabIndex={workerScrollRows > 0 || hasCollapsedWorkers ? 0 : undefined}
          aria-label={workerScrollRows > 0 || hasCollapsedWorkers ? 'Worker panes' : undefined}
          style={{
            position: 'absolute',
            left: `${workerGroup.ratio * 100}%`,
            top: 0,
            width: `${(1 - workerGroup.ratio) * 100}%`,
            height: '100%',
            overflowY: workerScrollRows > 0 || hasCollapsedWorkers ? 'auto' : 'hidden',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
          }}
        >
          <div style={{ position: 'relative', width: '100%', height: '100%', display: hasCollapsedWorkers ? 'flex' : undefined, flexDirection: 'column', minHeight: !hasCollapsedWorkers && workerScrollRows > 0 ? workerScrollRows * 240 : undefined }}>
            {workerGroup.workers.map(renderLeaf)}
          </div>
        </div>
      ) : null}
      {!disableResizeHandles && splitFrames.filter(frame => !hasCollapsedWorkers || frame.id === layout.root.id).map((frame) => (
        <SessionResizeHandle
          key={frame.id}
          frame={frame}
          onResize={(ratio) => onResizeSplit(frame.id, ratio)}
          onPointerDown={makeResizeStart(frame.id, frame.direction, frame.container, frame.direction === 'vertical'
            ? (frame.boundary.left - frame.container.left) / frame.container.width
            : (frame.boundary.top - frame.container.top) / frame.container.height)}
        />
      ))}
    </div>
  );
}

function SessionResizeHandle({
  frame,
  onPointerDown,
  onResize,
}: {
  frame: SessionTileSplitFrame;
  onResize: (ratio: number) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const isVertical = frame.direction === 'vertical';
  const ratio = isVertical ? (frame.boundary.left - frame.container.left) / frame.container.width : (frame.boundary.top - frame.container.top) / frame.container.height;
  const style: CSSProperties = isVertical
    ? {
        position: 'absolute',
        left: `calc(${frame.boundary.left * 100}% - ${HANDLE_SIZE / 2}px)`,
        top: `${frame.boundary.top * 100}%`,
        width: HANDLE_SIZE,
        height: `${frame.boundary.height * 100}%`,
        cursor: 'col-resize',
      }
    : {
        position: 'absolute',
        left: `${frame.boundary.left * 100}%`,
        top: `calc(${frame.boundary.top * 100}% - ${HANDLE_SIZE / 2}px)`,
        width: `${frame.boundary.width * 100}%`,
        height: HANDLE_SIZE,
        cursor: 'row-resize',
      };
  return (
    <ResizeEdge
      orientation={isVertical ? 'vertical' : 'horizontal'}
      hitSlop={8}
      aria-label={`Resize ${isVertical ? 'columns' : 'rows'}`}
      data-session-resize-handle={frame.id}
      data-session-resize-direction={frame.direction}
      onPointerDown={onPointerDown}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      onKeyDown={(event) => {
        const step = isVertical ? (event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0)
          : (event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0);
        if (!step) return;
        event.preventDefault();
        onResize(Math.max(0.2, Math.min(0.8, ratio + step)));
      }}
      style={style}
    />
  );
}
