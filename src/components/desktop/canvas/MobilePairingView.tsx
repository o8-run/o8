'use client';

/**
 * MobilePairingView — full-screen QR pairing surface, rendered as a Canvas tab.
 *
 * The native o8 mobile app (hurttlocker/o8-mobile) can't inherit the backend
 * address, so desktop emits a QR. This view fetches GET /api/panel/mobile-pairing
 * and renders a QR encoding `JSON.stringify({ host, apiPort, wsPort, token })` —
 * exactly the shape o8-mobile's scanner (src/app/pair-scan.tsx) parses.
 *
 * Opened by the phone-icon button in DesktopStatusBar. The token is encoded in
 * the QR (that's the point of pairing) but never printed on screen.
 *
 * Browser pairing: the mobile PWA no longer receives the ws-token in its HTML
 * for LAN page loads (that handed the master credential to any LAN browser).
 * Instead this view offers a copyable `http://host:port/mobile#tk=<token>`
 * link — the fragment never hits the wire; the PWA captures it into
 * localStorage on first load (see @/lib/mobile/ws-token-client).
 */

import { useCallback, useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';
import { Smartphone } from '../lucide-shims';
import { OPEN_SETTINGS_TAB_EVENT, type OpenSettingsTabDetail } from '@/lib/desktop/events';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { IPHONE_APP_INSTALL_URL } from './mobile-app-link';

// o8's local servers bind 127.0.0.1 by default, so a phone can't reach them
// directly until the operator opts in (src/lib/panel/listen-host.ts).
export const LAN_ACCESS_OFF_MESSAGE =
  'Phone pairing needs local network access, which is off by default: o8 only listens on 127.0.0.1. '
  + 'Quit o8, relaunch it with O8_LAN_ACCESS=1 in its environment, then retry.';

const APP_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"iA Writer Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

interface PairingPayload {
  /** Protocol version — the phone reads it to pick the enroll vs legacy path. */
  v?: number;
  host: string | null;
  hosts?: string[];
  apiPort: number;
  wsPort: number;
  /** false when o8's servers are loopback-only (O8_LAN_ACCESS not set). */
  lanAccess?: boolean;
  token: string;
  /** Single-use enroll code (E2EE mode only) — POSTed to /api/mobile/enroll. */
  enroll?: string;
  /** base64 server Ed25519 identity pub (E2EE mode only) — the phone pins it. */
  sIdent?: string;
  error?: string;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; host: string; hosts: string[]; apiPort: number; wsPort: number; token: string; qrDataUrl: string }
  | { status: 'error'; message: string };

export function MobilePairingView() {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/panel/mobile-pairing');
        const data = (await res.json().catch(() => null)) as PairingPayload | null;
        if (!res.ok || !data) {
          throw new Error(data?.error || `Pairing endpoint returned ${res.status}`);
        }
        if (data.lanAccess === false) {
          if (!cancelled) {
            setState({
              status: 'error',
              message: LAN_ACCESS_OFF_MESSAGE,
            });
          }
          return;
        }
        if (!data.host) {
          if (!cancelled) {
            setState({
              status: 'error',
              message: 'No local network address found. Connect this Mac to Wi-Fi, then retry.',
            });
          }
          return;
        }
        // The payload shape is the contract with o8-mobile's QR scanner
        // (src/app/pair-scan.tsx): { host, apiPort, wsPort, token } plus
        // `hosts` — every address the phone might reach this Mac at
        // (Tailscale + LAN, preference order). The phone probes them on scan
        // and pairs with the first that answers; an old app ignores `hosts`.
        const hosts = Array.isArray(data.hosts) && data.hosts.length > 0
          ? data.hosts
          : [data.host];
        // Preserve the E2EE handshake fields (v / enroll / sIdent) the pairing
        // API emits — a new o8-mobile app reads `v`, POSTs `enroll` to
        // /api/mobile/enroll for a per-device token, and pins `sIdent`. Dropping
        // them forced the phone onto the legacy shared-token path, so managed
        // relay (which needs the enrolled per-device credential) never worked.
        // enroll/sIdent are present only in E2EE mode; spread them conditionally
        // so the legacy payload is unchanged when E2EE is off.
        const qrPayload = JSON.stringify({
          v: data.v,
          host: data.host,
          hosts,
          apiPort: data.apiPort,
          wsPort: data.wsPort,
          token: data.token,
          ...(data.enroll ? { enroll: data.enroll } : {}),
          ...(data.sIdent ? { sIdent: data.sIdent } : {}),
        });
        const qrDataUrl = await toDataURL(qrPayload, {
          width: 480,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#0c0c0c', light: '#ffffff' },
        });
        if (!cancelled) {
          setState({
            status: 'ready',
            host: data.host,
            hosts,
            apiPort: data.apiPort,
            wsPort: data.wsPort,
            token: data.token,
            qrDataUrl,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Could not build a pairing code.',
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // The enroll code baked into the QR is single-use with a 5-min TTL (desktop
  // device-registry). Silently re-mint the QR every 4 min so a scan never hits
  // an expired code — the #1 cause of "enroll failed: 403" when this screen sits
  // open. The re-fetch runs in the background; the visible QR only swaps once
  // the fresh one is ready, so there's no spinner flash.
  useEffect(() => {
    const id = setInterval(() => setReloadKey((k) => k + 1), 4 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadKey((k) => k + 1);
  }, []);

  const copyBrowserLink = useCallback(() => {
    if (state.status !== 'ready') return;
    // The token rides in the URL fragment — never sent to the server, captured
    // into localStorage by the PWA on first load, then scrubbed from the URL.
    const link = `http://${state.host}:${state.apiPort}/mobile#tk=${encodeURIComponent(state.token)}`;
    void navigator.clipboard?.writeText(link).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2200);
    });
  }, [state]);

  const openConnections = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent<OpenSettingsTabDetail>(OPEN_SETTINGS_TAB_EVENT, {
        detail: { tab: 'connections' },
      }),
    );
  }, []);

  const subtitle = state.status === 'loading'
    ? 'Preparing a one-time pairing code…'
    : state.status === 'error'
      ? 'Pairing is unavailable right now.'
      : 'Open o8 on your phone and scan this code. Your phone needs to reach this Mac — same Wi-Fi network, or Tailscale when you’re away.';

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        background: 'var(--t-canvas-bg)',
        color: 'var(--t-text)',
        fontFamily: APP_FONT,
      }}
    >
      <div
        style={{
          margin: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 8,
          paddingTop: 48,
          paddingBottom: 48,
          paddingLeft: 32,
          paddingRight: 32,
          maxWidth: 420,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--t-bg-card)',
            border: '1px solid var(--t-divider-subtle)',
            color: 'var(--t-text-secondary)',
            marginBottom: 6,
          }}
        >
          <Smartphone size={20} />
        </div>

        <h2
          style={{
            margin: 0,
            // Hurttlocker display title — light 200 weight at 22 px reads
            // as editorial, matches the orchestrator empty-state title.
            fontSize: 22,
            fontWeight: 200,
            letterSpacing: '-0.02em',
            color: 'var(--t-text)',
          }}
        >
          Pair your phone
        </h2>

        <p
          style={{
            margin: 0,
            // Hurttlocker row body — 13.5/300/-0.1.
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.5,
            color: 'var(--t-text-secondary)',
            maxWidth: 340,
          }}
        >
          {subtitle}
        </p>

        {state.status === 'loading' ? (
          <div
            style={{
              width: 276,
              height: 276,
              marginTop: 18,
              borderRadius: 20,
              border: '1px dashed var(--t-divider)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--t-text-muted)',
              fontSize: 12.5,
            }}
          >
            Generating…
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--t-text-secondary)',
                maxWidth: 320,
              }}
            >
              {state.message}
            </p>
            <button
              type="button"
              onClick={retry}
              style={{
                minHeight: 36,
                paddingLeft: 18,
                paddingRight: 18,
                borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text)',
                fontFamily: APP_FONT,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <div
              style={{
                marginTop: 18,
                padding: 18,
                borderRadius: 20,
                background: '#ffffff',
                boxShadow: '0 8px 28px rgba(12, 12, 12, 0.18)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, no Next loader */}
              <img
                src={state.qrDataUrl}
                alt="o8 mobile pairing QR code"
                width={240}
                height={240}
                style={{ display: 'block', borderRadius: 8 }}
              />
            </div>

            <div
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: MONO_FONT,
                fontSize: 11.5,
                letterSpacing: '0.02em',
                color: 'var(--t-text-muted)',
              }}
            >
              <span style={{ color: 'var(--t-text-secondary)', fontWeight: 600 }}>{state.hosts.join(' / ')}</span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>API {state.apiPort}</span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>WS {state.wsPort}</span>
            </div>

            {/*
              An operator looking at this QR with no app on their phone has
              nowhere to go, so the offer belongs here rather than in a menu.
              The href stays real (readable, copyable), but the click goes
              through the shell helper: following it inside the webview would
              strand the operator on a store page with no way back to the QR,
              and window.open is a no-op in Tauri anyway.
            */}
            <a
              href={IPHONE_APP_INSTALL_URL}
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                openExternalUrl(IPHONE_APP_INSTALL_URL);
              }}
              style={{
                marginTop: 14,
                color: 'var(--t-text-secondary)',
                fontFamily: APP_FONT,
                fontSize: 12.5,
                fontWeight: 600,
                textDecoration: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
            >
              Get the iPhone app
            </a>
            <p
              style={{
                margin: 0,
                marginTop: 4,
                fontSize: 11.5,
                fontWeight: 300,
                lineHeight: 1.5,
                color: 'var(--t-text-muted)',
                maxWidth: 320,
              }}
            >
              Install TestFlight, join the beta, then scan this code.
            </p>

            <button
              type="button"
              onClick={copyBrowserLink}
              style={{
                marginTop: 14,
                minHeight: 36,
                paddingLeft: 18,
                paddingRight: 18,
                borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text)',
                fontFamily: APP_FONT,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {linkCopied ? 'Link copied' : 'Copy browser pairing link'}
            </button>
            <p
              style={{
                margin: 0,
                marginTop: 4,
                fontSize: 11.5,
                fontWeight: 300,
                lineHeight: 1.5,
                color: 'var(--t-text-muted)',
                maxWidth: 320,
              }}
            >
              Using the web app instead? Send this link to your phone and open
              it once — it pairs the browser the same way the QR pairs the app.
            </p>
          </>
        ) : null}

        <button
          type="button"
          onClick={openConnections}
          style={{
            marginTop: 22,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            fontFamily: APP_FONT,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
        >
          Manage connections
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
