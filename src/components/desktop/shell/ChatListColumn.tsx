'use client';

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { ComposerPopoverVisibilityContext } from '@/components/desktop/thoughts/chat-panel/ComposerPopover';
import { useFloatingSurfaceMaterial } from '../FloatingSurface';

import { NAVIGATION_RAIL_WIDTH } from './shell-geometry';
export { NAVIGATION_RAIL_WIDTH } from './shell-geometry';

/** Keep the list instance and scroll containers alive while its column is closed. */
export function ChatListColumn({ visible, width, overlay, railWidth = NAVIGATION_RAIL_WIDTH, onClose, children }: {
  visible: boolean;
  width: number;
  overlay: boolean;
  railWidth?: number;
  onClose: () => void;
  children?: ReactNode;
}) {
  const material = useFloatingSurfaceMaterial();
  const columnRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!visible || !overlay) return;
    const column = columnRef.current;
    if (!column) return;
    const controls = () => Array.from(column.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]',
    )).filter(node => node.tabIndex >= 0 && !node.matches(':disabled')
      && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
    const focusFirst = () => (controls()[0] ?? column).focus({ preventScroll: true });
    // Portaled menus and dialogs own their focus while above the drawer.
    const inPopover = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('[role="menu"], [role="dialog"], [data-composer-overlay]'));
    const containFocus = (event: FocusEvent) => {
      if (column.getClientRects().length === 0 || column.contains(event.target as Node) || inPopover(event.target)) return;
      focusFirst();
    };
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || inPopover(event.target)) return;
      const items = controls();
      const first = items[0] ?? column;
      const last = items[items.length - 1] ?? column;
      if (document.activeElement === column || document.activeElement === (event.shiftKey ? first : last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    };
    if (!column.contains(document.activeElement)) focusFirst();
    document.addEventListener('focusin', containFocus);
    column.addEventListener('keydown', trapTab);
    return () => {
      document.removeEventListener('focusin', containFocus);
      column.removeEventListener('keydown', trapTab);
    };
  }, [visible, overlay]);
  useEffect(() => {
    if (!visible || !overlay) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ((event.target as Element)?.closest('[role="menu"], [role="dialog"]')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [visible, overlay, onClose]);
  return (
    <>
      {visible && overlay ? <button type="button" aria-label="Close chats sidebar" tabIndex={-1}
        onClick={onClose} style={{ position: 'absolute', inset: 0, left: railWidth,
          border: 0, padding: 0, background: 'transparent', zIndex: 179 }} /> : null}
    <aside
      ref={columnRef}
      tabIndex={-1}
      id="o8-chat-list"
      aria-label="Chats and workers"
      aria-hidden={!visible}
      inert={!visible}
      data-o8-chat-list="true"
      data-mcp-scope="agent-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if ((event.target as Element).closest('[role="menu"], [role="dialog"]')) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      style={{
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        flexShrink: 0,
        width,
        maxWidth: overlay
          ? `min(300px, calc(100% - ${railWidth + 48}px))`
          : `max(160px, calc(100vw / var(--ui-zoom, 1) - ${NAVIGATION_RAIL_WIDTH + 492}px))`,
        height: overlay ? 'calc(100% - var(--o8-shell-edge-inset, 0px))' : '100%',
        minHeight: 0,
        position: overlay ? 'absolute' : 'relative',
        left: overlay ? railWidth : undefined,
        zIndex: overlay ? 180 : undefined,
        // In-flow glass can share the window material. An overlay must frost
        // the workspace beneath it, with the palette fallback in other modes.
        ...(overlay ? {
          ...material.textStyle,
          ...(material.isAllGlass ? material.overlayStyle : {}),
          // Backdrop blur can be unavailable in WebKit's native compositor.
          // Stacked chrome needs its own readable backing in every appearance.
          background: 'var(--t-popover-surface)',
        } : {}),
      } as CSSProperties}
    >
      <ComposerPopoverVisibilityContext value={visible}>
        {children}
      </ComposerPopoverVisibilityContext>
    </aside>
    </>
  );
}
