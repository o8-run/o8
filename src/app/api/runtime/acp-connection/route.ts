import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readLocalAcpConnection, saveLocalAcpConnection } from '@/lib/acp/local-connection';
import { acpEnvironmentId, AcpEnvironmentConflict, readAcpEnvironment, saveAcpEnvironment } from '@/lib/acp/connection-environment';
import { withProviderStoreLock } from '@/lib/providers/store-lock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (request.nextUrl.searchParams.get('environment') === '1') {
    const connection = readLocalAcpConnection();
    if (!connection || process.env.O8_ACP_COMMAND?.trim()) return NextResponse.json({ error: 'Save a Local ACP connection without an environment override first.' }, { status: 409 });
    try { return NextResponse.json(readAcpEnvironment(acpEnvironmentId(connection))); }
    catch { return NextResponse.json({ error: 'Could not read the connection environment. Retry the read.' }, { status: 503 }); }
  }
  return NextResponse.json({ connection: readLocalAcpConnection(), envLocked: Boolean(process.env.O8_ACP_COMMAND?.trim()) });
}
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (process.env.O8_ACP_COMMAND?.trim()) return NextResponse.json({ error: 'The ACP command is controlled by your environment.' }, { status: 409 });
  try {
    const body = await request.json();
    if (Object.hasOwn(body, 'environment')) {
      return withProviderStoreLock(() => {
        const connection = readLocalAcpConnection();
        if (!connection || body.environment?.connectionId !== acpEnvironmentId(connection)) {
          return NextResponse.json({ error: 'The selected connection changed. Reload its environment before saving.' }, { status: 409 });
        }
        return NextResponse.json(saveAcpEnvironment(body.environment, body.environment.variables));
      });
    }
    if (!Object.hasOwn(body, 'connection')) return NextResponse.json({ error: 'connection is required' }, { status: 400 });
    return NextResponse.json({ connection: saveLocalAcpConnection(body.connection) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save ACP connection.' }, { status: error instanceof AcpEnvironmentConflict ? 409 : 400 });
  }
}
