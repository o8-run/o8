import '@/app/globals.css';
import '@/app/scrollbars.css';
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

// Only retained shell webviews and the CLI broadcast page need this bootstrap.
// The root and the removed-console notices must never read operator credentials.
export default async function ShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
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
    <>
      {isWebMachine
        ? <meta name={O8_AUTH_MODE_META} content={O8_WEB_MACHINE_SURFACE} />
        : null}
      {operatorToken ? <meta name="ws-token" content={operatorToken} /> : null}
      <script dangerouslySetInnerHTML={{ __html: PRE_PAINT_THEME_STAMP }} />
      {operatorToken ? <ApiBearerBootstrap source="meta" /> : null}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.__O8_WS_PORT__ = ${JSON.stringify(wsPort)};${TAURI_SURFACE_STAMP}`,
        }}
      />
      {isBroadcast ? null : <NavigationBridge />}
      {isBroadcast ? children : <O8AuthProvider>{children}</O8AuthProvider>}
    </>
  );
}
