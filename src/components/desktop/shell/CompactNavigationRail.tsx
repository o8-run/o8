'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { AutoFlash } from 'iconoir-react';
import { CircleUser, Gauge, GitPullRequest, Play, Terminal } from '@/components/desktop/lucide-shims';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { SettingsQuickDrawer } from '@/components/desktop/SettingsQuickDrawer';
import { FloatingSurface } from '@/components/desktop/FloatingSurface';
import { RuntimeUsageSummary } from '@/components/desktop/analytics/RuntimeUsageSummary';
import { useRuntimeUsage } from '@/components/desktop/analytics/use-runtime-usage';
import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import type { NavSection } from '@/app/dashboard/types';
import { TrafficLightsOrSpacer } from './TrafficLights';
import { NAVIGATION_RAIL_WIDTH, SHELL_EDGE_INSET, SHELL_HEADER_HEIGHT } from './shell-geometry';
import { RailMoreMenu } from './RailMoreMenu';
import { RailActionButton } from './RailActionButton';
import { RailUpdateControl } from './RailUpdateControl';
import { SidebarBrand } from './SidebarBrand';
import { SymonIcon } from '../agent-panel/SidebarActionIcons';
import type { WorkspaceUtilityKind } from '../canvas/workspace-utility-navigation';
import { openCustomizeTab, useCustomizeTab } from '../customize/navigation';
import type { WorkspaceTabDragKind } from '@/lib/tiles/workspace-tab-drag';
import { trackWorkspacePaneDrag } from '@/lib/tiles/workspace-pane-drag';

const railButton: CSSProperties = {
  position: 'relative',
  width: 44,
  height: 'var(--o8-navigation-target, 44px)',
  minWidth: 44,
  minHeight: 'var(--o8-navigation-target, 44px)',
  flexShrink: 0,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--t-text)',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans-system)',
};

type RailNavAction = 'automations' | 'customize' | 'projects' | 'plugins';

function weeklyUsage(snapshot: RuntimeCapacityControlSnapshot | null, runtime: string): number | null {
  const identity = snapshot?.identities?.find(candidate => candidate.runtime === runtime && candidate.selected);
  const ratios = snapshot?.capacities.filter(capacity => capacity.runtime === runtime && capacity.status === 'available'
    && capacity.confidence === 'exact' && (!identity || capacity.identityId === identity.id))
    .flatMap(capacity => capacity.buckets.filter(bucket => bucket.label === 'Weekly')
      .flatMap(bucket => typeof bucket.usedRatio === 'number' && Number.isFinite(bucket.usedRatio) ? [bucket.usedRatio] : [])) ?? [];
  return ratios.length ? Math.max(0, Math.min(1, Math.max(...ratios))) : null;
}

