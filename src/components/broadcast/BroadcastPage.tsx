'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import type { BroadcastEvent, BroadcastSnapshot } from '@/lib/broadcast/types';
import { getPalette, resolveTheme, type PaletteId } from '@/lib/theme/registry';

import {
  BroadcastSidebar,
  type BroadcastConnectionState,
  EventFeed,
  isBroadcastFeedActive,
  StatusDot,
} from './BroadcastStage';
import { TruthPanel } from './TruthPanel';

const TOKEN_STORAGE_KEY = 'o8.broadcast.spectator-token';
const SNAPSHOT_REFRESH_MS = 10_000;
const FEED_LIMIT = 250;

function readFragmentToken(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token')?.trim() ?? '';
}

function readStoredToken(): string {
  try {
    // localStorage is the live store; sessionStorage is read for overlays that
    // were bootstrapped by an older build and are still on air.
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY)
      ?? window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    return stored?.trim() ?? '';
  } catch {
    return '';
  }
}

function rememberToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // A storage-denied browser source still runs off the fragment, so a failed
    // write must never block the boot.
  }
}

function readBootstrapToken(): string {
  // The fragment is the DURABLE carrier and is never stripped. A stream overlay
  // outlives its own document: an OBS browser source gets recreated, scenes
  // reset, the machine reboots. Stripping the fragment on first read made the
  // credential single-use — once the store cleared, the card was permanently
  // tokenless with no recovery but re-pasting the URL, mid-stream. Keeping the
  // fragment means every reload re-bootstraps from the URL the operator
  // configured once; storage only covers a load that arrives without one.
  const incoming = readFragmentToken();
  if (incoming) {
    rememberToken(incoming);
    return incoming;
  }
  return readStoredToken();
}

function mergeEvents(current: BroadcastEvent[], incoming: BroadcastEvent[]): BroadcastEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
    .slice(-FEED_LIMIT);
}

