'use client';

import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import { SmoothCorners } from '@lisse/react';
import { useTheme } from '@/lib/theme/context';
import { isWebMachineBrowserSurface } from '@/lib/connect/web-machine-surface';
import { shellLacksGlass } from '@/lib/desktop/host-platform';
import { WORKSPACE_RAIL_CORNER_RADIUS, WORKSPACE_RAIL_CORNER_SMOOTHING } from './branch-rail-geometry';

/** Material shared by floating surfaces that need their own corner geometry. */
export function useFloatingSurfaceMaterial(glass?: boolean) {
  const { workspaceGlass, surface, paletteId } = useTheme();
  const isGlass = glass ?? (!isWebMachineBrowserSurface() && !shellLacksGlass() && (workspaceGlass || surface === 'glass'));
  const allGlass = isGlass && workspaceGlass;
  const frostStyle = {
    background: allGlass ? 'var(--t-glass-elevated)' : 'var(--t-popover-surface)',
    backdropFilter: 'blur(24px) saturate(1.4)',
    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
  } as CSSProperties;
  return {
    isGlass,
    isAllGlass: allGlass,
    borderColor: isGlass ? 'var(--t-border)' : 'var(--t-divider-subtle)',
    shadow: isGlass ? '0 18px 48px rgba(15, 23, 42, 0.32), 0 4px 14px rgba(15, 23, 42, 0.16)' : 'none',
    textStyle: {
      color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
      ...(allGlass ? { '--t-text': 'var(--t-chat-surface-text)', '--t-text-secondary': 'var(--t-chat-surface-text-secondary)' } : isGlass && paletteId === 'dark' ? { '--t-text': '#e8ecf2', '--t-text-secondary': '#bcc5d0', '--t-text-muted': '#8b95a3' } : {}),
    } as CSSProperties,
    overlayStyle: frostStyle,
    surfaceStyle: allGlass ? frostStyle : {
      background: isGlass ? 'var(--t-bg)' : 'var(--t-panel-solid)',
      backdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
      WebkitBackdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
    } as CSSProperties,
  };
}

/** Shared floating treatment for the rail's usage hover, menus and drawers.
 * Animate ancestor transforms rather than opacity so WebKit can sample the workspace backdrop.
 */
export const FloatingSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  glass?: boolean;
  contentStyle?: CSSProperties;
  /** Frost workspace content beneath a floating overlay. */
  overlay?: boolean;
}>(function FloatingSurface({ glass, overlay = false, style, contentStyle, children, ...props }, ref) {
  const material = useFloatingSurfaceMaterial(glass);
  const frost = overlay || material.isAllGlass ? material.overlayStyle : null;
  return <div {...props} ref={ref} style={{
    border: `1px solid ${material.borderColor}`,
    borderRadius: WORKSPACE_RAIL_CORNER_RADIUS,
    boxShadow: material.shadow,
    ...material.textStyle,
    // WebKit cannot sample the workspace through the corner clip's backdrop root.
    ...(frost ? { backdropFilter: frost.backdropFilter, WebkitBackdropFilter: frost.WebkitBackdropFilter } : {}),
    ...style,
  } as CSSProperties}>
    <SmoothCorners corners={{ radius: typeof style?.borderRadius === 'number' ? style.borderRadius : WORKSPACE_RAIL_CORNER_RADIUS, smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }}
      autoEffects={false} style={{ ...contentStyle, ...material.surfaceStyle, ...(frost ? { background: frost.background, backdropFilter: 'none', WebkitBackdropFilter: 'none' } : {}) }}>
      {children}
    </SmoothCorners>
  </div>;
});