export function CompactNavigationRail({
  activeDestination, glassSurface, workspacePage,
  onHome, onNewSession, onCreateTerminal, onOpenProjects, onOpenSettings, onOpenShortcuts, onOpenPRs, onOpenUsage,
}: {
  activeDestination: NavSection;
  workspacePage?: WorkspaceUtilityKind;
  glassSurface: boolean;
  onHome: () => void;
  onNewSession: () => void;
  onCreateTerminal: () => void;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenPRs: () => void;
  onOpenUsage: () => void;
}) {
  const auth = useO8Auth();
  const profileRef = useRef<HTMLButtonElement | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [customizeTab] = useCustomizeTab();
  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  useEffect(() => {
    if (!profileOpen) return;
    const updateAnchor = () => setProfileAnchor(profileRef.current?.getBoundingClientRect() ?? null);
    window.addEventListener('resize', updateAnchor);
    return () => window.removeEventListener('resize', updateAnchor);
  }, [profileOpen]);
  const isGlass = glassSurface;
  const paneDragCleanup = useRef<(() => void) | null>(null);
  const suppressPaneClick = useRef(false);
  useEffect(() => () => paneDragCleanup.current?.(), []);
  const startPaneDrag = (event: React.PointerEvent<HTMLButtonElement>, kind: WorkspaceTabDragKind) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    paneDragCleanup.current?.();
    suppressPaneClick.current = false;
    paneDragCleanup.current = trackWorkspacePaneDrag(event.currentTarget, event, kind, () => { suppressPaneClick.current = true; });
  };
  const clickPaneAction = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    const suppress = suppressPaneClick.current && event.detail !== 0;
    suppressPaneClick.current = false;
    if (!suppress) action();
  };
  const [usageOpen, setUsageOpen] = useState(false);
  const [usagePosition, setUsagePosition] = useState({ left: 0, bottom: 0 });
  const { snapshot: usageSnapshot, loading: usageLoading, error: usageError } = useRuntimeUsage(true);
  const usageCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownUsageRatios = usageSnapshot?.capacities.flatMap((capacity) =>
    capacity.status === 'available'
      ? capacity.buckets.flatMap((bucket) => typeof bucket.usedRatio === 'number' ? [bucket.usedRatio] : [])
      : [],
  ) ?? [];
  const highestKnownUsage = knownUsageRatios.length > 0 ? Math.max(...knownUsageRatios) : null;
  const weeklyMeters = [
    { runtime: 'codex', label: 'Codex', ratio: weeklyUsage(usageSnapshot, 'codex'), color: 'var(--t-accent)', bottom: 6 },
    { runtime: 'claude-code', label: 'Claude', ratio: weeklyUsage(usageSnapshot, 'claude-code'), color: 'var(--t-brand-orange)', bottom: 2 },
  ];
  const cancelUsageClose = useCallback(() => {
    if (usageCloseTimerRef.current) clearTimeout(usageCloseTimerRef.current);
    usageCloseTimerRef.current = null;
  }, []);
  const scheduleUsageClose = useCallback(() => {
    cancelUsageClose();
    usageCloseTimerRef.current = setTimeout(() => setUsageOpen(false), 160);
  }, [cancelUsageClose]);
  useEffect(() => () => cancelUsageClose(), [cancelUsageClose]);
  const showUsage = (button: HTMLButtonElement) => {
    cancelUsageClose();
    const rect = button.getBoundingClientRect();
    setUsagePosition({
      left: Math.max(12, Math.min(rect.right + 16, window.innerWidth - 300)),
      bottom: Math.max(12, window.innerHeight - rect.bottom),
    });
    setUsageOpen(true);
  };
  const openNav = (action: RailNavAction) => {
    setUsageOpen(false);
    if (action === 'projects') {
      onOpenProjects?.();
      return;
    }
    if (action === 'customize' || action === 'plugins') {
      openCustomizeTab(action === 'plugins' ? 'plugins' : undefined);
      return;
    }
    window.dispatchEvent(new CustomEvent(`o8:open-${action}`));
  };
  const openQuickSettings = (button: HTMLButtonElement) => {
    setUsageOpen(false);
    button.focus();
    setProfileAnchor(button.getBoundingClientRect());
    setProfileOpen(current => !current);
  };

  return (
    <>
    <div data-mcp-scope="navigation-window-controls" style={{ position: 'fixed', top: 0, left: 0, width: NAVIGATION_RAIL_WIDTH, height: SHELL_HEADER_HEIGHT, display: 'flex', alignItems: 'center', paddingLeft: 8, WebkitAppRegion: 'drag', zIndex: 190 } as CSSProperties}>
      <TrafficLightsOrSpacer leadInPx={6} yNudge={0} />
    </div>
    <nav
      data-mcp-scope="compact-navigation-rail"
      data-chrome-surface={isGlass ? 'true' : undefined}
      data-vibrancy-passthrough={isGlass ? 'true' : undefined}
      aria-label="Workspace navigation"
      style={{
        position: 'fixed',
        top: SHELL_HEADER_HEIGHT,
        bottom: SHELL_EDGE_INSET,
        left: 6,
        width: NAVIGATION_RAIL_WIDTH - 12,
        zIndex: 190,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 8,
        border: 0,
        borderRadius: 0,
        background: 'transparent',
        boxShadow: 'none',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <RailActionButton type="button" aria-label="Home" tooltipLabel="o8 — Home" aria-current={activeDestination === 'agents' && !workspacePage ? 'page' : undefined} onClick={onHome} style={railButton}><SidebarBrand /></RailActionButton>
      <RailActionButton type="button" aria-label="Symon" onClick={() => window.dispatchEvent(new Event('o8:symon-voice-toggle'))} style={railButton}><SymonIcon size={20} /></RailActionButton>
      <RailActionButton type="button" aria-label="Run orchestrator" onPointerDown={event => startPaneDrag(event, 'orchestrator')} onClick={event => clickPaneAction(event, onNewSession)} style={{ ...railButton, cursor: 'grab', touchAction: 'none' }}><Play size={19} strokeWidth={1.8} /></RailActionButton>
      <RailActionButton type="button" aria-label="Run terminal" onPointerDown={event => startPaneDrag(event, 'terminal')} onClick={event => clickPaneAction(event, onCreateTerminal)} style={{ ...railButton, cursor: 'grab', touchAction: 'none' }}><Terminal size={19} strokeWidth={1.8} /></RailActionButton>
      <RailActionButton type="button" aria-label="Canvas mode" onClick={() => window.location.assign('/preview/canvas-glass')} style={railButton}>
        <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="9" cy="9" r="0.5" /><circle cx="15" cy="9" r="0.5" /><circle cx="9" cy="15" r="0.5" /><circle cx="15" cy="15" r="0.5" /></svg>
      </RailActionButton>
      <div style={{ width: 27, height: 1, marginTop: 6, marginBottom: 6, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: 0, flexShrink: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
        <RailActionButton type="button" aria-label="Automations" aria-current={(workspacePage === 'automations' || activeDestination === 'automations') ? 'page' : undefined}
          onClick={() => openNav('automations')} style={{ ...railButton, flexShrink: 0, background: (workspacePage === 'automations' || activeDestination === 'automations') ? 'var(--t-hover)' : 'transparent' }}><AutoFlash width={19} height={19} strokeWidth={1.8} /></RailActionButton>
        <RailActionButton type="button" aria-label="Plugins" aria-current={(workspacePage === 'plugins' || activeDestination === 'customize' && customizeTab === 'plugins') ? 'page' : undefined}
          onClick={() => openNav('plugins')} style={{ ...railButton, flexShrink: 0, background: (workspacePage === 'plugins' || activeDestination === 'customize' && customizeTab === 'plugins') ? 'var(--t-hover)' : 'transparent' }}>
          <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3a3 3 0 1 1 0 6v3a2 2 0 0 0 2 2h3a3 3 0 1 1 6 0h3a2 2 0 0 0 2-2v-3a3 3 0 1 0 0-6V5a2 2 0 0 0-2-2h-3a3 3 0 1 0-6 0Z" /></svg>
        </RailActionButton>
        <RailMoreMenu buttonStyle={railButton} selected={activeDestination === 'projects' ? 'projects'
          : (workspacePage === 'customize' || activeDestination === 'customize' && customizeTab !== 'plugins') ? 'customize' : null}
          onProjects={() => openNav('projects')} onCustomize={() => openNav('customize')} onSettings={onOpenSettings} />
        <RailActionButton type="button" aria-label="PRs" onClick={onOpenPRs} style={{ ...railButton, flexShrink: 0 }}><GitPullRequest size={19} strokeWidth={1.8} /></RailActionButton>
      </div>
      <div style={{ width: 27, height: 1, marginTop: 6, marginBottom: 6, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <div aria-hidden="true" style={{ flex: 1, minHeight: 0 }} />
      <RailActionButton
        type="button"
        aria-label="Runtime usage"
        iconGlow={false}
        aria-describedby={usageOpen ? 'o8-rail-usage-tooltip' : undefined}
        tooltipLabel={null}
        onClick={() => { cancelUsageClose(); setUsageOpen(false); onOpenUsage(); }}
        onMouseEnter={(event) => showUsage(event.currentTarget)}
        onMouseLeave={scheduleUsageClose}
        onFocus={(event) => showUsage(event.currentTarget)}
        onBlur={scheduleUsageClose}
        onKeyDown={(event) => { if (event.key === 'Escape') setUsageOpen(false); }}
        style={{ ...railButton, flexShrink: 0, color: highestKnownUsage !== null && highestKnownUsage >= 0.8 ? 'var(--t-brand-orange)' : 'var(--t-text-muted)' }}
      >
        <Gauge size={18} strokeWidth={1.7} />
        {weeklyMeters.map(meter => <span key={meter.runtime} data-runtime-weekly-meter={meter.runtime}
          role="progressbar" aria-label={`${meter.label} weekly usage`} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={meter.ratio === null ? undefined : Math.round(meter.ratio * 100)}
          aria-valuetext={meter.ratio === null ? 'Not reported' : `${Math.round(meter.ratio * 100)}% used`}
          style={{ position: 'absolute', bottom: meter.bottom, left: 16, width: 12, height: 2, borderRadius: 2, background: 'var(--t-divider-subtle)', overflow: 'hidden' }}>
          {meter.ratio !== null ? <span style={{ display: 'block', width: `${meter.ratio * 100}%`, height: '100%', background: meter.color }} /> : null}
        </span>)}
      </RailActionButton>
      {usageOpen && typeof document !== 'undefined' ? createPortal(
        <FloatingSurface
          id="o8-rail-usage-tooltip"
          role="tooltip"
          data-mcp-scope="rail-usage-preview"
          glass={isGlass}
          contentStyle={{ maxHeight: 'min(360px, calc(100vh - 24px))', overflowY: 'auto', scrollbarWidth: 'none' }}
          onMouseEnter={cancelUsageClose}
          onMouseLeave={scheduleUsageClose}
          style={{
            position: 'fixed',
            left: usagePosition.left,
            bottom: usagePosition.bottom,
            width: 284,
            maxHeight: 'min(360px, calc(100vh - 24px))',
            zIndex: 210,
          } as CSSProperties}
        >
            <div style={{ paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 400 }}>Runtime usage</span>
                <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{usageLoading ? 'Updating…' : usageSnapshot ? 'Connected accounts' : 'Loading…'}</span>
              </div>
              <RuntimeUsageSummary snapshot={usageSnapshot} compact />
              <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>Click the meter to open Usage</span>
              {!usageSnapshot && usageLoading ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>Reading connected runtimes…</span> : null}
              {usageError ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>{usageError}</span> : null}
            </div>
        </FloatingSurface>,
        document.body,
      ) : null}
      <RailUpdateControl buttonStyle={railButton} />
      <RailActionButton
        ref={profileRef}
        id="o8-profile-menu-button"
        type="button"
        aria-label="Open quick settings"
        aria-haspopup="dialog"
        aria-expanded={profileOpen}
        aria-controls={profileOpen ? 'o8-rail-quick-settings' : undefined}
        tooltipLabel="Account and settings"
        onClick={event => openQuickSettings(event.currentTarget)}
        style={{ ...railButton, flexShrink: 0, color: auth.signedIn ? 'var(--t-text)' : 'var(--t-text-muted)' }}
      >{auth.signedIn && auth.user?.avatarUrl ? <Image src={auth.user.avatarUrl} alt="" width={27} height={27} unoptimized style={{ width: 27, height: 27, borderRadius: '50%', objectFit: 'cover' }} /> : <CircleUser size={22} strokeWidth={1.7} />}</RailActionButton>
    </nav>
    <SettingsQuickDrawer
      id="o8-rail-quick-settings"
      open={profileOpen}
      anchorRect={profileAnchor}
      onClose={closeProfile}
      onOpenSettings={() => { closeProfile(); onOpenSettings(); }}
      onOpenShortcuts={onOpenShortcuts}
    />
    </>
  );
}
