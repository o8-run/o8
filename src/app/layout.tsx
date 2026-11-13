import './globals.css';
import './scrollbars.css';
import type { Metadata, Viewport } from 'next';
import { resolvePortInfo } from '@/lib/panel/api-port';
import NavigationBridge from '@/components/NavigationBridge';
import { O8AuthProvider } from '@/components/auth/O8AuthProvider';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';
import { PRE_PAINT_THEME_STAMP } from '@/lib/theme/pre-paint-stamp';
import { headers } from 'next/headers';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import {
  headersIndicateWebMachineRelay,
  O8_AUTH_MODE_META,
  O8_WEB_MACHINE_SURFACE,
} from '@/lib/connect/web-machine-surface';
import { O8_BROADCAST_SURFACE_HEADER } from '@/lib/broadcast/surface';
import { TAURI_SURFACE_STAMP } from '@/lib/tauri/surface-stamp';

export const metadata: Metadata = {
  title: 'o8',
  description: "Your agents write the code. o8 reviews it, sends it back until it's right, and merges it.",
  other: {
    'theme-color': '#1C1C1E',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const mobileBuildRevision = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.GIT_COMMIT_SHA
    ?? 'dev';

  // Resolve the ws-server port on the server so we can inject it into the
  // page before any client code runs. This lets browser hooks read
  // window.__O8_WS_PORT__ instead of hardcoding 3002. See
  // src/lib/panel/ws-port-client.ts for the reader.
  const { wsPort } = resolvePortInfo();
  const requestHeaders = await headers();
  const isBroadcast = requestHeaders.get(O8_BROADCAST_SURFACE_HEADER) === '1';
  const isWebMachine = headersIndicateWebMachineRelay((name) => requestHeaders.get(name));
  const isLocal = !isWebMachine
    && headersIndicateLoopback((name) => requestHeaders.get(name));
  const operatorToken = isLocal && !isBroadcast ? getOrCreateWsToken() : '';

  return (
    <html lang="en" style={{ background: '#1C1C1E' }} suppressHydrationWarning>
      <head>
        {isWebMachine
          ? <meta name={O8_AUTH_MODE_META} content={O8_WEB_MACHINE_SURFACE} />
          : null}
        {operatorToken ? <meta name="ws-token" content={operatorToken} /> : null}
        {/* Pre-paint theme stamp — see @/lib/theme/pre-paint-stamp (it mirrors
            ThemeProvider's resolution and is tested against the same cases). */}
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT_THEME_STAMP }} />
      </head>
      <body style={{ background: '#1C1C1E', margin: 0, fontFamily: 'var(--font-sans-system)' }} suppressHydrationWarning>
        {operatorToken ? <ApiBearerBootstrap source="meta" /> : null}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__O8_WS_PORT__ = ${JSON.stringify(wsPort)};${TAURI_SURFACE_STAMP}`,
          }}
        />
        {isBroadcast ? null : <NavigationBridge />}
        {/* UpdateBanner removed — the inline UpdateCard renders inside
            AgentPanel above the chrome icons (o8/AgentPanel.tsx).
            That stops it from covering the workspace tab strip + reconnect
            banner when an update lands. */}
        {isBroadcast ? children : <O8AuthProvider>{children}</O8AuthProvider>}
        {isBroadcast ? null : <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator && !window.__TAURI_INTERNALS__) {
                window.addEventListener('load', function() {
                  var buildRevision = ${JSON.stringify(mobileBuildRevision)};
                  var reloadMarker = 'cortex.mobile.asset-reset:' + buildRevision;
                  var buildMarker = 'cortex.mobile.build-revision';

                  Promise.all([
                    navigator.serviceWorker.getRegistrations()
                      .then(function(registrations) {
                        // Preserve sw-push.js — it's the push notification SW
                        // (issue #639) and isn't part of the asset-cache reset.
                        var doomed = registrations.filter(function(registration) {
                          var url = registration.active && registration.active.scriptURL || '';
                          return url.indexOf('sw-push.js') === -1;
                        });
                        return Promise.all(doomed.map(function(registration) {
                          return registration.unregister();
                        })).then(function(results) {
                          return results.some(Boolean);
                        });
                      })
                      .catch(function() { return false; }),
                    'caches' in window
                      ? caches.keys()
                        .then(function(keys) {
                          var targetKeys = keys.filter(function(key) { return key.indexOf('cortex-ide-') === 0; });
                          return Promise.all(targetKeys.map(function(key) { return caches.delete(key); }))
                            .then(function(results) { return targetKeys.length > 0 && results.some(Boolean); });
                        })
                        .catch(function() { return false; })
                      : Promise.resolve(false),
                  ]).then(function(results) {
                    var hadServiceWorkers = results[0];
                    var hadCaches = results[1];
                    var previousBuild = null;

                    try {
                      previousBuild = window.localStorage.getItem(buildMarker);
                      window.localStorage.setItem(buildMarker, buildRevision);
                    } catch (error) {}

                    var buildChanged = Boolean(previousBuild && previousBuild !== buildRevision);
                    var shouldReload = !window.sessionStorage.getItem(reloadMarker) && (hadServiceWorkers || hadCaches || buildChanged);
                    console.info('[mobile] asset cleanup', {
                      buildRevision: buildRevision,
                      previousBuild: previousBuild,
                      hadServiceWorkers: hadServiceWorkers,
                      hadCaches: hadCaches,
                      buildChanged: buildChanged,
                      shouldReload: shouldReload,
                    });

                    if (!shouldReload) return;
                    window.sessionStorage.setItem(reloadMarker, '1');
                    var url = new URL(window.location.href);
                    url.searchParams.set('_mobileReload', buildRevision);
                    window.location.replace(url.toString());
                  });
                });
              }
            `,
          }}
        />}
      </body>
    </html>
  );
}
