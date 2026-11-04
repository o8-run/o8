'use client';

import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { triggerHaptic } from '@/lib/mobile/haptic';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  IconActivity,
  IconAgents,
  IconBrowser,
  IconChat,
  IconCosts,
  IconIssues,
  IconOrchestrator,
  IconShield,
  type MobilePalette,
  type MobileView,
  mobileFontFamily,
} from './mobile-approvals-shared';
import {
  MobileStatusDot,
  mobileSafeBottom,
} from './mobile-shell-primitives';

interface SidebarProps {
  open: boolean;
  activeView: MobileView;
  approvalCount: number;
  selectedModelLabel: string;
  connectionStatus: 'connected' | 'disconnected';
  hostnameLabel: string;
  onNavigate: (view: MobileView) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  palette: MobilePalette;
}

interface SidebarNavItem {
  id: MobileView;
  label: string;
  description: string;
  badge?: number;
  icon: ReactNode;
}

export function Sidebar({
  open,
  activeView,
  approvalCount,
  selectedModelLabel,
  connectionStatus,
  hostnameLabel,
  onNavigate,
  onClose,
  onOpenSettings,
  palette,
}: SidebarProps) {
  const initials = useMemo(() => {
    const trimmed = hostnameLabel.replace(/[^a-zA-Z0-9]/g, '');
    return trimmed.slice(0, 2).toUpperCase() || 'O8';
  }, [hostnameLabel]);

  const navItems: SidebarNavItem[] = [
    {
      id: 'orchestrator',
      label: 'Orchestrator',
      description: 'The brain — plan, dispatch, review',
      icon: <IconOrchestrator fill={palette.iconFill} />,
    },
    {
      id: 'approvals',
      label: 'Approvals',
      description: 'Approve or reject pending actions',
      badge: approvalCount > 0 ? approvalCount : undefined,
      icon: <IconShield fill={palette.iconFill} />,
    },
    {
      id: 'agents',
      label: 'Agents',
      description: 'See and steer running sessions',
      icon: <IconAgents fill={palette.iconFill} />,
    },
    {
      id: 'browser',
      label: 'Browser',
      description: 'Preview LAN dev servers',
      icon: <IconBrowser fill={palette.iconFill} />,
    },
    {
      id: 'issues',
      label: 'Issues',
      description: 'Backlog and open tickets',
      icon: <IconIssues fill={palette.iconFill} />,
    },
    {
      id: 'prs',
      label: 'PRs',
      description: 'Review and merge project pull requests',
      icon: <IconIssues fill={palette.iconFill} />,
    },
    {
      id: 'chat',
      label: 'Assistant',
      description: 'Personal LLM chat with repo context',
      icon: <IconChat fill={palette.iconFill} />,
    },
    {
      id: 'activity',
      label: 'Activity',
      description: 'Recent commits, PRs, deploys',
      icon: <IconActivity fill={palette.iconFill} />,
    },
    {
      id: 'costs',
      label: 'Costs',
      description: 'Tokens and spend by agent',
      icon: <IconCosts fill={palette.iconFill} />,
    },
  ];

  const connectionColor = connectionStatus === 'connected' ? palette.success : palette.danger;

  const navButtonStyle = (active: boolean): CSSProperties => ({
    width: '100%',
    minHeight: MOBILE_TOUCH_TARGET,
    borderRadius: 10,
    border: 'none',
    background: active ? palette.accentSoft : 'transparent',
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
    color: palette.rootText,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: mobileFontFamily(),
    letterSpacing: MOBILE_BODY_TRACKING,
  });

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: palette.overlayBackground,
          zIndex: 998,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.24s ease',
        }}
      />

      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 296,
          paddingTop: 'max(env(safe-area-inset-top, 0px), 18px)',
          paddingLeft: 16,
          paddingRight: 16,
          paddingBottom: mobileSafeBottom(18),
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          background: palette.sidebarBackground,
          borderRight: `1px solid ${palette.cardBorder}`,
          boxShadow: palette.shadow,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          zIndex: 999,
          transform: open ? 'translateX(0)' : 'translateX(-304px)',
          transition: 'transform 0.26s cubic-bezier(0.32, 0.72, 0, 1)',
          color: palette.rootText,
          fontFamily: mobileFontFamily(),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px' }}>
          <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: MOBILE_HEADING_TRACKING, color: palette.rootText }}>
            o8
          </div>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onClose();
            }}
            aria-label="Close menu"
            style={{
              minWidth: MOBILE_TOUCH_TARGET,
              minHeight: MOBILE_TOUCH_TARGET,
              paddingLeft: 16,
              paddingRight: 16,
              paddingTop: 0,
              paddingBottom: 0,
              borderRadius: 12,
              border: `1px solid ${palette.cardBorder}`,
              background: palette.panelBackground,
              color: palette.subduedText,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: mobileFontFamily(),
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            Done
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {navItems.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  onNavigate(item.id);
                  onClose();
                }}
                style={navButtonStyle(active)}
              >
                {item.icon}
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 15, fontWeight: active ? 700 : 500, color: active ? palette.rootText : palette.mutedText, lineHeight: 1.2 }}>
                    {item.label}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: palette.subduedText, letterSpacing: '0.005em', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.description}
                  </span>
                </span>
                {item.badge ? (
                  <span
                    style={{
                      minWidth: 20,
                      height: 20,
                      borderRadius: 999,
                      paddingLeft: 6,
                      paddingRight: 6,
                      backgroundColor: palette.danger,
                      color: '#ffffff',
                      fontSize: 10,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: palette.subduedText, paddingLeft: 12, paddingRight: 12 }}>
            <MobileStatusDot color={connectionColor} />
            <span>{selectedModelLabel}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tap');
              onOpenSettings();
              onClose();
            }}
            aria-label="Open settings"
            style={{
              width: '100%',
              minHeight: MOBILE_TOUCH_TARGET,
              borderRadius: 12,
              border: `1px solid ${palette.cardBorder}`,
              background: palette.panelElevated,
              paddingLeft: 8,
              paddingRight: 12,
              paddingTop: 6,
              paddingBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              cursor: 'pointer',
              fontFamily: mobileFontFamily(),
              color: palette.rootText,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                minWidth: 32,
                minHeight: 32,
                borderRadius: 999,
                background: palette.accentSoft,
                border: `1px solid ${palette.accentBorder}`,
                color: palette.accent,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: MOBILE_HEADING_TRACKING,
                flexShrink: 0,
              }}
            >
              {initials}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 13,
                fontWeight: 700,
                color: palette.rootText,
                letterSpacing: MOBILE_BODY_TRACKING,
                textAlign: 'left',
              }}
            >
              {hostnameLabel}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: palette.subduedText,
                letterSpacing: MOBILE_BODY_TRACKING,
                flexShrink: 0,
              }}
            >
              Settings
            </span>
          </button>
        </div>
      </div>
    </>
  );
}