function readBroadcastPalette(): PaletteId {
  const params = new URLSearchParams(window.location.search);
  if (params.has('theme')) return params.get('theme') === 'dark' ? 'dark' : 'light';
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function BroadcastSurface() {
  const [token, setToken] = useState('');
  const [snapshot, setSnapshot] = useState<BroadcastSnapshot | null>(null);
  const [events, setEvents] = useState<BroadcastEvent[]>([]);
  const [state, setState] = useState<BroadcastConnectionState>('booting');
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const [isWide, setIsWide] = useState(false);
  const [compact, setCompact] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reconnectPulse, setReconnectPulse] = useState(0);
  const [paletteId, setPaletteId] = useState<PaletteId>('light');
  const cursorRef = useRef<string | null>(null);
  const wasOfflineRef = useRef(false);
  const reduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    let applied: string | null = null;
    const applyToken = () => {
      const nextToken = readBootstrapToken();
      // Re-navigating a live overlay to its full URL only changes the fragment,
      // so nothing remounts and the resolved token is usually unchanged —
      // reconnecting on every hashchange would flap a healthy feed.
      if (applied === nextToken) return;
      applied = nextToken;
      // Bootstrap runs on mount, not on a paint callback: an overlay in a hidden
      // OBS scene never paints and must still connect.
      setToken(nextToken);
      setState(nextToken ? 'booting' : 'missing-token');
    };
    applyToken();
    // Pasting the overlay URL back into a live browser source is a SAME-DOCUMENT
    // navigation: no reload, no remount, no mount effect. Without this listener a
    // tokenless card can never recover in place.
    window.addEventListener('hashchange', applyToken);
    return () => window.removeEventListener('hashchange', applyToken);
  }, []);

  useEffect(() => {
    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const updatePalette = () => setPaletteId(readBroadcastPalette());
    updatePalette();
    window.addEventListener('popstate', updatePalette);
    media?.addEventListener?.('change', updatePalette);
    return () => {
      window.removeEventListener('popstate', updatePalette);
      media?.removeEventListener?.('change', updatePalette);
    };
  }, []);

  useEffect(() => {
    const updateVisibility = () => setIsDocumentVisible(document.visibilityState === 'visible');
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    const updateLayout = () => {
      setIsWide(window.innerWidth >= 1_600);
      setCompact(new URLSearchParams(window.location.search).get('compact') === '1');
    };
    updateLayout();
    window.addEventListener('resize', updateLayout);
    window.addEventListener('popstate', updateLayout);
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('popstate', updateLayout);
    };
  }, []);

  useEffect(() => {
    if (!isDocumentVisible) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isDocumentVisible]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let stopped = false;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const markLive = () => {
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        setReconnectPulse((current) => current + 1);
      }
      setState('live');
    };

    const markOffline = () => {
      wasOfflineRef.current = true;
      setState('offline');
    };

    const request = async <T,>(route: string): Promise<T> => {
      const response = await fetch(route, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new Error('forbidden');
      if (!response.ok) throw new Error(`Broadcast request failed with ${response.status}.`);
      return response.json() as Promise<T>;
    };

    const refreshSnapshot = async (initialize: boolean) => {
      const next = await request<BroadcastSnapshot>('/api/broadcast/snapshot?events=40');
      if (stopped) return;
      setSnapshot(next);
      if (initialize) {
        setEvents(next.recentEvents);
        cursorRef.current = next.cursor;
      }
      markLive();
    };

    const poll = async () => {
      while (!stopped) {
        try {
          const params = new URLSearchParams({ wait: '25000', limit: '50' });
          if (cursorRef.current) params.set('cursor', cursorRef.current);
          const page = await request<{
            events: BroadcastEvent[];
            cursor: string | null;
          }>(`/api/broadcast/events?${params.toString()}`);
          if (stopped) return;
          cursorRef.current = page.cursor;
          if (page.events.length) setEvents((current) => mergeEvents(current, page.events));
          markLive();
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          if (error instanceof Error && error.message === 'forbidden') {
            setState('forbidden');
            return;
          }
          markOffline();
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };

    const connect = async () => {
      while (!stopped) {
        try {
          await refreshSnapshot(true);
          if (stopped) return;
          // A hidden page (background tab, inactive OBS scene) still paints the
          // latest snapshot once; the long-poll and refresh loop only run while
          // visible, and the effect re-runs on the next visibilitychange.
          if (!isDocumentVisible) return;
          refreshTimer = setInterval(() => {
            void refreshSnapshot(false).catch((error) => {
              if (stopped) return;
              if (error instanceof Error && error.message === 'forbidden') setState('forbidden');
              else markOffline();
            });
          }, SNAPSHOT_REFRESH_MS);
          void poll();
          return;
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          if (error instanceof Error && error.message === 'forbidden') {
            setState('forbidden');
            return;
          }
          markOffline();
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, [isDocumentVisible, token]);

  const statusCopy = state === 'live'
    ? 'LIVE'
    : state === 'booting' ? 'CONNECTING'
        : state === 'missing-token' ? 'TOKEN REQUIRED'
          : state === 'forbidden' ? 'ACCESS REVOKED' : 'RECONNECTING';
  const feedActive = state === 'live' && isBroadcastFeedActive(events, snapshot?.lanes ?? [], nowMs);
  const resolvedTheme = useMemo(
    () => resolveTheme(getPalette(paletteId), 'solid'),
    [paletteId],
  );

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousVars = Object.keys(resolvedTheme.cssVars).map((name) => ({
      name,
      value: root.style.getPropertyValue(name),
      priority: root.style.getPropertyPriority(name),
    }));
    const previous = {
      colorScheme: root.style.colorScheme,
      theme: root.dataset.theme,
      palette: root.dataset.palette,
      surface: root.dataset.surface,
      bodyBackground: body.style.background,
    };
    for (const [name, value] of Object.entries(resolvedTheme.cssVars)) {
      root.style.setProperty(name, value);
    }
    root.style.colorScheme = resolvedTheme.colorScheme;
    root.dataset.theme = resolvedTheme.paletteId;
    root.dataset.palette = resolvedTheme.paletteId;
    root.dataset.surface = resolvedTheme.surface;
    body.style.background = 'var(--t-bg-gradient)';
    return () => {
      for (const variable of previousVars) {
        if (variable.value) root.style.setProperty(variable.name, variable.value, variable.priority);
        else root.style.removeProperty(variable.name);
      }
      root.style.colorScheme = previous.colorScheme;
      if (previous.theme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous.theme;
      if (previous.palette === undefined) delete root.dataset.palette;
      else root.dataset.palette = previous.palette;
      if (previous.surface === undefined) delete root.dataset.surface;
      else root.dataset.surface = previous.surface;
      body.style.background = previous.bodyBackground;
    };
  }, [resolvedTheme]);

  const surfaceStyle: CSSProperties = {
    ...resolvedTheme.cssVars,
    boxSizing: 'border-box',
    width: '100%',
    minHeight: '100dvh',
    overflowX: 'hidden',
    background: 'var(--t-bg-gradient)',
    color: 'var(--t-text)',
    fontFamily: 'var(--font-sans-system)',
    fontSize: 18,
    paddingTop: compact ? 18 : 28,
    paddingRight: 28,
    paddingBottom: 48,
    paddingLeft: 28,
  };

  return (
    <main
      data-broadcast-theme={paletteId}
      style={surfaceStyle}
    >
      <div style={{ width: '100%', maxWidth: 1880, minWidth: 0, marginRight: 'auto', marginLeft: 'auto' }}>
        {compact ? null : <header
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            minWidth: 0,
            marginBottom: 16,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h1
              style={{
                marginTop: 0,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
                color: 'var(--t-text-strong)',
                fontSize: 28,
                fontWeight: 400,
                letterSpacing: '-0.2px',
                lineHeight: 1.25,
              }}
            >
              Broadcast
            </h1>
            <p
              style={{
                marginTop: 4,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
                color: 'var(--t-text-muted)',
                fontSize: 18,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                lineHeight: 1.35,
              }}
            >
              Live governed activity from the o8 ledger
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
            <motion.span
              key={reconnectPulse}
              data-broadcast-feed-state={state === 'live' ? feedActive ? 'active' : 'idle' : 'connection'}
              initial={false}
              animate={feedActive && !reduceMotion
                ? { opacity: [1, 0.52, 1], scale: [1, 1.035, 1] }
                : { opacity: state === 'live' ? 0.58 : 1, scale: 1 }}
              transition={feedActive && !reduceMotion
                ? { duration: 2.35, repeat: Infinity, ease: 'easeInOut' }
                : { duration: reduceMotion ? 0 : 0.2 }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                paddingTop: 7,
                paddingRight: 11,
                paddingBottom: 7,
                paddingLeft: 11,
                borderRadius: 14,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: feedActive ? 'var(--t-accent-border)' : 'var(--t-divider-subtle)',
                background: feedActive ? 'var(--t-accent-soft-strong)' : 'var(--t-input-bg)',
                color: feedActive ? 'var(--t-accent)' : 'var(--t-text-faint)',
                boxShadow: feedActive ? '0 0 18px var(--t-accent-ring)' : 'none',
                fontSize: 13,
                fontWeight: 300,
                letterSpacing: '0.04em',
                lineHeight: '18px',
              }}
            >
              <StatusDot filled={state === 'live'} />
              {statusCopy}
            </motion.span>
          </div>
        </header>
        }

        <div
          aria-label="Broadcast stage"
          style={{
            display: isWide ? 'grid' : 'flex',
            flexDirection: isWide ? undefined : 'column',
            gridTemplateColumns: isWide ? 'minmax(0, 3fr) minmax(0, 2fr)' : undefined,
            gridTemplateAreas: isWide ? "'stream sidebar'" : undefined,
            gap: isWide ? 24 : 16,
            minWidth: 0,
            minHeight: isWide ? 640 : undefined,
            height: isWide ? compact ? 'calc(100dvh - 36px)' : 'calc(100dvh - 140px)' : undefined,
            overflow: isWide ? 'hidden' : undefined,
          }}
        >
          <BroadcastSidebar snapshot={snapshot} events={events} nowMs={nowMs} reduceMotion={reduceMotion} isWide={isWide} />
          <EventFeed
            events={events}
            lanes={snapshot?.lanes ?? []}
            state={state}
            nowMs={nowMs}
            reduceMotion={reduceMotion}
          />
        </div>
        {compact ? null : <TruthPanel token={token} />}
      </div>
    </main>
  );
}

export default function BroadcastPage() {
  return <BroadcastSurface />;
}
