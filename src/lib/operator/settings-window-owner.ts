import { getApiBase, getWsBase } from '@/lib/panel/api-port';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';

export const SETTINGS_WINDOW_OWNER_HOP = 'x-o8-settings-window-owner-hop';

/** Matches startup ownership, including the legacy default while Next is running. */
export function nextOwnsSettingsWindow(): boolean {
  return process.env.O8_NEXT_O8D === '1' && process.env.O8_NEXT_WINDOW_OWNER !== 'ws';
}

export async function changesSettingsWindow(request: Request): Promise<boolean> {
  const query = new URL(request.url).searchParams;
  if (query.get('include') === 'native' && query.has('scope') && query.get('scope') !== 'global') return false;
  const body = await request.clone().json().catch(() => null);
  return body !== null && typeof body === 'object' && (body.experimentalNext !== undefined || body.settingsToml !== undefined);
}

/** Bypass native API routing only for the process that startup names as the window owner. */
export async function forwardToSettingsWindowOwner(request: Request): Promise<Response> {
  try {
    const origin = new URL(process.env.NEXT_ORIGIN ?? getApiBase());
    if (origin.origin === new URL(getWsBase().replace(/^ws:/, 'http:')).origin) throw new Error('Window owner unavailable');
    const source = new URL(request.url);
    const headers = new Headers({ 'x-o8-relay-forward': '1', [SETTINGS_WINDOW_OWNER_HOP]: '1' });
    for (const key of ['authorization', 'content-type', 'x-clerk-session-token']) {
      const value = request.headers.get(key); if (value !== null) headers.set(key, value);
    }
    const result = await fetch(new URL(source.pathname + source.search, origin), {
      method: request.method, headers, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}),
    });
    const forwarded = new Headers(result.headers);
    if (forwarded.has('content-encoding')) forwarded.delete('content-length');
    for (const key of ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding']) forwarded.delete(key);
    return new Response(result.body, { status: result.status, headers: forwarded });
  } catch {
    return Response.json({ error: 'Window owner unavailable.' }, { status: 503 });
  }
}

export async function settingsWindowError(): Promise<string | null> {
  if (nextOwnsSettingsWindow() && isNativeCortexReader()) {
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const result = await forwardToSettingsWindowOwner(new Request('http://window-owner.invalid/api/panel/operator-defaults?include=window-error', {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    if (!result.ok) throw new Error('Window owner unavailable');
    const body = await result.json();
    if (body.nextWindowError !== null && typeof body.nextWindowError !== 'string') throw new Error('Window owner unavailable');
    return body.nextWindowError;
  }
  return (await import('@/lib/next/app-window')).nextWindowError();
}
