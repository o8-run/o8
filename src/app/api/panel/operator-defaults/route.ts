import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';
import { changesSettingsWindow, nextOwnsSettingsWindow, settingsWindowError } from '@/lib/operator/settings-window-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const unavailable = () => Response.json({ error: 'Native owner unavailable.' }, { status: 503 });
const forwardGET = ownedByNativeTransport(async request => (await import('./handler')).GET(request), unavailable);
const forwardPOST = ownedByNativeTransport(async request => (await import('./handler')).POST(request), unavailable);

export async function GET(request: Request) {
  if (nextOwnsSettingsWindow() && new URL(request.url).searchParams.get('include') === 'window-error') {
    return Response.json({ nextWindowError: await settingsWindowError() }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return forwardGET(request);
}

export async function POST(request: Request) {
  if (!nextOwnsSettingsWindow() || !await changesSettingsWindow(request)) return forwardPOST(request);
  // Keep the complete apply/save/rollback transaction in the existing window owner.
  // Reconciliation crosses to WS; runtime inventory and response projections stay there too.
  const result = await (await import('./handler')).POST(request, { acknowledgeOnly: true });
  if (!result.ok || new URL(request.url).searchParams.get('include') === 'native') return result;
  return forwardGET(new Request(request.url, { headers: request.headers, signal: request.signal }));
}
