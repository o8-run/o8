import { NextResponse } from 'next/server';
import { getRuntimeAuthSnapshot, type RuntimeAuthStatus } from '@/lib/runtimes/shared/auth-detect';
import { getRuntimeCapability, listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';

const headers = { 'Cache-Control': 'no-store, max-age=0' };

export function projectMobileAgent(
  definition: { id: string; label: string; defaultModel?: string },
  status?: Pick<RuntimeAuthStatus, 'installed' | 'authenticated' | 'nativeLoginState' | 'nativeConnection' | 'connection'>,
) {
  const connection = status?.nativeConnection ?? status?.connection;
  const signedIn = !status?.installed ? null
    : status.nativeLoginState === 'logged_in' ? true
    : status.nativeLoginState === 'logged_out' ? false
    : status.nativeLoginState === 'unknown' ? null
    : status.authenticated ? true
    : connection?.state === 'not_connected' ? false : null;
  return {
    id: definition.id,
    displayName: definition.label,
    installed: status?.installed ?? false,
    signedIn,
    defaultModel: definition.defaultModel ?? null,
  };
}

export async function listMobileAgents() {
  try {
    const snapshot = await getRuntimeAuthSnapshot();
    const agents = listDispatchableRuntimes().map(id => {
      const definition = getRuntimeCapability(id);
      const status = definition.authHouse ? snapshot.statuses[definition.authHouse] : undefined;
      return projectMobileAgent({ id, label: definition.label, defaultModel: definition.defaultModel }, status);
    });
    return NextResponse.json({ agents }, { headers });
  } catch {
    return NextResponse.json({ error: 'Agent availability unavailable' }, { status: 503, headers });
  }
}
